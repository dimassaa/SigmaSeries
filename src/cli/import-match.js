// Сопоставление кандидатов с TMDB: взять отобранное, найти пары, записать
// исход (F-12-02).
//
//   npm run import:match [-- --limit 50]
//
// Кандидаты берутся из последнего начатого прогона отбора, а не читаются
// заново из датасета: сопоставление идёт по одной позиции, и повторное
// чтение 226 МБ ради тысячи строк было бы лишним. Ключ TMDB обязателен —
// без него сопоставление невозможно, и это лучше сказать сразу, чем после
// тысячи строк «не найдено».
//
// Прогон, оборванный сбоем, продолжается с места: новый прогон не заводится,
// а перебираются только те позиции, что не дошли до своей стадии или упали
// (F-12-09, №95).

import { createPool } from '../db/pool.js';
import { createTmdbClient } from '../services/import/tmdb.js';
import { createImportStore } from '../services/import/store.js';
import { assertNotFrozen } from '../services/import/freeze.js';
import { matchStep, failRun } from '../services/import/steps.js';

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
    throw new Error('не задан TMDB_TOKEN: без ключа сопоставление невозможно');
  }

  const pool = createPool();
  const store = createImportStore(pool);
  // Номер прогона нужен вне блока try: при сбое прогон надо закрыть и
  // сообщить администратору, а он известен только после выбора прогона.
  let runId = null;

  try {
    await assertNotFrozen(pool);
    const pending = await store.pendingCandidates({ limit });
    if (!pending) {
      console.log('Нет ни одного прогона отбора: сначала `npm run import:candidates`');
      process.exitCode = 1;
      return;
    }
    runId = pending.runId;

    // Продолжение: прогон, который вчера оборвался, продолжается с места.
    if (pending.status !== 'success') {
      await store.resumeRun(pending.runId);
      console.log(`Прогон #${pending.runId} продолжается после обрыва.`);
    }

    const tmdb = createTmdbClient({ token: process.env.TMDB_TOKEN });
    const result = await matchStep({
      pool, store, tmdb, runId: pending.runId, limit, log: console.log,
    });
    await store.finishRun(pending.runId, result.status, {
      counters: result.counters,
      checkpoint: result.checkpoint,
    });
    process.exitCode = 0;
  } catch (error) {
    console.error(`\nСопоставление не удалось: ${error.message}`);
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
