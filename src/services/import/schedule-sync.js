// Ночная синхронизация расписания (F-12-07 §4).
//
// Что делает задача: для сериалов, которые ещё не завершены и не отменены,
// перечитываются детали на двух языках и последний сезон, пересчитывается
// состояние выхода, и всё, что сдвинулось, становится событием для календаря.
//
// Три решения, которые видно в коде:
//
//  1. Только последний сезон. Даты старых сезонов у источника не меняются, а
//     обход всех сезонов сериала на десяти сезонах — это десять запросов на
//     сериал вместо одного: ночь растянулась бы с трёх минут на полчаса.
//  2. Люди в ночном прогоне не проверяются — они приходят из датасета IMDb.
//     Причина `no_people` поэтому переносится из прежнего списка, а не
//     добавляется заново, и карточка не падает в «минимум» за одну ночь.
//  3. Перенос даты и появление новой серии — разные события. «Перенесли» и
//     «объявили» в календаре выглядят по-разному, и сваливать их в одно
//     означало бы, что человек не поймёт, что произошло.

import { buildRawSeries } from './enrich.js';
import { writeSeries } from './write.js';

/** Причины полноты, которых ночной прогон не проверяет (см. решение 2). */
export const UNCHECKED = ['no_people'];

/**
 * Номер последнего сезона: наибольший, без спецвыпусков.
 *
 * Порядок в ответе источника не гарантирован, поэтому берётся максимум, а не
 * последний элемент.
 *
 * @param {any} details карточка сериала
 * @returns {number|null}
 */
export function lastSeasonNumber(details) {
  const numbers = (details?.seasons ?? [])
    .map((season) => season?.season_number)
    .filter((number) => Number.isInteger(number) && number > 0);
  return numbers.length ? Math.max(...numbers) : null;
}

/**
 * Сравнивает расписание «до» и «после» и возвращает события.
 *
 * Исчезновение серии событием не считается: источник теряет серии при переезде,
 * и удалять их из каталога по одному ответу — значит терять данные.
 *
 * @param {{before: any, after: any}} input
 * @returns {any[]} события: `postponed`, `advanced`, `announced`, `state_changed`
 */
export function diffSchedule({ before, after }) {
  const changes = [];

  if (before.exitState && after.exitState && before.exitState !== after.exitState) {
    changes.push({ code: 'state_changed', from: before.exitState, to: after.exitState });
  }

  const season = after.season ?? null;
  for (const [episode, date] of Object.entries(after.episodes ?? {})) {
    if (!date) continue;
    const was = before.episodes?.[episode] ?? null;
    if (was === date) continue;
    if (!was) {
      changes.push({ code: 'announced', season, episode: Number(episode), from: null, to: date });
    } else {
      changes.push({
        code: date > was ? 'postponed' : 'advanced',
        season,
        episode: Number(episode),
        from: was,
        to: date,
      });
    }
  }
  return changes;
}

/**
 * Сериалы, которым расписание ещё нужно обновлять.
 *
 * @param {any} pool
 * @param {{limit?: number}} [options]
 * @returns {Promise<{tconst: string, tmdbId: number, yearStart: number|null, genres: string[], imdb: any}[]>}
 */
export async function loadActiveSeries(pool, { limit = null } = {}) {
  const { rows } = await pool.query(
    `SELECT s.id, s.imdb_key, s.tmdb_id, s.year_start, s.exit_state,
            coalesce(r.value, 0)::numeric AS imdb_rating,
            coalesce(r.votes, 0)::int AS imdb_votes,
            (SELECT array_agg(g.code ORDER BY g.code) FROM e_series_genre sg
               JOIN e_genre g ON g.code = sg.genre_code WHERE sg.series_id = s.id) AS genres
       FROM e_series s
       LEFT JOIN e_external_rating r ON r.series_id = s.id AND r.platform = 'imdb'
      WHERE s.exit_state NOT IN ('ended','cancelled')
        AND s.tmdb_id IS NOT NULL AND s.imdb_key IS NOT NULL
      ORDER BY s.exit_state = 'airing' DESC, s.year_start DESC NULLS LAST
      ${limit ? 'LIMIT $1' : ''}`,
    limit ? [limit] : [],
  );

  return rows.map((row) => ({
    seriesId: row.id,
    tconst: row.imdb_key,
    tmdbId: row.tmdb_id,
    yearStart: row.year_start,
    genres: row.genres ?? [],
    imdb: {
      tconst: row.imdb_key,
      startYear: row.year_start,
      genres: row.genres ?? [],
      numVotes: row.imdb_votes || null,
      averageRating: Number(row.imdb_rating) || null,
    },
  }));
}

/** Даты серий последнего сезона из сырого слоя. */
function episodesOf(raw) {
  const season = raw?.seasons?.[raw.seasons.length - 1] ?? null;
  const episodes = {};
  for (const episode of season?.episodes ?? []) {
    if (Number.isInteger(episode.number)) episodes[episode.number] = episode.date ?? null;
  }
  return { season: season?.number ?? null, episodes };
}

/**
 * Состояние и даты из базы — то, с чем сравниваем.
 *
 * Поиск ведётся по `tconst`, а не по идентификатору строки: задача вызывается и
 * из команды, которая знает только IMDb-ключ, а сравнение «пустое до» выдало бы
 * все даты каталога за объявления.
 *
 * @param {any} pool
 * @param {string} tconst
 * @param {number|null} seasonNumber
 * @returns {Promise<{exitState: string|null, episodes: Record<number, string|null>}>}
 */
export async function previousState(pool, tconst, seasonNumber) {
  const episodes = {};
  const { rows } = await pool.query('SELECT id, exit_state FROM e_series WHERE imdb_key = $1', [tconst]);
  const seriesId = rows[0]?.id ?? null;
  if (seriesId && seasonNumber) {
    const found = await pool.query(
      `SELECT e.number, min(r.release_date)::text AS date
         FROM e_season s
         JOIN e_episode e ON e.season_id = s.id
         LEFT JOIN e_release_episode re ON re.episode_id = e.id
         LEFT JOIN e_release r ON r.id = re.release_id
        WHERE s.series_id = $1 AND s.number = $2
        GROUP BY e.number`,
      [seriesId, seasonNumber],
    );
    for (const row of found.rows) episodes[row.number] = row.date;
  }
  return { exitState: rows[0]?.exit_state ?? null, episodes };
}

/**
 * Перечитывает детали и последний сезон одного сериала.
 *
 * @param {{tmdbId: number, imdb: any, tmdb: any}} options
 * @returns {Promise<any>} сырой слой для записи
 */
export async function enrichForSchedule({ tmdbId, imdb, tmdb }) {
  const [detailsRu, detailsEn] = await Promise.all([
    tmdb.getDetailsLocalized(tmdbId, 'ru-RU'),
    tmdb.getDetailsLocalized(tmdbId, 'en-US'),
  ]);

  const number = lastSeasonNumber(detailsRu);
  const seasons = [];
  if (number) {
    // Незагруженный сезон не роняет сериал: расписание просто не обновится,
    // а полнота станет ниже — это видно в причинах и поправится полным прогоном.
    const season = await tmdb.getSeason(tmdbId, number, 'ru-RU').catch(() => null);
    if (season) seasons.push(season);
  }
  return buildRawSeries({ detailsRu, detailsEn, seasons, imdb });
}

/**
 * Ночная синхронизация расписания.
 *
 * @param {object} options
 * @param {any} options.pool
 * @param {any} options.store
 * @param {any} options.tmdb клиент TMDB
 * @param {number} options.runId прогон, в который пишутся позиции
 * @param {Set<string>} [options.slugs]
 * @param {any[]} [options.targets] что обновлять; по умолчанию — активные
 * @param {boolean} [options.dryRun] читать и считать, но не писать в каталог
 * @param {Date} [options.now]
 * @param {number} [options.concurrency]
 * @param {(line: string) => void} [options.log] куда писать о сбойной позиции
 * @returns {Promise<{status: string, items: number, errors: number, changes: any[]}>}
 */
export async function scheduleSync({
  pool, store, tmdb, runId, slugs = new Set(), targets = null,
  dryRun = false, now = new Date(), concurrency = null, log = () => {},
}) {
  const list = (targets ?? await loadActiveSeries(pool)).map((target) => ({
    ...target,
    // Отбор из базы уже содержит блок IMDb; список, заданный вызывающим
    // (тесты, обновление одного сериала), может его не содержать. Жанры при
    // этом не теряются: они приходят из карточки TMDB ниже.
    imdb: target.imdb ?? {
      tconst: target.tconst,
      startYear: target.startYear ?? null,
      genres: target.genres ?? [],
      numVotes: null,
      averageRating: null,
    },
  }));
  const parallel = concurrency ?? (await import('../../config/settings.js')).IMPORT_SETTINGS.apiConcurrency;

  const changes = [];
  let errors = 0;
  let done = 0;
  let next = 0;
  const items = [];

  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      const target = list[index];

      try {
        const raw = await enrichForSchedule({ tmdbId: target.tmdbId, imdb: target.imdb, tmdb });
        // В сыром слое ровно один сезон — последний, поэтому и сравнение идёт
        // по нему: у остальных даты источник не меняет.
        const before = await previousState(pool, target.tconst, raw.seasons[0]?.number ?? null);
        const after = episodesOf(raw);

        const found = diffSchedule({ before, after });
        if (!dryRun) {
          await writeSeries({ pool, raw, slugs, now, unchecked: UNCHECKED });
        }
        changes.push(...found.map((change) => ({ tconst: target.tconst, ...change })));
        items.push({
          tconst: target.tconst,
          tmdbId: target.tmdbId,
          stage: 'written',
          outcome: 'ok',
          // Коды событий сохраняются в отчёте: календарь (M3) читает их отсюда,
          // когда появится, и переносы не приходится восстанавливать по логам.
          reasons: diffSchedule({ before, after }).map((change) => change.code),
        });
      } catch (error) {
        errors += 1;
        log(`[расписание] ${target.tconst}: ${error.message}`);
        items.push({ tconst: target.tconst, tmdbId: target.tmdbId, stage: 'written', outcome: 'error' });
      } finally {
        done += 1;
        if (done === list.length) await store.saveItems(runId, items);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(parallel, list.length) }, worker));

  return {
    status: errors ? 'partial' : 'success',
    items: list.length,
    errors,
    changes,
  };
}
