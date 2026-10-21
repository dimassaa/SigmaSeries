// Отбор кандидатов в каталог: скачать датасеты, отобрать тысячу, записать
// результат прогона (F-12-01).
//
// Запуск идёт как `full_run` с флагом `dry_run`: полный прогон — это все
// стадии, а здесь пока только первая, и в каталог не пишется ничего. Сами
// результаты отбора при этом записываются — иначе S-76 (F-12-08) нечего
// было бы показать, а приёмке нечего было бы проверять.
//
//   npm run import:candidates
//
// Переменные окружения: PG* для базы, IMDB_DATA_DIR для датасетов
// (по умолчанию data/imdb).

import { createPool } from '../db/pool.js';
import { createImportStore } from '../services/import/store.js';
import { assertNotFrozen } from '../services/import/freeze.js';
import { candidatesStep, DATA_DIR } from '../services/import/steps.js';
import { IMPORT_SETTINGS } from '../config/settings.js';

/** Разбор аргументов: пока только --top-n, чтобы можно было урезать прогон. */
function parseArgs(argv) {
  const args = { topN: IMPORT_SETTINGS.topN };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--top-n') args.topN = Number(argv[i + 1]);
  }
  return args;
}

async function main() {
  const { topN } = parseArgs(process.argv.slice(2));
  let pool = null;
  let store = null;
  let runId;

  try {
    await assertNotFrozen(pool);
    if (!process.env.PGHOST && !process.env.DATABASE_URL) {
      throw new Error('не задано подключение к базе: нужны PGHOST/PGUSER/PGDATABASE или DATABASE_URL');
    }

    pool = createPool();
    store = createImportStore(pool);

    runId = await store.startRun('full_run', { dryRun: true });
    const result = await candidatesStep({
      store, runId, topN, dataDir: DATA_DIR, log: console.log,
    });
    await store.finishRun(runId, result.status, {
      counters: result.counters,
      checkpoint: result.checkpoint,
    });
    process.exitCode = 0;
  } catch (error) {
    // Прогон без результата тоже оставляет след: иначе в S-76 будет тишина,
    // и неизвестно, был ли запуск вовсе (F-12-09, §5 «запуск завершается ошибкой»).
    if (runId && store) await store.finishRun(runId, 'error').catch(() => {});
    console.error(`\nИмпорт не удался: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}

await main();
