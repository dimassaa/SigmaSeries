// Обогащение сериалов из TMDB и IMDb (F-12-03).
//
//   npm run import:enrich [-- --limit 20]
//
// Три шага подряд, и порядок не случаен:
//   1. скачиваются датасеты людей (1,1 ГБ) — они нужны все сразу, потому что
//      `title.principals` проходится один раз на весь каталог;
//   2. одним проходом собираются режиссёры и «В ролях» для всех кандидатов;
//   3. обход TMDB: карточка на двух языках и по запросу на каждый сезон.
//
// Сырой слой кладётся в результат прогона (`raw`), и F-12-06 пишет его в
// каталог. Пока F-12-06 не сделан, база остаётся пустой — это осознанно:
// обогащённые данные без записи нигде не видны, но и не теряются.

import { createPool } from '../db/pool.js';
import { createTmdbClient } from '../services/import/tmdb.js';
import { createImportStore } from '../services/import/store.js';
import { assertNotFrozen } from '../services/import/freeze.js';
import { enrichStep, failRun } from '../services/import/steps.js';

function parseArgs(argv) {
  const args = { limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1]);
  }
  return args;
}

async function main() {
  const { limit } = parseArgs(process.argv.slice(2));
  if (!process.env.PGHOST && !process.env.DATABASE_URL) {
    throw new Error('не задано подключение к базе: нужны PGHOST/PGUSER/PGDATABASE или DATABASE_URL');
  }
  if (!process.env.TMDB_TOKEN) {
    throw new Error('не задан TMDB_TOKEN: без ключа обогащение невозможно');
  }

  const pool = createPool();
  const store = createImportStore(pool);
  // Номер прогона нужен вне блока try: при сбое прогон надо закрыть и
  // сообщить администратору, а он известен только после выбора прогона.
  let runId = null;

  try {
    await assertNotFrozen(pool);
    const matched = await store.matchedSeries({ limit });
    if (!matched) {
      console.log('Нет прогона с сопоставленными позициями: сначала `npm run import:candidates` и `npm run import:match`');
      process.exitCode = 1;
      return;
    }
    if (!matched.rows.length) {
      console.log('Подтверждённых пар нет: запустите `npm run import:match`');
      process.exitCode = 1;
      return;
    }
    runId = matched.runId;
    // Продолжение: прогон, который оборвался, продолжается с места — новый
    // прогон не заводится (F-12-09, №95).
    if (matched.status !== 'success') {
      await store.resumeRun(matched.runId);
      console.log(`Прогон #${matched.runId} продолжается после обрыва.`);
    }

    const tmdb = createTmdbClient({ token: process.env.TMDB_TOKEN });
    const result = await enrichStep({
      pool, store, tmdb, runId: matched.runId, limit, log: console.log,
    });
    await store.finishRun(matched.runId, result.status, {
      counters: result.counters,
      checkpoint: result.checkpoint,
    });
    process.exitCode = result.errors > result.enriched / 2 ? 1 : 0;
  } catch (error) {
    console.error(`\nОбогащение не удалось: ${error.message}`);
    process.exitCode = 1;
    // Прогон закрывается ошибкой: иначе он навсегда остался бы «идущим», и
    // отчёт показывал бы незавершённый прогон (F-12-09 §3). Ключ TMDB могли
    // отвергнуть — об этом администратор узнаёт из уведомления, а не из журнала
    // процесса, которого к тому времени уже нет (§17, №94).
    await failRun({ pool, store, runId, error });
  } finally {
    await pool.end();
  }
}

await main();
