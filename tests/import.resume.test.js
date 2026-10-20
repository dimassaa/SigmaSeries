// Продолжение прогона импорта после обрыва и уведомление администратору
// (F-12-09 §3, §17; №94, №95).
//
// Проверяется против живой базы: выбор прогона, отбор незавершённых позиций и
// запись уведомления — это SQL, и подменять его заглушкой нечего. Заглушка
// стоит только там, где решение принимает код: отказ ключа (401) идёт от
// клиента источника, а не от базы.
//
// Пропускается, если PG* не заданы.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { createImportStore } from '../src/services/import/store.js';
import { notifyAdmins } from '../src/services/import/notify.js';
import { matchCandidates } from '../src/services/import/match.js';
import { enrichAll, itemsFromEnrichment } from '../src/services/import/enrich.js';
import { TmdbError, isKeyRejected } from '../src/services/import/tmdb.js';
import { notificationText } from '../src/view/notification.js';
import { categoryOf } from '../src/services/notify/types.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { acquireImportLock } from './helpers/import-lock.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — продолжение прогона не проверялось';

let pool;
let store;
/** Отпускается в `after`: держит общую блокировку строк запуска. */
let unlockImport;
const created = [];
const runs = [];

test.before(async () => {
  if (!available) return;
  pool = createPool();
  unlockImport = await acquireImportLock(pool);
  store = createImportStore(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_import_item_result WHERE run_id = ANY($1::bigint[])', [runs]);
  await pool.query('DELETE FROM e_import_run WHERE id = ANY($1::bigint[])', [runs]);
  await pool.query("DELETE FROM e_role_assignment WHERE note = 'тест импорта'");
  await pool.query('DELETE FROM e_user WHERE id = ANY($1::bigint[])', [created]);
  await unlockImport?.();
  await pool.end();
});

/** Человек с ролью: 'admin' — служебная роль, '' — обычный зритель. */
async function person(role) {
  const { hash } = makeToken();
  const name = `import-${role}-${crypto.randomUUID().slice(0, 8)}`;
  const passwordHash = await hashPassword('правильный-пароль-из-десяти');
  const account = await pgAuthStore(pool).createUser({
    email: `${name}@example.com`,
    nickname: name,
    passwordHash,
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  created.push(account.id);
  if (role) {
    await pool.query(
      `INSERT INTO e_role_assignment (user_id, role, granted_by, note)
       VALUES ($1, $2, $1, 'тест импорта')`,
      [account.id, role],
    );
  }
  return account.id;
}

/** Прогон отбора с заданным статусом. */
async function run(status = 'success', kind = 'full_run') {
  const { rows } = await pool.query(
    `INSERT INTO e_import_run (kind, dry_run, status, started_at)
     VALUES ($1, TRUE, $2, now()) RETURNING id`,
    [kind, status],
  );
  runs.push(rows[0].id);
  return rows[0].id;
}

test('прогон, оборванный сбоем, выбирается для продолжения (№95)', { skip }, async () => {
  // Сначала успешный прогон, потом упавший: продолжение должно взять упавший,
  // а не тот, что разошелся раньше. Иначе оборванная работа терялась бы
  // навсегда, а прогон «успешный» переигрывался бы без нужды.
  const good = await run('success');
  const broken = await run('error');
  await store.saveItems(good, [{ tconst: 'tt0000001', stage: 'candidates', outcome: 'ok' }]);
  await store.saveItems(broken, [{ tconst: 'tt0000002', stage: 'candidates', outcome: 'ok' }]);

  const pending = await store.pendingCandidates();
  assert.equal(pending.runId, broken);
  assert.deepEqual(pending.items.map((row) => row.tconst), ['tt0000002']);
  assert.equal(pending.status, 'error');
});

test('перебираются незавершённые позиции, а завершённые — нет (№95)', { skip }, async () => {
  const runId = await run('running');
  await store.saveItems(runId, [
    { tconst: 'tt1111111', stage: 'candidates', outcome: 'ok' },
    { tconst: 'tt2222222', stage: 'matched', outcome: 'ok', tmdbId: 11 },
    { tconst: 'tt3333333', stage: 'matched', outcome: 'error' },
    { tconst: 'tt4444444', stage: 'matched', outcome: 'no_tmdb' },
  ]);

  const pending = await store.pendingCandidates();
  assert.deepEqual(
    pending.items.map((row) => row.tconst).sort(),
    ['tt1111111', 'tt3333333'],
    'упавшая позиция не сделана — её надо перебрать заново',
  );
});

test('продолжение помечает прогон как возобновлённый', { skip }, async () => {
  const runId = await run('error');
  const resumed = await store.resumeRun(runId);
  assert.equal(resumed, true);

  const { rows } = await pool.query('SELECT status FROM e_import_run WHERE id = $1', [runId]);
  assert.equal(rows[0].status, 'resumed');
});

test('счётчики считаются по всему прогону, а не по текущей попытке', { skip }, async () => {
  const runId = await run('running');
  await store.saveItems(runId, [
    { tconst: 'tt5555001', stage: 'matched', outcome: 'ok', tmdbId: 1 },
    { tconst: 'tt5555002', stage: 'matched', outcome: 'ok', tmdbId: 2 },
    { tconst: 'tt5555003', stage: 'matched', outcome: 'no_tmdb' },
    { tconst: 'tt5555004', stage: 'matched', outcome: 'error' },
  ]);

  const progress = await store.progress(runId);
  assert.equal(progress.total, 4);
  assert.equal(progress.done, 3, 'упавшая позиция не сделана');
  assert.equal(progress.failed, 1);
  assert.equal(progress.withoutPair, 1, 'позиция без подтверждённой пары');
  assert.equal(progress.counts.ok, 2);
});

test('закрытый прогон возобновлением не трогается', { skip }, async () => {
  const runId = await run('success');
  assert.equal(await store.resumeRun(runId), false);

  const { rows } = await pool.query('SELECT status FROM e_import_run WHERE id = $1', [runId]);
  assert.equal(rows[0].status, 'success');
});

test('счётчики и контрольная точка пишутся рядом со статусом (№68, №102)', { skip }, async () => {
  const runId = await run('running');
  await store.finishRun(runId, 'partial', {
    counters: { matched: 3, error: 1, total: 4 },
    checkpoint: { stage: 'matched', processed: 4, planned: 4 },
  });

  const { rows } = await pool.query(
    'SELECT status, counters, checkpoint FROM e_import_run WHERE id = $1',
    [runId],
  );
  assert.equal(rows[0].status, 'partial');
  assert.equal(rows[0].counters.matched, 3);
  assert.equal(rows[0].counters.error, 1);
  assert.equal(rows[0].checkpoint.stage, 'matched');
  assert.equal(rows[0].checkpoint.processed, 4);
});

test('отказ ключа прерывает прогон, а не копит тысячу одинаковых ошибок', async () => {
  const tmdb = {
    async findByImdbId() {
      throw new TmdbError('TMDB отклонил ключ (401) — неверный ключ, запуск прерывается', 401);
    },
    async getDetails() {
      throw new TmdbError('TMDB отклонил ключ (401) — неверный ключ, запуск прерывается', 401);
    },
    async getDetailsLocalized() {
      throw new TmdbError('TMDB отклонил ключ (401) — неверный ключ, запуск прерывается', 401);
    },
  };

  await assert.rejects(
    () => matchCandidates({ items: [{ tconst: 'tt1', startYear: 2008 }], tmdb }),
    (error) => isKeyRejected(error),
    'сопоставление должно прерваться на отказе ключа',
  );
  await assert.rejects(
    () => enrichAll({ items: [{ tmdbId: 1, imdb: { tconst: 'tt1' } }], tmdb }),
    (error) => isKeyRejected(error),
    'обогащение должно прерваться на отказе ключа',
  );
});

test('упавшее обогащение попадает в прогон как ошибка, а не как готовая позиция', () => {
  const { items, failed, errors } = itemsFromEnrichment({
    results: [
      { raw: { id: 1 }, error: null },
      { raw: null, error: 'сеть недоступна' },
    ],
    targets: [
      { tconst: 'tt_ok', tmdbId: 1, rank: 1 },
      { tconst: 'tt_bad', tmdbId: 2, rank: 2 },
    ],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].stage, 'enriched');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].outcome, 'error');
  assert.equal(failed[0].stage, 'matched', 'до стадии «обогащено» позиция не дошла');
  assert.equal(failed[0].tmdbId, 2, 'пара сохраняется: сопоставление сделано');
  assert.equal(errors[0].message, 'сеть недоступна');
});

test('сбой одной позиции не уносит остальные', async () => {
  const tmdb = {
    async findByImdbId(tconst) {
      if (tconst === 'tt_bad') throw new Error('сеть недоступна');
      return { tvResults: [{ id: 7, media_type: 'tv' }], notFound: false };
    },
    async getDetails() {
      return { id: 7, first_air_date: '2008-01-20', external_ids: { imdb_id: 'tt_ok' } };
    },
  };

  const results = await matchCandidates({
    items: [{ tconst: 'tt_bad', startYear: 2008 }, { tconst: 'tt_ok', startYear: 2008 }],
    tmdb,
  });
  assert.equal(results.find((r) => r.tconst === 'tt_bad').outcome, 'error');
  assert.equal(results.find((r) => r.tconst === 'tt_ok').outcome, 'ok');
});

test('администратор получает уведомление о прерванном прогоне (№94)', { skip }, async () => {
  const adminId = await person('admin');
  const runId = await run('error');

  const createdCount = await notifyAdmins({
    pool,
    kind: 'import_key_rejected',
    params: { runId, reason: 'ключ отклонил источник' },
    dedupKey: `import-key-rejected:${runId}`,
  });
  assert.ok(createdCount >= 1, 'уведомление создаётся хотя бы одному администратору');

  // Проверяется своя запись администратора, а не число: в общей базе есть ещё
  // администраторы приложения, и их число к проверке отношения не имеет.
  const { rows } = await pool.query(
    'SELECT kind, category, params FROM e_notification WHERE user_id = $1',
    [adminId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'import_key_rejected');
  assert.equal(rows[0].category, 'service');
  assert.equal(rows[0].params.runId, runId);
});

test('повтор не создаёт второе уведомление', { skip }, async () => {
  const adminId = await person('admin');
  const runId = await run('error');
  const dedupKey = `import-partial:${runId}`;

  await notifyAdmins({ pool, kind: 'import_partial', params: { runId, done: 3, total: 10 }, dedupKey });
  const second = await notifyAdmins({
    pool,
    kind: 'import_partial',
    params: { runId, done: 3, total: 10 },
    dedupKey,
  });
  assert.equal(second, 0);

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM e_notification WHERE user_id = $1', [adminId]);
  assert.equal(rows[0].n, 1);
});

test('зрителю служебное уведомление не достаётся', { skip }, async () => {
  const viewerId = await person('');
  const runId = await run('error');

  await notifyAdmins({
    pool,
    kind: 'import_key_rejected',
    params: { runId },
    dedupKey: `import-key-rejected:зритель:${runId}`,
  });

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM e_notification WHERE user_id = $1', [viewerId]);
  assert.equal(rows[0].n, 0, 'зритель служебного уведомления не получает');
});

test('текст уведомления собирается на языке читателя (R-I18N-14)', () => {
  assert.equal(categoryOf('import_key_rejected'), 'service');
  assert.equal(categoryOf('import_partial'), 'service');

  const ru = notificationText('ru', {
    kind: 'import_key_rejected',
    params: { runId: 42 },
  });
  assert.match(ru.title, /Импорт/);
  assert.match(ru.body, /42/);
  assert.match(ru.body, /отклонил ключ/);

  const en = notificationText('en', {
    kind: 'import_partial',
    params: { runId: 42, done: 3, total: 10 },
  });
  assert.match(en.title, /Import/);
  assert.match(en.body, /3/);
  assert.match(en.body, /10/);
});
