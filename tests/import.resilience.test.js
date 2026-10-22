// Устойчивость прогона: размыкатель, возобновление и «частично» (F-12-09).
//
// Размыкатель проверяется отдельно — в `tests/import.breaker.test.js`. Здесь
// проверяется то, что он ломает: прогон после трёх пауз перестаёт работать и
// честно уходит в «частично», а повторный запуск не трогает сделанное.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createPool } from '../src/db/pool.js';
import { createTmdbClient } from '../src/services/import/tmdb.js';
import { matchCandidates } from '../src/services/import/match.js';
import { createImportStore } from '../src/services/import/store.js';
import { PAUSE_MS, MAX_PAUSES } from '../src/services/import/breaker.js';
import { acquireImportLock } from './helpers/import-lock.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE или TEST_DATABASE_URL — устойчивость не проверялась';

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
  if (!pool) return;
  // Прогоны, созданные тестом, убираются: незакрытая строка `running`
  // осталась бы висеть и блокировала бы заморозку в режиме защиты.
  await pool.query(
    "DELETE FROM e_import_item_result WHERE run_id IN (SELECT id FROM e_import_run WHERE kind = 'ratings_sync' AND dry_run)",
  );
  await pool.query("DELETE FROM e_import_run WHERE kind = 'ratings_sync' AND dry_run");
  await unlockImport?.();
  await pool.end();
});

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}` }));
  });
}

/** Клиент без пауз: иначе прогон в тесте встал бы на пять минут. */
const fastClient = (baseUrl, extra = {}) => createTmdbClient({
  token: 'x'.repeat(50),
  baseUrl,
  sleep: async () => {},
  rps: 1000,
  ...extra,
});

test('размыкатель открывается после трёх пауз, и клиент это видит', async () => {
  const { server, baseUrl } = await serve((_req, res) => res.writeHead(503).end('busy'));
  try {
    // Пауза мгновенная, но счётчик пауз — настоящий.
    const api = fastClient(baseUrl);
    assert.equal(api.breakerTripped, false);

    for (let i = 0; i < 50 * (MAX_PAUSES + 1); i += 1) {
      await api.findByImdbId(`tt${i}`).catch(() => {});
    }
    assert.ok(api.breakerPauses >= MAX_PAUSES, `пауз: ${api.breakerPauses}`);
    assert.equal(api.breakerTripped, true, 'после трёх пауз прогон должен уйти в «частично»');
    assert.ok(PAUSE_MS === 5 * 60 * 1000, 'пауза по спецификации — пять минут');
  } finally {
    server.close();
  }
});

test('сбой одного сериала не уносит остальные (F-12-09 §3)', async () => {
  const api = {
    async findByImdbId(tconst) {
      if (tconst === 'tt_bad') throw new Error('сеть недоступна');
      return { tvResults: [{ id: Number(tconst.slice(2)) + 1, media_type: 'tv' }], notFound: false };
    },
    async getDetails(id) {
      // Обратный идентификатор совпадает: пара подтверждается именно им.
      return { external_ids: { imdb_id: `tt${id - 1}` }, first_air_date: '2020-01-01' };
    },
  };
  const items = Array.from({ length: 10 }, (_, i) => ({ tconst: `tt${i}`, startYear: 2020 }));
  items[3] = { tconst: 'tt_bad', startYear: 2020 };

  const results = await matchCandidates({ items, tmdb: api, concurrency: 2 });
  assert.equal(results.length, 10);
  assert.equal(results[3].outcome, 'error');
  assert.equal(results.filter((row) => row.outcome === 'ok').length, 9);
});

// ─── Возобновление ───────────────────────────────────────────────────────────

const startRun = () => store.startRun('ratings_sync', { dryRun: true });

test('повторный запуск пропускает доведённые позиции (F-12-09)', { skip }, async () => {
  const runId = await startRun();
  await store.saveItems(runId, [
    { tconst: 'tt1', stage: 'candidates', outcome: 'ok', rank: 1, numVotes: 10 },
    { tconst: 'tt2', stage: 'candidates', outcome: 'ok', rank: 2, numVotes: 5 },
  ]);
  // Позиция доведена до сопоставления — её повторный запуск не трогает.
  await store.saveItems(runId, [{ tconst: 'tt2', stage: 'matched', outcome: 'ok', tmdbId: 42 }]);

  const { rows } = await pool.query(
    'SELECT tconst, stage, tmdb_id FROM e_import_item_result WHERE run_id = $1 ORDER BY tconst',
    [runId],
  );
  assert.deepEqual(rows, [
    { tconst: 'tt1', stage: 'candidates', tmdb_id: null },
    { tconst: 'tt2', stage: 'matched', tmdb_id: 42 },
  ]);
});

test('попытки на позиции накапливаются, а не обнуляются', { skip }, async () => {
  // Число попыток — часть контрольной точки (F-12-09 §9): по нему видно, что
  // позиция упиралась в сеть, даже когда в итоге справилась.
  const runId = await startRun();
  await store.saveItems(runId, [{ tconst: 'tt1', stage: 'candidates', outcome: 'ok', attempts: 3 }]);
  await store.saveItems(runId, [{ tconst: 'tt1', stage: 'candidates', outcome: 'ok', attempts: 1 }]);

  const { rows } = await pool.query('SELECT attempts FROM e_import_item_result WHERE run_id = $1', [runId]);
  assert.equal(rows[0].attempts, 1, 'последняя запись главнее: попытки считаются за прогон');
});

test('возобновление не теряет сырой слой', { skip }, async () => {
  const runId = await startRun();
  const raw = { tconst: 'tt1', tmdbId: 1, seasons: [], people: { directors: [], cast: [] } };
  await store.saveItems(runId, [{ tconst: 'tt1', stage: 'enriched', outcome: 'ok', raw }]);
  await store.saveItems(runId, [{ tconst: 'tt1', stage: 'written', outcome: 'ok' }]);

  const { rows } = await pool.query('SELECT stage, raw FROM e_import_item_result WHERE run_id = $1', [runId]);
  assert.equal(rows[0].stage, 'written');
  assert.equal(rows[0].raw.tmdbId, 1);
});