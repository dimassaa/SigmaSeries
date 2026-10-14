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
import { createTmdbClient } from '../services/import/tmdb.js';
import { enrichAll } from '../services/import/enrich.js';
import { collectPeople, collectGenres } from '../services/import/people.js';
import { createImportStore } from '../services/import/store.js';
import { IMPORT_SETTINGS } from '../config/settings.js';

const DATA_DIR = process.env.IMDB_DATA_DIR ?? path.resolve('data/imdb');

function parseArgs(argv) {
  const args = { limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1]);
  }
  return args;
}

/** Подтверждённые пары последнего прогона: сопоставлять больше нечего. */
async function matchedSeries(pool, args) {
  const { rows: runs } = await pool.query(
    // Последний успешный запуск ЛЮБОГО вида: новинки приходят прогоном
    // `discover_sync`, и если смотреть только на `full_run`, обогащение их
    // просто не увидит.
    `SELECT id FROM e_import_run
      WHERE status = 'success'
      ORDER BY id DESC LIMIT 1`,
  );
  if (!runs.length) return null;

  const limit = args.limit;
  if (!Number.isFinite(limit) || limit < 0) throw new Error(`--limit должен быть числом, получено «${args.limit}»`);

  // Отбираются ВСЕ строки с подтверждённой парой, а не только те, что ещё не
  // обогащены. Иначе прогон нельзя переиграть: после записи в каталог стадия
  // становится `written`, и повторное обогащение молча нашло бы ноль позиций —
  // а новые сезоны и даты как раз и требуют повторного обогащения.
  const { rows } = await pool.query(
    `SELECT tconst, tmdb_id, popularity_rank, start_year, num_votes, average_rating
       FROM e_import_item_result
      WHERE run_id = $1 AND tmdb_id IS NOT NULL
      ORDER BY popularity_rank
      ${limit > 0 ? `LIMIT ${Math.floor(limit)}` : ''}`,
    [runs[0].id],
  );
  return { runId: runs[0].id, rows };
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

  try {
    const matched = await matchedSeries(pool, { limit });
    if (!matched) {
      console.log('Нет успешного прогона: сначала `npm run import:candidates` и `npm run import:match`');
      process.exitCode = 1;
      return;
    }
    if (!matched.rows.length) {
      console.log('Подтверждённых пар нет: запустите `npm run import:match`');
      process.exitCode = 1;
      return;
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

    const items = [];
    const errors = [];
    enriched.forEach((entry, index) => {
      const target = targets[index];
      if (!entry.raw) {
        // Причина ошибки обязана быть видна: «224 ошибки» без текста —
        // это не диагностика, а число, которое придётся выяснять заново.
        errors.push({ tconst: target.tconst, message: entry.error });
        return;
      }
      items.push({
        tconst: target.tconst,
        tmdbId: target.tmdbId,
        stage: 'enriched',
        outcome: 'ok',
        rank: target.rank,
        raw: { ...entry.raw, people: people.get(target.tconst) ?? { directors: [], cast: [] } },
      });
    });

    await store.saveItems(matched.runId, items);

    const seconds = Math.round((Date.now() - started) / 1000);
    const { rows: counts } = await pool.query(
      'SELECT count(*)::int AS n FROM e_import_item_result WHERE run_id = $1 AND tmdb_id IS NOT NULL',
      [matched.runId],
    );
    console.log(`\nПрогон #${matched.runId}: обогащено ${items.length} за ${seconds} с, ошибок ${errors.length}`);
    // Подтверждённые пары, обогащённые прошлым прогоном, пропускаются. Молча
    // пропущенные позиции выглядят так, будто часть каталога потерялась.
    const skipped = counts[0].n - targets.length;
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
  } finally {
    await pool.end();
  }
}

await main();