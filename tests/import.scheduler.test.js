// Планировщик запусков (F-12-07).
//
// Проверяется на живой базе, потому что половина правил — про блокировку,
// статусы и «пропущенные» строки — существует только в SQL. Заглушка вместо
// базы проверила бы пересказ правил, а не сами правила.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createImportStore } from '../src/services/import/store.js';
import { createScheduler, STALE_HOURS, CATCH_UP_HOURS } from '../src/services/import/scheduler.js';
import { acquireImportLock } from './helpers/import-lock.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE или TEST_DATABASE_URL — планировщик не проверялся';

let pool;
/** Отпускается в `after`: держит общую блокировку строк запуска. */
let unlockImport;
let store;
/** Что реально выполнилось: задачи теста пишут сюда и ничего не ходят в сеть. */
const calls = [];

test.before(async () => {
  if (!available) return;
  pool = createPool();
  unlockImport = await acquireImportLock(pool);
  store = createImportStore(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.query("DELETE FROM e_import_run WHERE kind IN ('schedule_sync','discover_sync','ratings_sync')");
  await unlockImport?.();
  await pool.end();
});

/**
 * Планировщик с задачами-заглушками и управляемыми часами.
 *
 * `import.enabled` и `defence.frozen_at` подставляются значениями, а не
 * читаются из базы: настройки общие для всех файлов прогона, и запись в них
 * ломала бы проверки режима защиты (F-12-10) — они идут параллельно.
 */
/**
 * @param {any} now
 * @param {{enabled?: string, frozen?: boolean, tasks?: any}} [options]
 */
function schedulerAt(now, { enabled = 'on', frozen = false, tasks } = {}) {
  calls.length = 0;
  const defaults = {
    schedule_sync: async () => { calls.push('schedule_sync'); return { status: 'success' }; },
    discover_sync: async () => { calls.push('discover_sync'); return { status: 'success' }; },
    ratings_sync: async () => { calls.push('ratings_sync'); return { status: 'success' }; },
  };
  const scheduler = createScheduler({
    pool,
    store,
    tasks: { ...defaults, ...tasks },
    now: () => new Date(now),
  });
  return scheduler.setSetting({
    scheduleTime: async () => (await pool.query(
      "SELECT value FROM e_system_setting WHERE key = 'import.schedule_time'",
    )).rows[0]?.value ?? '04:00',
    importEnabled: async () => enabled,
    frozen: async () => frozen,
    lastSuccess: async (kind) => (await pool.query(
      `SELECT max(finished_at) AS at FROM e_import_run
        WHERE kind = $1 AND status IN ('success','partial')`,
      [kind],
    )).rows[0]?.at ?? null,
  });
}

/** Строка запуска по виду и статусу — для проверок на живой базе. */
const runRow = (kind, status) => pool.query(
  'SELECT id, status, started_at FROM e_import_run WHERE kind = $1 AND status = $2 ORDER BY id LIMIT 1',
  [kind, status],
).then(({ rows }) => rows[0] ?? null);

async function wipeRuns() {
  await pool.query("DELETE FROM e_import_run WHERE kind IN ('schedule_sync','discover_sync','ratings_sync')");
}

// ─── Планирование ─────────────────────────────────────────────────────────────

test('планирование создаёт строку со временем в будущем', { skip }, async () => {
  await wipeRuns();
  const scheduler = schedulerAt('2026-10-14T03:00:00');
  const plan = await scheduler.plan();

  assert.ok(plan.length >= 2, `запланировано: ${plan.length}`);
  const row = await runRow('schedule_sync', 'planned');
  assert.ok(row, 'ночной запуск должен быть запланирован заранее');
  assert.equal(row.started_at.getHours(), 4, 'время в строке — момент запуска, а не момент планирования');
});

test('повторное планирование не плодит дубликаты', { skip }, async () => {
  await wipeRuns();
  const scheduler = schedulerAt('2026-10-14T03:00:00');
  await scheduler.plan();
  await scheduler.plan();
  await scheduler.plan();

  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM e_import_run WHERE status = 'planned'",
  );
  assert.equal(rows[0].n, 2, 'ночь и открытие новых — две строки, не шесть');
});

test('выключенный импорт не планируется вовсе (§5)', { skip }, async () => {
  await wipeRuns();
  const scheduler = schedulerAt('2026-10-14T04:00:00', { enabled: 'off' });

  const plan = await scheduler.plan();
  assert.deepEqual(plan, []);
  assert.deepEqual(calls, [], 'выключенный планировщик не запускает задачи');
  assert.equal(await runRow('schedule_sync', 'planned'), null);
});

test('режим защиты останавливает планировщик (F-12-10 §4)', { skip }, async () => {
  await wipeRuns();
  const scheduler = schedulerAt('2026-10-14T04:00:00', { frozen: true });

  await scheduler.plan();
  const result = await scheduler.tick();
  assert.deepEqual(calls, []);
  assert.equal(result.reason, 'defence');
});

// ─── Запуск ───────────────────────────────────────────────────────────────────

test('в назначенную минуту задача выполняется и закрывается успехом', { skip }, async () => {
  await wipeRuns();
  const scheduler = schedulerAt('2026-10-14T04:00:00');
  await scheduler.plan();
  const result = await scheduler.tick();

  assert.deepEqual(calls, ['schedule_sync', 'discover_sync'], 'ночью: расписание, потом новые');
  assert.equal(result.ran.length, 2);
  const row = await runRow('schedule_sync', 'success');
  assert.ok(row, 'закрытая строка обязана быть');
  assert.ok(row.started_at instanceof Date);
});

test('вне назначенной минуты тик молчит', { skip }, async () => {
  await wipeRuns();
  const scheduler = schedulerAt('2026-10-14T13:00:00');
  await scheduler.plan();
  await scheduler.tick();

  assert.deepEqual(calls, []);
  assert.ok(await runRow('schedule_sync', 'planned'), 'план остаётся, он не отменяется тиком');
});

test('упавшая задача закрывается ошибкой, а не пропадает', { skip }, async () => {
  await wipeRuns();
  const scheduler = schedulerAt('2026-10-14T04:00:00', {
    tasks: { schedule_sync: async () => { calls.push('schedule_sync'); throw new Error('сеть легла'); } },
  });
  await scheduler.plan();
  const result = await scheduler.tick();

  assert.ok(await runRow('schedule_sync', 'error'));
  assert.ok(!result.ran.includes('discover_sync'), 'после сбоя расписания обзор новых не идёт');
  assert.deepEqual(calls, ['schedule_sync']);
});

test('частичный результат не считается провалом', { skip }, async () => {
  await wipeRuns();
  const scheduler = schedulerAt('2026-10-14T04:00:00', {
    tasks: { schedule_sync: async () => ({ status: 'partial', errors: 3 }) },
  });
  await scheduler.plan();
  await scheduler.tick();

  assert.ok(await runRow('schedule_sync', 'partial'));
  assert.ok(await runRow('discover_sync', 'success'), 'обзор новых после частичного расписания идёт');
});

// ─── Блокировка и пропуск ─────────────────────────────────────────────────────

test('занятый прогон пропускает ночной и это записано (§18)', { skip }, async () => {
  await wipeRuns();
  const { rows } = await pool.query(
    "INSERT INTO e_import_run (kind, status, started_at) VALUES ('full_run','running', now()) RETURNING id",
  );
  try {
    const scheduler = schedulerAt('2026-10-14T04:00:00');
    await scheduler.plan();
    const result = await scheduler.tick();

    assert.deepEqual(calls, [], 'пока держит полный прогон, ничего не начинается');
    assert.deepEqual(result.skipped, ['schedule_sync', 'discover_sync']);
    const row = await runRow('schedule_sync', 'skipped');
    assert.ok(row, 'пропуск обязан остаться в истории, а не потеряться');
    assert.ok(row.started_at instanceof Date);
  } finally {
    await pool.query('DELETE FROM e_import_run WHERE id = $1', [rows[0].id]);
  }
});

test('зависший прогон старше шести часов не считается идущим', { skip }, async () => {
  await wipeRuns();
  const { rows } = await pool.query(
    `INSERT INTO e_import_run (kind, status, started_at)
     VALUES ('full_run','running', now() - ($1 || ' hours')::interval) RETURNING id`,
    [String(STALE_HOURS + 1)],
  );
  try {
    const scheduler = schedulerAt('2026-10-14T04:00:00');
    await scheduler.plan();
    await scheduler.tick();
    assert.deepEqual(calls, ['schedule_sync', 'discover_sync'],
      'падавший процесс не должен держать блокировку вечно');
  } finally {
    await pool.query('DELETE FROM e_import_run WHERE id = $1', [rows[0].id]);
  }
});

// ─── Догон при старте ──────────────────────────────────────────────────────────

test('успеха нет 40 часов — ночной запуск стартует сразу (§18)', { skip }, async () => {
  await wipeRuns();
  const scheduler = schedulerAt('2026-10-14T04:00:00');
  const result = await scheduler.catchUp();

  assert.ok(result.ran.includes('schedule_sync'), `запущено: ${result.ran}`);
  assert.ok(await runRow('schedule_sync', 'success'));
});

test('успех был час назад — догон молчит', { skip }, async () => {
  await wipeRuns();
  await pool.query(
    `INSERT INTO e_import_run (kind, status, started_at, finished_at)
     VALUES ('schedule_sync','success', '2026-10-14T02:00:00', '2026-10-14T02:00:00')`,
  );
  const scheduler = schedulerAt('2026-10-14T04:00:00');
  const result = await scheduler.catchUp();

  assert.deepEqual(result.ran, []);
  assert.deepEqual(calls, []);
});

test('граница 36 часов: ровно на пороге ещё не догоняем', { skip }, async () => {
  await wipeRuns();
  await pool.query(
    `INSERT INTO e_import_run (kind, status, started_at, finished_at)
     VALUES ('schedule_sync','success', $1, $1)`,
    ['2026-10-12T16:00:00'],
  );
  const scheduler = schedulerAt('2026-10-14T04:00:00');
  assert.deepEqual((await scheduler.catchUp()).ran, []);
});

test('после догона планируется следующая ночь, а не текущая', { skip }, async () => {
  await wipeRuns();
  const scheduler = schedulerAt('2026-10-14T04:00:00');
  await scheduler.catchUp();
  await scheduler.plan();

  const row = await runRow('schedule_sync', 'planned');
  assert.ok(row, 'следующая ночь должна быть запланирована');
  assert.ok(row.started_at > new Date('2026-10-14T04:00:00'),
    `время в плане: ${row.started_at}`);
});

// ─── Состояние для S-76 ───────────────────────────────────────────────────────

test('устаревшие данные видны в состоянии (EC-I10)', { skip }, async () => {
  await wipeRuns();
  await pool.query(
    `INSERT INTO e_import_run (kind, status, started_at, finished_at)
     VALUES ('schedule_sync','success', '2026-10-12T04:00:00', '2026-10-12T04:00:00')`,
  );
  const state = await schedulerAt('2026-10-14T04:00:00').state();

  assert.equal(state.stale, true, 'S-76 должен предупредить «данные устарели»');
  assert.equal(state.frozen, false);
  assert.ok(state.lastSuccessAt <= new Date(), 'дата последнего успеха доступна панели');
});

test('свежие данные не считаются устаревшими', { skip }, async () => {
  await wipeRuns();
  await pool.query(
    `INSERT INTO e_import_run (kind, status, started_at, finished_at)
     VALUES ('schedule_sync','success', '2026-10-14T01:00:00', '2026-10-14T01:00:00')`,
  );
  assert.equal((await schedulerAt('2026-10-14T04:00:00').state()).stale, false);
});

// ─── Порядок ночью ─────────────────────────────────────────────────────────────

test('еженедельный рейтинг — только в понедельник', { skip }, async () => {
  await wipeRuns();
  const monday = schedulerAt('2026-10-12T05:00:00'); // 12.10.2026 — понедельник
  await monday.plan();
  await monday.tick();
  assert.ok(calls.includes('ratings_sync'), 'в понедельник рейтинг обновляется');

  calls.length = 0;
  await wipeRuns();
  const tuesday = schedulerAt('2026-10-13T05:00:00');
  await tuesday.plan();
  await tuesday.tick();
  assert.ok(!calls.includes('ratings_sync'), 'во вторник рейтинг не трогают');
});

test('ночной запуск не ждёт рейтинга', { skip }, async () => {
  await wipeRuns();
  const scheduler = schedulerAt('2026-10-13T04:00:00'); // вторник
  await scheduler.plan();
  await scheduler.tick();
  assert.deepEqual(calls, ['schedule_sync', 'discover_sync']);
});
