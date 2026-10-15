// Запись результатов отбора (F-12-01 §4, §17) против настоящей базы.
//
// Тот же довод, что у tests/auth.store.test.js: SQL виден только при его
// выполнении, а заглушки здесь нет — писать нечего и нечем притворяться.
// Пропускается, если PG* не заданы.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createImportStore } from '../src/services/import/store.js';
import { acquireImportLock } from './helpers/import-lock.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE или TEST_DATABASE_URL — хранилище не проверялось';

let pool;
/** Отпускается в `after`: держит общую блокировку строк запуска. */
let unlockImport;
let store;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  unlockImport = await acquireImportLock(pool);
  store = createImportStore(pool);
});

test.after(async () => {
  if (pool) {
    // Запуски — только наши: чужие строки в рабочей базе трогать нельзя.
    await pool.query("DELETE FROM e_import_item_result WHERE run_id IN (SELECT id FROM e_import_run WHERE kind = 'ratings_sync' AND dry_run)");
    await pool.query("DELETE FROM e_import_run WHERE kind = 'ratings_sync' AND dry_run");
    await unlockImport?.();
  await pool.end();
  }
});

/** Прогон, который заведомо наш: сухой рейтинговый. */
const startRun = () => store.startRun('ratings_sync', { dryRun: true });

test('запуск создаётся и остаётся в состоянии «идёт»', { skip }, async () => {
  const runId = await startRun();
  const { rows } = await pool.query('SELECT kind, dry_run, status FROM e_import_run WHERE id = $1', [runId]);
  assert.equal(rows[0].kind, 'ratings_sync');
  assert.equal(rows[0].dry_run, true);
  assert.equal(rows[0].status, 'running');
});

test('позиции отбора пишутся с рангом, голосами и оценкой', { skip }, async () => {
  const runId = await startRun();
  await store.saveItems(runId, [
    { tconst: 'tt0903747', stage: 'candidates', outcome: 'ok', rank: 1, numVotes: 2_685_479, averageRating: 9.5 },
    { tconst: 'tt0944947', stage: 'candidates', outcome: 'ok', rank: 2, numVotes: 2_300_000, averageRating: 8.9 },
  ]);

  const { rows } = await pool.query(
    `SELECT tconst, popularity_rank, num_votes, average_rating, stage, outcome
       FROM e_import_item_result WHERE run_id = $1 ORDER BY popularity_rank`,
    [runId],
  );
  assert.deepEqual(rows.map((r) => r.tconst), ['tt0903747', 'tt0944947']);
  assert.equal(rows[0].num_votes, 2_685_479);
  assert.equal(rows[0].average_rating, '9.5');
});

test('одна и та же позиция перезаписывается, а не падает', { skip }, async () => {
  // Возобновление после сбоя (F-12-09) обязано обновлять позицию, а не
  // спотыкаться о нарушение первичного ключа.
  const runId = await startRun();
  await store.saveItems(runId, [{ tconst: 'tt1', stage: 'candidates', outcome: 'ok', rank: 1, numVotes: 10 }]);
  await store.saveItems(runId, [{ tconst: 'tt1', stage: 'matched', outcome: 'pair_doubt', tmdbId: 42, attempts: 2 }]);

  const { rows } = await pool.query(
    'SELECT stage, outcome, tmdb_id, attempts, num_votes FROM e_import_item_result WHERE run_id = $1',
    [runId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, 'matched');
  assert.equal(rows[0].outcome, 'pair_doubt');
  assert.equal(rows[0].tmdb_id, 42);
  assert.equal(rows[0].attempts, 2);
});

test('следующая стадия не стирает данные отбора', { skip }, async () => {
  // Сопоставление знает только tconst и результат поиска. Если бы upsert
  // перезаписывал год начала на NULL, следующий шаг не смог бы проверить пару,
  // а год был бы потерян без всякой ошибки.
  const runId = await startRun();
  await store.saveItems(runId, [{
    tconst: 'tt1',
    stage: 'candidates',
    outcome: 'ok',
    rank: 7,
    numVotes: 900,
    averageRating: 8.4,
    startYear: 2008,
  }]);
  await store.saveItems(runId, [{ tconst: 'tt1', stage: 'matched', outcome: 'ok', tmdbId: 42 }]);

  const { rows } = await pool.query(
    `SELECT stage, tmdb_id, popularity_rank, num_votes, average_rating, start_year
       FROM e_import_item_result WHERE run_id = $1`,
    [runId],
  );
  assert.equal(rows[0].stage, 'matched');
  assert.equal(rows[0].tmdb_id, 42);
  assert.equal(rows[0].start_year, 2008);
  assert.equal(rows[0].popularity_rank, 7);
  assert.equal(rows[0].num_votes, 900);
});

test('но исход стадии перезаписывается, включая пустой', { skip }, async () => {
  // Обратная сторона предыдущего правила: «не найдено» должно стирать прежний
  // результат, иначе в отчёте осталась бы старая удачная пара.
  const runId = await startRun();
  await store.saveItems(runId, [{ tconst: 'tt1', stage: 'matched', outcome: 'ok', tmdbId: 42, reasons: ['a'] }]);
  await store.saveItems(runId, [{ tconst: 'tt1', stage: 'matched', outcome: 'no_tmdb', reasons: [] }]);

  const { rows } = await pool.query(
    'SELECT outcome, tmdb_id, reasons FROM e_import_item_result WHERE run_id = $1',
    [runId],
  );
  assert.equal(rows[0].outcome, 'no_tmdb');
  assert.equal(rows[0].tmdb_id, null);
  assert.deepEqual(rows[0].reasons, []);
});

test('сырой слой переживает следующую стадию', { skip }, async () => {
  // Обогащение кладёт `raw`, а последующая стадия (F-12-06) его читает и
  // меняет только `stage`. Без COALESCE строка затиралась бы пустым JSON.
  const runId = await startRun();
  await store.saveItems(runId, [{
    tconst: 'tt1',
    stage: 'enriched',
    outcome: 'ok',
    rank: 1,
    raw: { tmdbId: 1396, seasons: [{ number: 1, episodes: [] }], people: { directors: [], cast: [] } },
  }]);
  await store.saveItems(runId, [{ tconst: 'tt1', stage: 'written', outcome: 'ok' }]);

  const { rows } = await pool.query('SELECT stage, raw FROM e_import_item_result WHERE run_id = $1', [runId]);
  assert.equal(rows[0].stage, 'written');
  assert.equal(rows[0].raw.tmdbId, 1396);
  assert.equal(rows[0].raw.seasons.length, 1);
});

test('чужая стадия не пишется молча в обход CHECK', { skip }, async () => {
  const runId = await startRun();
  await assert.rejects(
    () => store.saveItems(runId, [{ tconst: 'tt1', stage: 'выдумка', outcome: 'ok' }]),
    /ck_|stage|check/i,
  );
});

test('запуск закрывается статусом и временем', { skip }, async () => {
  const runId = await startRun();
  await store.saveItems(runId, [{ tconst: 'tt1', stage: 'candidates', outcome: 'ok', rank: 1, numVotes: 5 }]);
  await store.finishRun(runId, 'success');

  const { rows } = await pool.query('SELECT status, finished_at FROM e_import_run WHERE id = $1', [runId]);
  assert.equal(rows[0].status, 'success');
  assert.ok(rows[0].finished_at instanceof Date);
});

test('удаление запуска уносит его позиции', { skip }, async () => {
  const runId = await startRun();
  await store.saveItems(runId, [{ tconst: 'tt1', stage: 'candidates', outcome: 'ok' }]);
  await pool.query('DELETE FROM e_import_run WHERE id = $1', [runId]);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM e_import_item_result WHERE run_id = $1', [runId]);
  assert.equal(rows[0].n, 0);
});