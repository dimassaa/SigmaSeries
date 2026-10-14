// Запись каталога: сырой слой → строки базы (F-12-06).
//
//   npm run import:catalogue [-- --limit 50]
//
// У каждого сериала своя транзакция: сбой одного не должен уносить остальных
// (F-12-06 §5), поэтому общей транзакции на прогон здесь нет и быть не может.

import { createPool } from '../db/pool.js';
import { writeSeries, loadSlugs } from '../services/import/write.js';
import { createImportStore } from '../services/import/store.js';

/** Сколько результатов копится перед одной записью в прогон. */
const BATCH = 200;

function parseArgs(argv) {
  const args = { limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1]);
  }
  if (!Number.isFinite(args.limit) || args.limit < 0) {
    throw new Error(`--limit должен быть неотрицательным числом, получено «${args.limit}»`);
  }
  return args;
}

/** Обогащённые позиции последнего прогона. */
async function enrichedRows(pool, runId, limit) {
  const { rows } = await pool.query(
    `SELECT tconst, popularity_rank, raw
       FROM e_import_item_result
      WHERE run_id = $1 AND raw IS NOT NULL
      ORDER BY popularity_rank
      ${limit > 0 ? `LIMIT ${Math.floor(limit)}` : ''}`,
    [runId],
  );
  return rows;
}

async function main() {
  const { limit } = parseArgs(process.argv.slice(2));
  if (!process.env.PGHOST && !process.env.DATABASE_URL) {
    throw new Error('не задано подключение к базе: нужны PGHOST/PGUSER/PGDATABASE или DATABASE_URL');
  }

  const pool = createPool();
  const store = createImportStore(pool);

  try {
    const { rows: runs } = await pool.query(
      `SELECT id FROM e_import_run WHERE kind = 'full_run' AND status = 'success' ORDER BY id DESC LIMIT 1`,
    );
    if (!runs.length) {
      console.log('Нет успешного прогона: сначала `npm run import:candidates`');
      process.exitCode = 1;
      return;
    }
    const runId = runs[0].id;

    const rows = await enrichedRows(pool, runId, limit);
    if (!rows.length) {
      console.log('Обогащённых сериалов нет: запустите `npm run import:enrich`');
      process.exitCode = 1;
      return;
    }

    const slugs = await loadSlugs(pool);
    const started = Date.now();
    const states = new Map();
    const levels = new Map();
    const batch = [];
    let written = 0;
    let published = 0;
    let failed = 0;

    const flush = async () => {
      if (batch.length) await store.saveItems(runId, batch.splice(0, batch.length));
    };

    for (const row of rows) {
      try {
        const result = await writeSeries({ pool, raw: row.raw, slugs });
        written += 1;
        if (result.published) published += 1;
        states.set(result.exitState, (states.get(result.exitState) ?? 0) + 1);
        levels.set(result.level, (levels.get(result.level) ?? 0) + 1);
        batch.push({
          tconst: row.tconst,
          tmdbId: row.raw?.tmdbId ?? null,
          stage: 'written',
          outcome: result.published ? 'ok' : 'skipped',
          reasons: result.reasons,
          rank: row.popularity_rank,
        });
      } catch (error) {
        failed += 1;
        batch.push({
          tconst: row.tconst,
          stage: 'written',
          outcome: 'write_failed',
          reasons: [String(error?.message ?? error)],
          rank: row.popularity_rank,
        });
        if (failed <= 3) console.error(`  ${row.tconst}: ${error.message}`);
      }
      if (batch.length >= BATCH) await flush();
    }
    await flush();

    console.log(`\nПрогон #${runId}: записано ${written} за ${Math.round((Date.now() - started) / 1000)} с, `
      + `ошибок ${failed}, опубликовано ${published}`);
    for (const [title, map] of [['состояния выхода', states], ['уровни карточки', levels]]) {
      console.log(`  ${title}:`);
      for (const [key, count] of [...map].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${key}: ${count}`);
      }
    }

    const totals = await pool.query(
      `SELECT
         (SELECT count(*) FROM e_series)::int AS series,
         (SELECT count(*) FROM e_season)::int AS seasons,
         (SELECT count(*) FROM e_episode)::int AS episodes,
         (SELECT count(*) FROM e_release)::int AS releases,
         (SELECT count(*) FROM e_person)::int AS people`,
    );
    const t = totals.rows[0];
    console.log(`  каталог: сериалов ${t.series}, сезонов ${t.seasons}, серий ${t.episodes}, `
      + `выходов ${t.releases}, людей ${t.people}`);
    process.exitCode = failed > written / 2 ? 1 : 0;
  } catch (error) {
    console.error(`\nЗапись каталога не удалась: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();