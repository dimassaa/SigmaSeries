// Запись каталога: сырой слой → строки базы (F-12-06).
//
//   npm run import:catalogue [-- --limit 50]
//
// У каждого сериала своя транзакция: сбой одного не должен уносить остальных
// (F-12-06 §5), поэтому общей транзакции на прогон здесь нет и быть не может.

import { createPool } from '../db/pool.js';
import { createImportStore } from '../services/import/store.js';
import { catalogueStep } from '../services/import/steps.js';

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

async function main() {
  const { limit } = parseArgs(process.argv.slice(2));
  if (!process.env.PGHOST && !process.env.DATABASE_URL) {
    throw new Error('не задано подключение к базе: нужны PGHOST/PGUSER/PGDATABASE или DATABASE_URL');
  }

  const pool = createPool();
  const store = createImportStore(pool);

  try {
    const { rows: runs } = await pool.query(
      // Как и в обогащении: новинки лежат в прогоне другого вида.
      `SELECT id FROM e_import_run WHERE status = 'success' ORDER BY id DESC LIMIT 1`,
    );
    if (!runs.length) {
      console.log('Нет успешного прогона: сначала `npm run import:candidates`');
      process.exitCode = 1;
      return;
    }
    const runId = runs[0].id;

    const result = await catalogueStep({ pool, store, runId, limit, log: console.log });
    if (result.skipped) {
      process.exitCode = 1;
      return;
    }
    // Статус прогона не меняется: он закрыт обогащением, а запись в каталог —
    // это работа внутри того же прогона. Счётчики прогону дописываются.
    await store.updateRun(runId, { counters: result.counters, checkpoint: result.checkpoint });

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
    process.exitCode = result.counters.failed > result.counters.written / 2 ? 1 : 0;
  } catch (error) {
    console.error(`\nЗапись каталога не удалась: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();
