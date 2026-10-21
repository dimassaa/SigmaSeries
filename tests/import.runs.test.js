// Ручные запуски импорта (S-76, F-12-08).
//
// Кнопка на экране импорта не выполняет прогон: она заводит строку, а
// выполняет её планировщик. Проверяется и то, и другое — заведённая строка и
// то, что планировщик её подхватывает.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createImportStore } from '../src/services/import/store.js';
import { planManualRun } from '../src/services/import/runs.js';
import { createScheduler } from '../src/services/import/scheduler.js';
import { acquireImportLock } from './helpers/import-lock.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — ручные запуски не проверялись';

let pool;
/** Отпускается в `after`: держит общую блокировку строк запуска. */
let unlockImport;
const runs = [];

test.before(async () => {
  if (!available) return;
  pool = createPool();
  unlockImport = await acquireImportLock(pool);
});

// Планированный полный прогон заводит только кнопка, поэтому чистить можно
// без оглядки на приложение: предыдущая проверка не должна мешать следующей.
test.beforeEach(async () => {
  if (!available) return;
  await pool.query("DELETE FROM e_import_run WHERE kind = 'full_run' AND status = 'planned'");
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_import_item_result WHERE run_id = ANY($1::bigint[])', [runs]);
  await pool.query('DELETE FROM e_import_run WHERE id = ANY($1::bigint[])', [runs]);
  // Ночные планы тест создаёт сам: без этого он бы задел план приложения.
  await pool.query("DELETE FROM e_import_run WHERE kind IN ('schedule_sync','discover_sync','ratings_sync')");
  await unlockImport?.();
  await pool.end();
});

/** Строка запуска по номеру. */
const runRow = (id) => pool.query(
  'SELECT id, kind, status, dry_run, started_at, params FROM e_import_run WHERE id = $1', [id],
).then(({ rows }) => rows[0] ?? null);

test('кнопка заводит запланированный полный прогон', { skip }, async () => {
  const result = await planManualRun({ pool, kind: 'full_run' });
  assert.equal(result.ok, true, `запуск не заведён: ${result.reason}`);
  runs.push(result.id);

  const row = await runRow(result.id);
  assert.equal(row.kind, 'full_run');
  assert.equal(row.status, 'planned', 'прогон ждёт планировщика');
  assert.equal(row.dry_run, false);
  assert.equal(row.params.manual, true, 'строка помечена как ручная');
});

test('сухой прогон — тот же вид с флагом', { skip }, async () => {
  const result = await planManualRun({ pool, kind: 'full_run', dryRun: true });
  assert.equal(result.ok, true, `запуск не заведён: ${result.reason}`);
  runs.push(result.id);

  const row = await runRow(result.id);
  assert.equal(row.kind, 'full_run');
  assert.equal(row.dry_run, true, 'сухой прогон — это флаг, а не отдельный вид');
});

test('второй полный прогон поверх запланированного не заводится', { skip }, async () => {
  const first = await planManualRun({ pool, kind: 'full_run' });
  runs.push(first.id);
  const second = await planManualRun({ pool, kind: 'full_run' });

  assert.equal(second.ok, false);
  assert.equal(second.reason, 'planned', 'ждать тут нечего: прогон уже запланирован');
});

test('ночной план расписания переносится на «сейчас»', { skip }, async () => {
  // Плана может не быть: приложение заводит его само, а проверка живёт рядом
  // с ним. Тогда строка заводится здесь — и берётся та, что осталась.
  await pool.query(
    `INSERT INTO e_import_run (kind, status, started_at, params)
     VALUES ('schedule_sync', 'planned', now() + interval '4 hours', '{"planned_at":"завтра"}')
     ON CONFLICT (kind) WHERE status = 'planned' DO NOTHING`,
  );
  const { rows: plans } = await pool.query(
    "SELECT id FROM e_import_run WHERE kind = 'schedule_sync' AND status = 'planned'",
  );
  runs.push(plans[0].id);

  const result = await planManualRun({ pool, kind: 'schedule_sync' });
  assert.equal(result.ok, true, `запуск не заведён: ${result.reason}`);

  const row = await runRow(result.id);
  assert.equal(row.id, plans[0].id, 'перенесён существующий план, а не заведён второй');
  assert.equal(row.status, 'planned');
  assert.equal(row.params.manual, true, 'строка помечена как ручная');
  const delay = row.started_at.getTime() - Date.now();
  assert.ok(Math.abs(delay) < 60_000, `план перенесён на сейчас, а не на ${delay} мс`);

  // План возвращается на своё время: ручной запуск не должен утащить за собой
  // ночное расписание приложения.
  await pool.query(
    `UPDATE e_import_run
        SET started_at = now() + interval '4 hours', params = params - 'manual'
      WHERE id = $1`,
    [plans[0].id],
  );
});

test('пока идёт прогон, новый не заводится', { skip }, async () => {
  const store = createImportStore(pool);
  const runId = await store.startRun('full_run');
  runs.push(runId);

  const result = await planManualRun({ pool, kind: 'full_run' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'busy', 'прогон держит блокировку');

  // Блокировку отпускаем: следующая проверка ждёт свободного прогона.
  await store.finishRun(runId, 'success');
});

test('планировщик выполняет заведённый кнопкой запуск', { skip }, async () => {
  const calls = [];
  const clock = new Date('2026-10-19T05:00:00Z');
  const task = (kind) => async (args) => { calls.push({ kind, ...args }); return { status: 'success' }; };
  const scheduler = createScheduler({
    pool,
    store: createImportStore(pool),
    tasks: {
      full_run: task('full_run'),
      schedule_sync: task('schedule_sync'),
      discover_sync: task('discover_sync'),
      ratings_sync: task('ratings_sync'),
    },
    now: () => clock,
  }).setSetting({
    scheduleTime: async () => '04:00',
    importEnabled: async () => 'on',
    frozen: async () => false,
    lastSuccess: async () => null,
  });

  // Запуск заводится на те же часы, что и у планировщика: иначе строка ждёт
  // будущего и такт её не увидит.
  const planned = await planManualRun({ pool, kind: 'full_run', now: clock });
  runs.push(planned.id);

  const { ran } = await scheduler.tick();

  assert.ok(ran.includes('full_run'), `ручной запуск выполнен, а не ${ran.join(', ')}`);
  const full = calls.find((call) => call.kind === 'full_run');
  assert.ok(full, 'задача полного прогона вызвана');
  assert.equal(full.runId, planned.id);
  assert.equal(full.dryRun, false, 'флаг сухого прогона приходит из строки');

  const row = await runRow(planned.id);
  assert.equal(row.status, 'success', 'прогон закрыт планировщиком');
});
