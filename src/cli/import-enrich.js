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

import path from 'node:path';

import { createPool } from '../db/pool.js';
import { ensureDataset, DATASETS } from '../services/import/datasets.js';
import { createTmdbClient, isKeyRejected } from '../services/import/tmdb.js';
import { enrichAll, itemsFromEnrichment } from '../services/import/enrich.js';
import { collectPeople, collectGenres } from '../services/import/people.js';
import { createImportStore } from '../services/import/store.js';
import { assertNotFrozen } from '../services/import/freeze.js';
import { notifyAdmins } from '../services/import/notify.js';
import { IMPORT_SETTINGS } from '../config/settings.js';

const DATA_DIR = process.env.IMDB_DATA_DIR ?? path.resolve('data/imdb');

function parseArgs(argv) {
  const args = { limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1]);
  }
  return args;
}

const mb = (n) => `${(n / 1048576).toFixed(0)} МБ`;

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

    const tconsts = matched.rows.map((row) => row.tconst);

    console.log('Скачиваю датасеты людей…');
    for (const key of ['crew', 'principals', 'names']) {
      const file = await ensureDataset({
        key,
        dir: DATA_DIR,
        maxBytes: IMPORT_SETTINGS.downloadMaxMb * 1024 * 1024,
        timeoutMs: IMPORT_SETTINGS.downloadTimeoutMs,
        attempts: IMPORT_SETTINGS.downloadAttempts,
        freshDays: IMPORT_SETTINGS.downloadFreshDays,
      });
      console.log(`  ${DATASETS[key].file} — ${file.reused ? 'свежий' : `скачан, ${mb(file.bytes)}`}`);
    }

    console.log(`Собираю режиссёров и «В ролях» для ${tconsts.length} сериалов…`);
    const startedPeople = Date.now();
    const people = await collectPeople({ tconsts, dataDir: DATA_DIR });
    const withCast = [...people.values()].filter((entry) => entry.cast.length).length;
    console.log(`  готово за ${Math.round((Date.now() - startedPeople) / 1000)} с, «В ролях» есть у ${withCast}`);

    console.log('Читаю жанры из IMDb…');
    const startedGenres = Date.now();
    const genres = await collectGenres({ tconsts, dataDir: DATA_DIR });
    const withGenres = [...genres.values()].filter((list) => list.length).length;
    console.log(`  готово за ${Math.round((Date.now() - startedGenres) / 1000)} с, жанры есть у ${withGenres}`);

    console.log('Обхожу TMDB…');
    const tmdb = createTmdbClient({ token: process.env.TMDB_TOKEN });
    const started = Date.now();

    // Список целей и список результатов идут по одному индексу, поэтому
    // тащить tconst дальше отдельным поиском незачем.
    const targets = matched.rows
      .filter((row) => row.tmdb_id !== null)
      .map((row) => ({
        tconst: row.tconst,
        tmdbId: row.tmdb_id,
        rank: row.popularity_rank,
        imdb: {
          tconst: row.tconst,
          startYear: row.start_year,
          numVotes: row.num_votes,
          averageRating: row.average_rating,
          // Жанры берутся из IMDb (DATA-SOURCES §2), а не из TMDB: справочник
          // строится на именах IMDb, и без них F-12-06 записал бы `no_genre`
          // каждому сериалу подряд.
          genres: genres.get(row.tconst) ?? [],
        },
      }));

    const enriched = await enrichAll({ items: targets, tmdb });

    const { items, failed, errors } = itemsFromEnrichment({
      results: enriched,
      targets,
      people,
    });

    await store.saveItems(matched.runId, [...items, ...failed]);

    const seconds = Math.round((Date.now() - started) / 1000);
    // Размыкатель открыт — прогон не чистый, и молча закрыть его как успешный
    // значило бы потерять это в отчёте (F-12-09 §3).
    // Счётчики — по всему прогону, а не по текущей попытке: прогон мог быть
    // продолжен после обрыва, и отчёт обязан показать весь объём работы.
    const progress = await store.progress(matched.runId);
    const counters = {
      enriched: progress.counts.ok ?? 0,
      errors: progress.failed,
      skipped_no_pair: progress.withoutPair,
      total: progress.total,
      seconds,
    };
    // Контрольная точка: до какой стадии доведены позиции. По ней видно, где
    // прогон остановился, и с чего его продолжать (F-12-09, №95).
    const checkpoint = { stage: 'enriched', processed: progress.done, planned: progress.total };
    if (tmdb.breakerTripped) {
      await store.finishRun(matched.runId, 'partial', { counters, checkpoint });
      console.log(`\nПрогон #${matched.runId} частичный: размыкатель открыт после ${tmdb.breakerPauses} пауз`);
      // Источник перестал отвечать: администратор должен узнать об этом без
      // запроса в консоль (F-12-09 §17, №94).
      await notifyAdmins({
        pool,
        kind: 'import_partial',
        params: {
          runId: matched.runId,
          done: progress.done,
          total: progress.total,
        },
        dedupKey: `import-partial:${matched.runId}`,
      });
    } else {
      await store.finishRun(matched.runId, 'success', { counters, checkpoint });
      console.log(`\nПрогон #${matched.runId}: обогащено ${items.length} за ${seconds} с, ошибок ${errors.length}`);
    }
    // Пропущенные позиции считаются отдельно от ошибок: «уже обогащено ранее»
    // и «упало при обогащении» — разные вещи, а в отчёте они выглядели
    // одинаково (№88).
    const skipped = matched.rows.length - targets.length;
    if (skipped > 0) console.log(`  без подтверждённой пары, пропущено: ${skipped}`);
    if (errors.length) {
      const reasons = new Map();
      for (const { message } of errors) {
        const key = message.replace(/tt\d+/, 'tt…').slice(0, 80);
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
      console.log(`  ошибок: ${errors.length}, причины:`);
      for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        console.log(`    ${count}× ${reason}`);
      }
    }
    const sample = items[0]?.raw;
    if (sample) {
      console.log(`  пример: «${sample.titles.ru.text || sample.titles.original.text}» — `
        + `${sample.seasons.length} сезонов, `
        + `${sample.seasons.reduce((sum, s) => sum + s.episodes.length, 0)} серий, `
        + `людей ${sample.people.directors.length + sample.people.cast.length}`);
    }
    process.exitCode = errors.length > items.length / 2 ? 1 : 0;
  } catch (error) {
    console.error(`\nОбогащение не удалось: ${error.message}`);
    process.exitCode = 1;
    // Прогон закрывается ошибкой: иначе он навсегда остался бы «идущим», и
    // отчёт показывал бы незавершённый прогон (F-12-09 §3).
    if (runId) await store.finishRun(runId, 'error').catch(() => {});
    // 401 — ключ отклонили: без уведомления администратор узнал бы об этом
    // только из журнала процесса, которого к тому времени уже нет (§17, №94).
    if (isKeyRejected(error) && runId) {
      await notifyAdmins({
        pool,
        kind: 'import_key_rejected',
        // В параметры — только числа: текст собирается при чтении на языке
        // читателя (R-I18N-14), и русская причина из журнала туда попасть не
        // должна.
        params: { runId },
        dedupKey: `import-key-rejected:${runId}`,
      }).catch(() => {});
    }
  } finally {
    await pool.end();
  }
}

await main();