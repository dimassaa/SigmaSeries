// Прогресс и «следующая серия» (F-03-03, OP-10).
//
// Правила OP-10 — это арифметика по выходам и отметкам, и она обязана быть в
// коде, а не в представлении: от неё зависят и страница сериала, и закладки.
//
// Что важно в решениях:
//
//  · Знаменатель — **вышедшие** серии, а не все. Не вышедшую нельзя смотреть, и
//    «12 из 24» вместо «12 из 20» обещало бы то, чего не будет.
//  · «Следующая» — первая неотмеченная **после последней отмеченной** (OP-10б),
//    а пропуски до неё показываются отдельно. Человек посмотрел пятую, а
//    предлагать ему первую — значит предлагать то, что он уже видел.
//  · Кэш `e_progress` хранит всё, что нужно карточке закладки, и сверяется при
//    чтении с числом вышедших серий: иначе новая серия, вышедшая после импорта,
//    годами показывала бы старый процент.

import pg from 'pg';

export function pgProgress(pool) {
  return {
    /**
     * Прогресс по одному сериалу — всегда считается заново: на странице сериала
     * это один запрос, и свежесть важнее экономии.
     *
     * @param {object} args
     * @param {number} args.userId
     * @param {number} args.seriesId
     * @param {string} [args.today] сегодня пояса зрителя `YYYY-MM-DD`
     * @returns {Promise<object>}
     */
    async of({ userId, seriesId, today = isoToday() }) {
      const calculated = await recompute(pool, { userId, seriesId, today });
      const cached = await readCache(pool, { userId, seriesIds: [seriesId] });
      const row = cached.get(seriesId) ?? null;
      // Видимость — свойство сериала, а не отметок: снятый с публикации сериал
      // исключается из прогресса, но его отметки остаются (EC-T9).
      return { ...decorate(row, null), visible: calculated.visible };
    },

    /**
     * Прогресс по многим сериалам — для списка закладок.
     *
     * @param {object} args
     * @param {number} args.userId
     * @param {number[]} args.seriesIds
     * @param {string} [args.today]
     * @param {boolean} [args.useCache] `false` — пересчитать всё
     * @returns {Promise<Map<number, object>>}
     */
    async forSeries({ userId, seriesIds, today = isoToday(), useCache = true }) {
      if (!seriesIds.length) return new Map();

      const aired = await airedCounts(pool, seriesIds);
      const stale = await staleSeries(pool, { userId, seriesIds, aired, useCache });

      // Пересчитываются только те, у которых кэша нет или он разошёлся с
      // числом вышедших серий: импорт мог принести новую серию после прогона.
      for (const seriesId of stale) {
        await recompute(pool, { userId, seriesId, today });
      }

      const cached = await readCache(pool, { userId, seriesIds });
      const awaiting = await awaitingDates(pool, seriesIds, today);

      const result = new Map();
      for (const seriesId of seriesIds) {
        const row = cached.get(seriesId);
        if (!row) continue;
        result.set(seriesId, decorate(row, awaiting.get(seriesId) ?? null));
      }
      return result;
    },
  };
}

/**
 * Пересчёт и запись кэша — единственное место, где считается прогресс.
 *
 * Экспортируется для `marks.js`: отметка меняет прогресс, и пересчитывать его
 * должен тот же код, что и читает — иначе кэш и чтение разойдутся.
 *
 * @param {pg.Pool} pool
 * @param {object} args
 * @param {number} args.userId
 * @param {number} args.seriesId
 * @param {string} [args.today]
 * @returns {Promise<object>}
 */
export async function recompute(pool, { userId, seriesId, today = isoToday() }) {
  const { rows } = await pool.query(
    `WITH visible AS (
       SELECT e.id, se.number AS season, e.number AS episode,
              (SELECT min(r.release_date) FROM e_release_episode rle
                 JOIN e_release r ON r.id = rle.release_id
                WHERE rle.episode_id = e.id) AS release_date
         FROM e_episode e
         JOIN e_season se ON se.id = e.season_id
         JOIN e_series s ON s.id = se.series_id
        WHERE se.series_id = $2 AND se.number > 0
          AND s.publication_state = 'published' AND s.archived_at IS NULL
     ), aired AS (
       SELECT v.id, v.season, v.episode, v.release_date,
              EXISTS (SELECT 1 FROM e_watch_mark m
                       WHERE m.user_id = $1 AND m.episode_id = v.id) AS marked
         FROM visible v
        WHERE v.release_date IS NOT NULL AND v.release_date <= $3::date
     )
     SELECT id, season, episode, release_date::text AS release_date, marked
       FROM aired ORDER BY season, episode`,
    [userId, seriesId, today],
  );

  const { rows: totals } = await pool.query(
    `SELECT count(*)::int AS total_episodes
       FROM e_episode e
       JOIN e_season se ON se.id = e.season_id
       JOIN e_series s ON s.id = se.series_id
      WHERE se.series_id = $1 AND se.number > 0
        AND s.publication_state = 'published' AND s.archived_at IS NULL`,
    [seriesId],
  );

  const { rows: future } = await pool.query(
    `SELECT min(r.release_date)::text AS date
       FROM e_release r
       JOIN e_season se ON se.id = r.season_id
      WHERE se.series_id = $1 AND se.number > 0 AND r.release_date > $2::date`,
    [seriesId, today],
  );

  const episodes = rows.map((row) => ({
    season: row.season,
    episode: row.episode,
    date: row.release_date,
    marked: row.marked === true,
  }));

  const aired = episodes.length;
  const marked = episodes.filter((episode) => episode.marked).length;

  // Последняя отмеченная — по порядку просмотра, а не по дате: человек мог
  // вернуться и отметить третью после шестой.
  let lastIndex = -1;
  episodes.forEach((episode, index) => {
    if (episode.marked) lastIndex = index;
  });

  const next = episodes.slice(lastIndex + 1).find((episode) => !episode.marked) ?? null;
  // Пропущено — неотмеченные серии ДО последней отмеченной: их человек
  // пролистал, и предлагать «продолжить» с них нельзя (EC-T11).
  const skipped = lastIndex < 0
    ? 0
    : episodes.slice(0, lastIndex).filter((episode) => !episode.marked).length;

  const row = {
    marked,
    aired,
    totalEpisodes: totals[0]?.total_episodes ?? 0,
    lastSeason: lastIndex < 0 ? null : episodes[lastIndex].season,
    lastEpisode: lastIndex < 0 ? null : episodes[lastIndex].episode,
    nextSeason: next?.season ?? null,
    nextEpisode: next?.episode ?? null,
    nextDate: next?.date ?? null,
    awaitingDate: next ? null : future[0]?.date ?? null,
    skipped,
  };

  await pool.query(
    `INSERT INTO e_progress
       (user_id, series_id, marked, aired, last_season, last_episode,
        next_season, next_episode, next_date, awaiting_date, skipped, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (user_id, series_id) DO UPDATE SET
       marked = EXCLUDED.marked, aired = EXCLUDED.aired,
       last_season = EXCLUDED.last_season, last_episode = EXCLUDED.last_episode,
       next_season = EXCLUDED.next_season, next_episode = EXCLUDED.next_episode,
       next_date = EXCLUDED.next_date, awaiting_date = EXCLUDED.awaiting_date,
       skipped = EXCLUDED.skipped, updated_at = now()`,
    [userId, seriesId, row.marked, row.aired, row.lastSeason, row.lastEpisode,
      row.nextSeason, row.nextEpisode, row.nextDate, row.awaitingDate, row.skipped],
  );

  const { rows: state } = await pool.query(
    "SELECT publication_state = 'published' AND archived_at IS NULL AS visible FROM e_series WHERE id = $1",
    [seriesId],
  );

  return decorate({ ...row, visible: state[0]?.visible === true }, null);
}

/**
 * Строка кэша в виде, который видит представление.
 *
 * Проценты и состояние считаются здесь, а не в базе и не в представлении:
 * ими пользуются и страница сериала, и карточка закладки, а три разных
 * подсчёта одного и того же процента разошлись бы при первом же изменении
 * округления.
 *
 * @param {object|null} row строка `e_progress` или `null`, если её нет
 * @param {string|null} awaitingDate когда выйдет следующая, если всё отмечено
 * @returns {object}
 */
function decorate(row, awaitingDate) {
  if (!row) {
    return {
      visible: false, marked: 0, aired: 0, totalEpisodes: 0, percent: 0,
      lastSeason: null, lastEpisode: null, nextSeason: null, nextEpisode: null,
      nextDate: null, awaitingDate: null, skipped: 0, state: 'no-airdates', cachedAt: null,
    };
  }

  return {
    ...row,
    visible: row.visible ?? true,
    percent: row.aired ? Math.round((row.marked / row.aired) * 100) : 0,
    totalEpisodes: row.aired,
    awaitingDate: row.awaitingDate ?? awaitingDate,
    state: stateOf(row),
  };
}

/** Состояние для представления (F-03-03 §6). */
function stateOf(row) {
  if (!row.aired) return 'no-airdates';
  if (!row.marked) return 'not-started';
  if (row.nextSeason === null && row.nextEpisode === null) return 'all-aired-watched';
  return 'in-progress';
}

/** Число вышедших видимых серий по каждому сериалу — дешёвая проверка кэша. */
async function airedCounts(pool, seriesIds) {
  const { rows } = await pool.query(
    `SELECT se.series_id, count(*)::int AS aired
       FROM e_episode e
       JOIN e_season se ON se.id = e.season_id
       JOIN e_series s ON s.id = se.series_id
       JOIN e_release_episode rle ON rle.episode_id = e.id
       JOIN e_release r ON r.id = rle.release_id
      WHERE se.series_id = ANY($1::bigint[]) AND se.number > 0
        AND s.publication_state = 'published' AND s.archived_at IS NULL
        AND r.release_date <= CURRENT_DATE
      GROUP BY se.series_id`,
    [seriesIds],
  );
  return new Map(rows.map((row) => [row.series_id, row.aired]));
}

/** Какие сериалы пришлось бы пересчитывать. */
async function staleSeries(pool, { userId, seriesIds, aired, useCache }) {
  if (!useCache) return [...seriesIds];

  const { rows } = await pool.query(
    'SELECT series_id, aired FROM e_progress WHERE user_id = $1 AND series_id = ANY($2::bigint[])',
    [userId, seriesIds],
  );
  const cached = new Map(rows.map((row) => [row.series_id, row.aired]));

  return seriesIds.filter((seriesId) => {
    const live = aired.get(seriesId) ?? 0;
    if (!cached.has(seriesId)) return true;
    return cached.get(seriesId) !== live;
  });
}

/** Ближайший будущий выход — для «ждём серию {дата}». */
async function awaitingDates(pool, seriesIds, today) {
  const { rows } = await pool.query(
    `SELECT se.series_id, min(r.release_date)::text AS date
       FROM e_release r
       JOIN e_season se ON se.id = r.season_id
       JOIN e_series s ON s.id = se.series_id
      WHERE se.series_id = ANY($1::bigint[]) AND se.number > 0
        AND s.publication_state = 'published' AND s.archived_at IS NULL
        AND r.release_date > $2::date
      GROUP BY se.series_id`,
    [seriesIds, today],
  );
  return new Map(rows.map((row) => [row.series_id, row.date]));
}

async function readCache(pool, { userId, seriesIds }) {
  const { rows } = await pool.query(
    `SELECT series_id, marked, aired, last_season, last_episode,
            next_season, next_episode, next_date::text AS next_date,
            awaiting_date::text AS awaiting_date, skipped, updated_at::text AS updated_at
       FROM e_progress WHERE user_id = $1 AND series_id = ANY($2::bigint[])`,
    [userId, seriesIds],
  );

  return new Map(rows.map((row) => [row.series_id, {
    seriesId: row.series_id,
    marked: row.marked,
    aired: row.aired,
    // Знаменатель прогресса — вышедшие серии, а не все: невышедшую смотреть
    // нельзя, и «12 из 24» вместо «12 из 20» обещало бы лишнее (OP-10а).
    totalEpisodes: row.aired,
    lastSeason: row.last_season,
    lastEpisode: row.last_episode,
    nextSeason: row.next_season,
    nextEpisode: row.next_episode,
    nextDate: row.next_date,
    awaitingDate: row.awaiting_date,
    skipped: row.skipped,
    cachedAt: row.updated_at,
  }]));
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}