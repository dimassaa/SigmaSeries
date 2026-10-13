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

import path from 'node:path';

import { createPool } from '../db/pool.js';
import { ensureDataset } from '../services/import/datasets.js';
import { selectFromDatasets } from '../services/import/imdb.js';
import { createImportStore } from '../services/import/store.js';
import { IMPORT_SETTINGS, EXCLUDED_GENRES_IMDB } from '../config/settings.js';

const DATA_DIR = process.env.IMDB_DATA_DIR ?? path.resolve('data/imdb');

/** Разбор аргументов: пока только --top-n, чтобы можно было урезать прогон. */
function parseArgs(argv) {
  const args = { topN: IMPORT_SETTINGS.topN, dryRun: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--top-n') args.topN = Number(argv[i + 1]);
  }
  return args;
}

const bytes = (n) => `${(n / 1048576).toFixed(1)} МБ`;

async function main() {
  const { topN } = parseArgs(process.argv.slice(2));
  if (!process.env.PGHOST && !process.env.DATABASE_URL) {
    throw new Error('не задано подключение к базе: нужны PGHOST/PGUSER/PGDATABASE или DATABASE_URL');
  }

  const pool = createPool();
  const store = createImportStore(pool);
  let runId;

  try {
    console.log('Скачиваю датасеты IMDb…');
    const basics = await ensureDataset({
      key: 'basics',
      dir: DATA_DIR,
      maxBytes: IMPORT_SETTINGS.downloadMaxMb * 1024 * 1024,
      timeoutMs: IMPORT_SETTINGS.downloadTimeoutMs,
      attempts: IMPORT_SETTINGS.downloadAttempts,
      freshDays: IMPORT_SETTINGS.downloadFreshDays,
    });
    const ratings = await ensureDataset({
      key: 'ratings',
      dir: DATA_DIR,
      maxBytes: IMPORT_SETTINGS.downloadMaxMb * 1024 * 1024,
      timeoutMs: IMPORT_SETTINGS.downloadTimeoutMs,
      attempts: IMPORT_SETTINGS.downloadAttempts,
      freshDays: IMPORT_SETTINGS.downloadFreshDays,
    });
    console.log(
      `  ${path.basename(basics.path)} — ${basics.reused ? 'свежий' : `скачан, ${bytes(basics.bytes)}`}`
      + ` · ${path.basename(ratings.path)} — ${ratings.reused ? 'свежий' : `скачан, ${bytes(ratings.bytes)}`}`,
    );

    const started = Date.now();
    console.log('Отбираю кандидатов…');
    const { items, counters, stats } = await selectFromDatasets({
      basicsPath: basics.path,
      ratingsPath: ratings.path,
      topN,
      excludedGenres: EXCLUDED_GENRES_IMDB,
    });

    runId = await store.startRun('full_run', { dryRun: true });
    await store.saveItems(runId, items.map((item) => ({
      tconst: item.tconst,
      stage: 'candidates',
      outcome: 'ok',
      rank: item.rank,
      numVotes: item.numVotes,
      averageRating: item.averageRating,
    })));
    await store.finishRun(runId, 'success');

    console.log(`\nПрогон #${runId}: отобрано ${items.length} из ${counters.lines} строк за ${Date.now() - started} мс`);
    console.log(
      `  отсеяно: тип ${counters.wrongType}, 18+ ${counters.adult},`
      + ` жанры ${counters.excludedGenre}, без жанров ${counters.noGenres}, без рейтинга ${counters.noRating}`,
    );
    console.log(`  не разобрано строк: базовый ${stats.basics.skipped}, рейтинги ${stats.ratings.skipped}`);
    console.log('\nПервые десять:');
    for (const item of items.slice(0, 10)) {
      console.log(
        `  ${String(item.rank).padStart(4)}. ${item.title} (${item.startYear ?? '—'})`
        + ` — ${item.averageRating} при ${item.numVotes} голосах`,
      );
    }
    process.exitCode = 0;
  } catch (error) {
    // Прогон без результата тоже оставляет след: иначе в S-76 будет тишина,
    // и неизвестно, был ли запуск вовсе (F-12-09, §5 «запуск завершается ошибкой»).
    if (runId) await store.finishRun(runId, 'error').catch(() => {});
    console.error(`\nИмпорт не удался: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();