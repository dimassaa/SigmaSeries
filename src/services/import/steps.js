// Шаги импорта: отбор кандидатов, сопоставление, обогащение, запись в каталог
// (F-12-01…F-12-06).
//
// Оркестрация живёт здесь, а не в командах `npm run import:*`: полный прогон
// по кнопке (S-76, F-12-08) и команды должны вести одну и ту же работу. Две
// реализации одного прогона разошлись бы в отчёте, а отчёт — это то, ради
// чего прогон и делается.
//
// Каждый шаг работает с заданным прогоном (`runId`) и ничего не закрывает:
// статус и счётчики прогону ставит вызывающий — команда или задача
// планировщика. Исключение — запись в каталог: сухой прогон не пишет в
// каталог, и запрет задан флагом самой строки прогона, а не переданным
// параметром (F-12-08 §6).

import path from 'node:path';

import { ensureDataset, DATASETS } from './datasets.js';
import { selectFromDatasets } from './imdb.js';
import { matchCandidates } from './match.js';
import { enrichAll, itemsFromEnrichment } from './enrich.js';
import { collectPeople, collectGenres } from './people.js';
import { writeSeries, loadSlugs, genresFor } from './write.js';
import { computeExitState, computeCompleteness, carryOverReasons, levelOf } from './catalogue.js';
import { isKeyRejected } from './tmdb.js';
import { notifyAdmins } from './notify.js';
import { IMPORT_SETTINGS, EXCLUDED_GENRES_IMDB } from '../../config/settings.js';

/** Каталог с датасетами IMDb: то же место, что и у команд импорта. */
export const DATA_DIR = process.env.IMDB_DATA_DIR ?? path.resolve('data/imdb');

/** Сколько результатов копится перед одной записью в прогон. */
const BATCH = 200;

const mb = (n) => `${(n / 1048576).toFixed(0)} МБ`;

/** Параметры загрузки датасета — одинаковые для всех шагов. */
function datasetOptions(key, dir) {
  return {
    key,
    dir,
    maxBytes: IMPORT_SETTINGS.downloadMaxMb * 1024 * 1024,
    timeoutMs: IMPORT_SETTINGS.downloadTimeoutMs,
    attempts: IMPORT_SETTINGS.downloadAttempts,
    freshDays: IMPORT_SETTINGS.downloadFreshDays,
  };
}

/**
 * Отбор кандидатов из датасетов IMDb (F-12-01).
 *
 * Шаг ничего не пишет в каталог: он только набирает позиции и кладёт их в
 * прогон, чтобы S-76 было что показывать.
 *
 * @param {object} deps
 * @param {object} deps.store хранилище прогонов
 * @param {number} deps.runId прогон, в который пишутся позиции
 * @param {number} [deps.topN] сколько позиций отобрать
 * @param {string} [deps.dataDir] каталог с датасетами
 * @param {(line: string) => void} [deps.log]
 * @returns {Promise<{status: string, counters: object, checkpoint: object}>}
 */
export async function candidatesStep({
  store, runId, topN = IMPORT_SETTINGS.topN, dataDir = DATA_DIR, log = () => {},
}) {
  log('Скачиваю датасеты IMDb…');
  const basics = await ensureDataset(datasetOptions('basics', dataDir));
  const ratings = await ensureDataset(datasetOptions('ratings', dataDir));
  log(
    `  ${path.basename(basics.path)} — ${basics.reused ? 'свежий' : `скачан, ${mb(basics.bytes)}`}`
    + ` · ${path.basename(ratings.path)} — ${ratings.reused ? 'свежий' : `скачан, ${mb(ratings.bytes)}`}`,
  );

  const started = Date.now();
  log('Отбираю кандидатов…');
  const { items, counters, stats } = await selectFromDatasets({
    basicsPath: basics.path,
    ratingsPath: ratings.path,
    topN,
    excludedGenres: EXCLUDED_GENRES_IMDB,
  });

  await store.saveItems(runId, items.map((item) => ({
    tconst: item.tconst,
    stage: 'candidates',
    outcome: 'ok',
    rank: item.rank,
    numVotes: item.numVotes,
    averageRating: item.averageRating,
    startYear: item.startYear,
  })));

  const seconds = Math.round((Date.now() - started) / 1000);
  const progress = await store.progress(runId);
  log(`Отобрано ${items.length} из ${counters.lines} строк за ${seconds} с`);
  log(
    `  отсеяно: тип ${counters.wrongType}, 18+ ${counters.adult},`
    + ` жанры ${counters.excludedGenre}, без жанров ${counters.noGenres}, без рейтинга ${counters.noRating}`,
  );
  log(`  не разобрано строк: базовый ${stats.basics.skipped}, рейтинги ${stats.ratings.skipped}`);
  if (items.length) {
    log('Первые десять:');
    for (const item of items.slice(0, 10)) {
      log(
        `  ${String(item.rank).padStart(4)}. ${item.title} (${item.startYear ?? '—'})`
        + ` — ${item.averageRating} при ${item.numVotes} голосах`,
      );
    }
  }

  return {
    status: 'success',
    counters: { selected: items.length, total: progress.total, seconds },
    checkpoint: { stage: 'candidates', processed: progress.done, planned: progress.total },
  };
}

/**
 * Сопоставление кандидатов с TMDB (F-12-02).
 *
 * @param {object} deps
 * @param {object} deps.pool
 * @param {object} deps.store хранилище прогонов
 * @param {object} deps.tmdb клиент TMDB
 * @param {number} deps.runId прогон, который обрабатывается
 * @param {number} [deps.limit] сколько позиций взять; 0 — все
 * @param {(line: string) => void} [deps.log]
 * @returns {Promise<{status: string, counters: object, checkpoint: object|null, skipped: boolean, reason: string|null}>}
 */
export async function matchStep({ pool, store, tmdb, runId, limit = 0, log = () => {} }) {
  const pending = await store.pendingCandidates({ limit, runId });
  if (!pending) {
    log('Нет ни одного прогона отбора: сначала `npm run import:candidates`');
    return { status: 'success', counters: { total: 0, seconds: 0 }, checkpoint: null, skipped: true, reason: 'no_run' };
  }
  if (!pending.items.length) {
    log('Все кандидаты уже сопоставлены');
    return { status: 'success', counters: { total: 0, seconds: 0 }, checkpoint: null, skipped: true, reason: 'nothing_pending' };
  }

  const started = Date.now();
  log(`Прогон #${pending.runId}: сопоставляю ${pending.items.length} позиций…`);

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
  const seconds = Math.round((Date.now() - started) / 1000);
  // Счётчики и контрольная точка считаются по всему прогону, а не по текущей
  // попытке: прогон мог быть продолжен после обрыва, и отчёт обязан показать
  // весь объём работы (F-12-09, №68, №102).
  const progress = await store.progress(pending.runId);
  const counters = {
    matched: progress.counts.ok ?? 0,
    no_tmdb: progress.counts.no_tmdb ?? 0,
    pair_doubt: progress.counts.pair_doubt ?? 0,
    error: progress.failed,
    total: progress.total,
    seconds,
  };
  const checkpoint = { stage: 'matched', processed: progress.total, planned: progress.total };

  let status = 'success';
  if (tmdb.breakerTripped) {
    status = 'partial';
    log(`Прогон #${pending.runId} частичный: размыкатель открыт после ${tmdb.breakerPauses} пауз`);
    // Источник перестал отвечать: администратор должен узнать об этом без
    // запроса в консоль (F-12-09 §17, №94).
    await notifyAdmins({
      pool,
      kind: 'import_partial',
      params: { runId: pending.runId, done: progress.done, total: progress.total },
      dedupKey: `import-partial:${pending.runId}`,
    });
  }

  log(`Готово за ${seconds} с:`);
  for (const [outcome, count] of [...tally].sort((a, b) => b[1] - a[1])) {
    log(`  ${outcome}: ${count}`);
  }
  const doubtful = results.filter((r) => r.outcome === 'pair_doubt');
  if (doubtful.length) {
    log(`Сомнительные пары, первые десять из ${doubtful.length}:`);
    for (const r of doubtful.slice(0, 10)) log(`  ${r.tconst} — ${r.reasons.join(', ')}`);
  }
  const failed = results.filter((r) => r.outcome === 'error');
  if (failed.length) {
    log(`Ошибки API, первые пять из ${failed.length}:`);
    for (const r of failed.slice(0, 5)) log(`  ${r.tconst} — ${r.reasons.join(', ')}`);
  }

  return { status, counters, checkpoint, skipped: false, reason: null };
}

/**
 * Обогащение из TMDB и IMDb (F-12-03).
 *
 * @param {object} deps
 * @param {object} deps.pool
 * @param {object} deps.store хранилище прогонов
 * @param {object} deps.tmdb клиент TMDB
 * @param {number} deps.runId прогон, который обрабатывается
 * @param {number} [deps.limit] сколько позиций взять; 0 — все
 * @param {string} [deps.dataDir] каталог с датасетами
 * @param {(line: string) => void} [deps.log]
 * @returns {Promise<{status: string, counters: object, checkpoint: object|null, skipped: boolean, reason: string|null}>}
 */
export async function enrichStep({
  pool, store, tmdb, runId, limit = 0, dataDir = DATA_DIR, log = () => {},
}) {
  const matched = await store.matchedSeries({ limit, runId });
  if (!matched) {
    log('Нет прогона с сопоставленными позициями: сначала `npm run import:candidates` и `npm run import:match`');
    return { status: 'success', counters: { total: 0, seconds: 0 }, checkpoint: null, skipped: true, reason: 'no_run' };
  }
  if (!matched.rows.length) {
    log('Подтверждённых пар нет: запустите `npm run import:match`');
    return { status: 'success', counters: { total: 0, seconds: 0 }, checkpoint: null, skipped: true, reason: 'no_pairs' };
  }

  const tconsts = matched.rows.map((row) => row.tconst);

  log('Скачиваю датасеты людей…');
  for (const key of ['crew', 'principals', 'names']) {
    const file = await ensureDataset(datasetOptions(key, dataDir));
    log(`  ${DATASETS[key].file} — ${file.reused ? 'свежий' : `скачан, ${mb(file.bytes)}`}`);
  }

  log(`Собираю режиссёров и «В ролях» для ${tconsts.length} сериалов…`);
  const startedPeople = Date.now();
  const people = await collectPeople({ tconsts, dataDir });
  const withCast = [...people.values()].filter((entry) => entry.cast.length).length;
  log(`  готово за ${Math.round((Date.now() - startedPeople) / 1000)} с, «В ролях» есть у ${withCast}`);

  log('Читаю жанры из IMDb…');
  const startedGenres = Date.now();
  const genres = await collectGenres({ tconsts, dataDir });
  const withGenres = [...genres.values()].filter((list) => list.length).length;
  log(`  готово за ${Math.round((Date.now() - startedGenres) / 1000)} с, жанры есть у ${withGenres}`);

  log('Обхожу TMDB…');
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
  const { items, failed, errors } = itemsFromEnrichment({ results: enriched, targets, people });

  await store.saveItems(matched.runId, [...items, ...failed]);

  const seconds = Math.round((Date.now() - started) / 1000);
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
  const checkpoint = { stage: 'enriched', processed: progress.done, planned: progress.total };

  let status = 'success';
  if (tmdb.breakerTripped) {
    status = 'partial';
    log(`Прогон #${matched.runId} частичный: размыкатель открыт после ${tmdb.breakerPauses} пауз`);
    await notifyAdmins({
      pool,
      kind: 'import_partial',
      params: { runId: matched.runId, done: progress.done, total: progress.total },
      dedupKey: `import-partial:${matched.runId}`,
    });
  } else {
    log(`Прогон #${matched.runId}: обогащено ${items.length} за ${seconds} с, ошибок ${errors.length}`);
  }

  // Пропущенные позиции считаются отдельно от ошибок: «уже обогащено ранее»
  // и «упало при обогащении» — разные вещи, а в отчёте они выглядели
  // одинаково (№88).
  const skipped = matched.rows.length - targets.length;
  if (skipped > 0) log(`  без подтверждённой пары, пропущено: ${skipped}`);
  if (errors.length) {
    const reasons = new Map();
    for (const { message } of errors) {
      const key = message.replace(/tt\d+/, 'tt…').slice(0, 80);
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    log(`  ошибок: ${errors.length}, причины:`);
    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      log(`    ${count}× ${reason}`);
    }
  }
  const sample = items[0]?.raw;
  if (sample) {
    log(`  пример: «${sample.titles.ru.text || sample.titles.original.text}» — `
      + `${sample.seasons.length} сезонов, `
      + `${sample.seasons.reduce((sum, s) => sum + s.episodes.length, 0)} серий, `
      + `людей ${sample.people.directors.length + sample.people.cast.length}`);
  }

  return { status, counters, checkpoint, skipped: false, reason: null, errors: errors.length, enriched: items.length };
}

/**
 * Запись сырого слоя в каталог (F-12-06).
 *
 * У каждого сериала своя транзакция: сбой одного не должен уносить остальных
 * (F-12-06 §5), поэтому общей транзакции на прогон здесь нет и быть не может.
 *
 * Сухой прогон в каталог не пишет: он считает, что изменилось бы, и оставляет
 * это в отчёте (F-12-08 §6). Запрет задан флагом строки прогона.
 *
 * @param {object} deps
 * @param {object} deps.pool
 * @param {object} deps.store хранилище прогонов
 * @param {number} deps.runId прогон, который записывается
 * @param {number} [deps.limit] сколько позиций взять; 0 — все
 * @param {Date} [deps.now]
 * @param {(line: string) => void} [deps.log]
 * @returns {Promise<{status: string, counters: object, checkpoint: object|null, skipped: boolean, reason: string|null}>}
 */
export async function catalogueStep({
  pool, store, runId, limit = 0, now = new Date(), log = () => {},
}) {
  const rows = await enrichedRows(pool, runId, limit);
  if (!rows.length) {
    log('Обогащённых сериалов нет: запустите `npm run import:enrich`');
    return { status: 'success', counters: { total: 0, seconds: 0 }, checkpoint: null, skipped: true, reason: 'nothing_enriched' };
  }

  const { dryRun } = await store.runFlags(runId);
  if (dryRun) {
    const result = await dryCatalogue({ pool, store, runId, rows, now, log });
    return { ...result, status: 'success' };
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
      if (failed <= 3) log(`  ${row.tconst}: ${error.message}`);
    }
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  const seconds = Math.round((Date.now() - started) / 1000);
  log(`Прогон #${runId}: записано ${written} за ${seconds} с, ошибок ${failed}, опубликовано ${published}`);
  for (const [title, map] of [['состояния выхода', states], ['уровни карточки', levels]]) {
    log(`  ${title}:`);
    for (const [key, count] of [...map].sort((a, b) => b[1] - a[1])) log(`    ${key}: ${count}`);
  }

  const progress = await store.progress(runId);
  return {
    status: 'success',
    counters: {
      written,
      published,
      failed,
      total: progress.total,
      seconds,
    },
    checkpoint: { stage: 'written', processed: progress.done, planned: progress.total },
    skipped: false,
    reason: null,
  };
}

/**
 * Сухой прогон записи: что изменилось бы, если бы каталог трогать можно было.
 *
 * Считаются те же величины, что и при записи, — состояние выхода, уровень
 * карточки и публикация, — но ничего не пишется: сравнение идёт с тем, что
 * лежит в базе сейчас.
 *
 * @param {object} deps
 * @param {object} deps.pool
 * @param {object} deps.store
 * @param {number} deps.runId
 * @param {object[]} deps.rows обогащённые позиции прогона
 * @param {Date} deps.now
 * @param {(line: string) => void} deps.log
 * @returns {Promise<{counters: object, checkpoint: object|null, skipped: boolean, reason: string|null}>}
 */
async function dryCatalogue({ pool, store, runId, rows, now, log }) {
  const keys = rows.map((row) => row.tconst);
  const [{ rows: known }, { rows: pictures }] = await Promise.all([
    pool.query(
      `SELECT imdb_key, exit_state, level, publication_state, reasons
         FROM e_series WHERE imdb_key = ANY($1::text[])`,
      [keys],
    ),
    pool.query(
      `SELECT s.imdb_key, i.role
         FROM e_image i JOIN e_series s ON s.id = i.series_id
        WHERE s.imdb_key = ANY($1::text[]) AND i.role IN ('poster','backdrop')`,
      [keys],
    ),
  ]);

  const existing = new Map(known.map((row) => [row.imdb_key, row]));
  const roles = new Map();
  for (const row of pictures) {
    if (!roles.has(row.imdb_key)) roles.set(row.imdb_key, new Set());
    roles.get(row.imdb_key).add(row.role);
  }

  const batch = [];
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const states = new Map();
  const levels = new Map();

  for (const row of rows) {
    const raw = row.raw;
    const found = existing.get(row.tconst) ?? null;
    const images = {
      poster: roles.get(row.tconst)?.has('poster') ?? false,
      backdrop: roles.get(row.tconst)?.has('backdrop') ?? false,
    };
    const exitState = computeExitState({ raw, today: now });
    const computed = computeCompleteness({ raw, images, now });
    const reasons = carryOverReasons(computed.reasons, found?.reasons ?? [], []);
    const level = levelOf(reasons);
    const publishable = Boolean(
      (raw?.titles?.original?.text || raw?.titles?.ru?.text)
      && raw?.years?.start
      && genresFor(raw).length,
    );

    let outcome = 'unchanged';
    if (!found) {
      added += 1;
      outcome = 'added';
    } else if (found.exit_state !== exitState || found.level !== level
      || found.publication_state !== (publishable ? 'published' : 'imported')) {
      updated += 1;
      outcome = 'updated';
    } else {
      unchanged += 1;
    }
    states.set(exitState, (states.get(exitState) ?? 0) + 1);
    levels.set(level, (levels.get(level) ?? 0) + 1);

    batch.push({
      tconst: row.tconst,
      tmdbId: raw?.tmdbId ?? null,
      stage: 'written',
      outcome: 'skipped',
      reasons: ['dry_run', outcome],
      rank: row.popularity_rank,
    });
    if (batch.length >= BATCH) await store.saveItems(runId, batch.splice(0, batch.length));
  }
  if (batch.length) await store.saveItems(runId, batch.splice(0, batch.length));

  log(`Сухой прогон #${runId}: изменилось бы ${added + updated} из ${rows.length} `
    + `(новых ${added}, обновлено ${updated}, без изменений ${unchanged})`);
  for (const [title, map] of [['состояния выхода', states], ['уровни карточки', levels]]) {
    log(`  ${title}:`);
    for (const [key, count] of [...map].sort((a, b) => b[1] - a[1])) log(`    ${key}: ${count}`);
  }

  const progress = await store.progress(runId);
  return {
    counters: {
      written: 0,
      added,
      updated,
      unchanged,
      failed: 0,
      total: progress.total,
      seconds: 0,
    },
    checkpoint: { stage: 'written', processed: progress.done, planned: progress.total },
    skipped: false,
    reason: null,
  };
}

/**
 * Закрыть прогон ошибкой и сообщить администратору, если отвергли ключ.
 *
 * Ключ TMDB отвергают молча: администратор узнал бы об этом только из журнала
 * процесса, которого к тому времени уже нет (F-12-09 §17, №94).
 *
 * @param {object} deps
 * @param {object} deps.pool
 * @param {object} deps.store
 * @param {number} deps.runId
 * @param {Error} deps.error
 * @returns {Promise<void>}
 */
export async function failRun({ pool, store, runId, error }) {
  if (runId) await store.finishRun(runId, 'error').catch(() => {});
  if (!isKeyRejected(error)) return;
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

/** Обогащённые позиции прогона. */
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
