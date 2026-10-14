// Сопоставление кандидатов с TMDB: взять отобранное, найти пары, записать
// исход (F-12-02).
//
//   npm run import:match [-- --limit 50]
//
// Кандидаты берутся из последнего успешного прогона отбора, а не читаются
// заново из датасета: сопоставление идёт по одной позиции, и повторное
// чтение 226 МБ ради тысячи строк было бы лишним. Ключ TMDB обязателен —
// без него сопоставление невозможно, и это лучше сказать сразу, чем после
// тысячи строк «не найдено».

import { createPool } from '../db/pool.js';
import { createTmdbClient } from '../services/import/tmdb.js';
import { matchCandidates } from '../services/import/match.js';
import { createImportStore } from '../services/import/store.js';

function parseArgs(argv) {
  const args = { limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1]);
  }
  return args;
}

/**
 * Последний прогон отбора и его позиции, которым ещё не искали пару.
 *
 * Берётся ровно один прогон: смешивать кандидатов из двух прогонов нельзя,
 * иначе результаты разъедутся по разным `run_id` и отчёт S-76 покажет
 * сопоставление, которому не соответствует ни один отбор.
 */
async function pendingCandidates(pool, args) {
  const { rows: runs } = await pool.query(
    `SELECT id FROM e_import_run
      WHERE kind = 'full_run' AND status = 'success'
      ORDER BY id DESC LIMIT 1`,
  );
  if (!runs.length) return null;

  // `LIMIT ALL` нельзя передать параметром — Postgres ждёт литерал. Подставляем
  // его в текст, но только из числа, разобранного из аргументов: строковое
  // значение сюда попасть не может.
  const limit = args.limit;
  if (!Number.isFinite(limit) || limit < 0) throw new Error(`--limit должен быть числом, получено «${args.limit}»`);
  const limitClause = limit > 0 ? `LIMIT ${Math.floor(limit)}` : '';

  const { rows } = await pool.query(
    `SELECT tconst, popularity_rank, start_year
       FROM e_import_item_result
      WHERE run_id = $1 AND stage = 'candidates' AND tmdb_id IS NULL
      ORDER BY popularity_rank
      ${limitClause}`,
    [runs[0].id],
  );
  return { runId: runs[0].id, items: rows };
}

async function main() {
  const { limit } = parseArgs(process.argv.slice(2));
  if (!process.env.PGHOST && !process.env.DATABASE_URL) {
    throw new Error('не задано подключение к базе: нужны PGHOST/PGUSER/PGDATABASE или DATABASE_URL');
  }
  if (!process.env.TMDB_TOKEN) {
    throw new Error('не задан TMDB_TOKEN: без ключа сопоставление невозможно');
  }

  const pool = createPool();
  const store = createImportStore(pool);

  try {
    const pending = await pendingCandidates(pool, { limit });
    if (!pending) {
      console.log('Нет ни одного успешного прогона отбора: сначала `npm run import:candidates`');
      process.exitCode = 1;
      return;
    }
    if (!pending.items.length) {
      console.log('Все кандидаты уже сопоставлены');
      process.exitCode = 0;
      return;
    }

    const tmdb = createTmdbClient({ token: process.env.TMDB_TOKEN });
    const started = Date.now();
    console.log(`Прогон #${pending.runId}: сопоставляю ${pending.items.length} позиций…`);

    const results = await matchCandidates({
      items: pending.items.map((row) => ({ tconst: row.tconst, startYear: row.start_year })),
      tmdb,
    });

    const ranks = new Map(pending.items.map((row) => [row.tconst, row.popularity_rank]));
    await store.saveItems(pending.runId, results.map((r) => ({
      tconst: r.tconst,
      tmdbId: r.tmdbId,
      stage: 'matched',
      outcome: r.outcome,
      reasons: r.reasons,
      rank: ranks.get(r.tconst) ?? null,
    })));

    const tally = new Map();
    for (const r of results) tally.set(r.outcome, (tally.get(r.outcome) ?? 0) + 1);
    console.log(`\nГотово за ${Math.round((Date.now() - started) / 1000)} с:`);
    for (const [outcome, count] of [...tally].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${outcome}: ${count}`);
    }

    const doubtful = results.filter((r) => r.outcome === 'pair_doubt');
    if (doubtful.length) {
      console.log(`\nСомнительные пары, первые десять из ${doubtful.length}:`);
      for (const r of doubtful.slice(0, 10)) console.log(`  ${r.tconst} — ${r.reasons.join(', ')}`);
    }
    const failed = results.filter((r) => r.outcome === 'error');
    if (failed.length) {
      console.log(`\nОшибки API, первые пять из ${failed.length}:`);
      for (const r of failed.slice(0, 5)) console.log(`  ${r.tconst} — ${r.reasons.join(', ')}`);
    }
    process.exitCode = 0;
  } catch (error) {
    console.error(`\nСопоставление не удалось: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();