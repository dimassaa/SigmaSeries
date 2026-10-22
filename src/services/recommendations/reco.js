// Персональные рекомендации (M11, F-11-01).
//
// Рекомендация без причины не показывается: человек вправе спросить «откуда»,
// и «похоже на» без конкретики — это догадка (M11 §0).
//
// Три сигнала, по убыванию веса: точные отметки просмотра, оценки и любимые
// из регистрации. Ретро-отметки не участвуют — как и в итогах. Причина у
// каждой рекомендации одна, самая сильная из сработавших: «похоже на
// {сериал}» сильнее «потому что жанр {жанр}», а тот сильнее «потому что вы
// отметили {сериал}» (F-11-01 §8б).
//
// Кэш — в памяти процесса на десять минут (M11 §0): считать дешевле, чем
// хранить инвалидируемый кэш. Скрытие сериала кэш сбрасывает — иначе
// «не интересно» подействовало бы через десять минут.

import pg from 'pg';

import { RECO } from '../../config/settings.js';

/**
 * Рекомендации человека.
 *
 * @param {pg.Pool} pool
 */
export function pgRecommendations(pool) {
  /** @type {Map<string, {at: number, items: object[], personalized: boolean}>} */
  const cache = new Map();

  /**
   * Отметки и оценки человека: что он смотрел и что оценил.
   *
   * @param {number} userId
   * @returns {Promise<{watched: number[], rated: number[], marks: number, ratings: number}>}
   */
  async function history(userId) {
    const { rows } = await pool.query(
      `WITH marks AS (
         SELECT DISTINCT sn.series_id
           FROM e_watch_mark m
           JOIN e_episode e ON e.id = m.episode_id
           JOIN e_season sn ON sn.id = e.season_id
          WHERE m.user_id = $1 AND m.precision = 'exact'
       ),
       ratings AS (
         SELECT DISTINCT r.series_id
           FROM e_rating r
          WHERE r.user_id = $1 AND r.counted AND r.object_type = 'series'
       )
       SELECT
         (SELECT array_agg(series_id) FROM marks) AS watched,
         (SELECT array_agg(series_id) FROM ratings) AS rated,
         (SELECT count(*)::int FROM e_watch_mark
           WHERE user_id = $1 AND precision = 'exact') AS marks,
         (SELECT count(*)::int FROM e_rating
           WHERE user_id = $1 AND counted AND object_type = 'series') AS ratings`,
      [userId],
    );
    const row = rows[0] ?? {};
    return {
      watched: (row.watched ?? []).map(Number),
      rated: (row.rated ?? []).map(Number),
      marks: Number(row.marks ?? 0),
      ratings: Number(row.ratings ?? 0),
    };
  }

  /**
   * Жанры вкуса: сколько сериалов человека в каждом жанре.
   *
   * @param {number[]} seriesIds отмеченные и оценённые сериалы
   * @returns {Promise<Map<string, number>>}
   */
  async function tasteGenres(seriesIds) {
    if (!seriesIds.length) return new Map();
    const { rows } = await pool.query(
      `SELECT sg.genre_code, count(DISTINCT sg.series_id)::int AS n
         FROM e_series_genre sg
        WHERE sg.series_id = ANY($1::bigint[])
        GROUP BY sg.genre_code
        ORDER BY n DESC`,
      [seriesIds],
    );
    const taste = new Map();
    for (const row of rows) taste.set(row.genre_code, Number(row.n));
    return taste;
  }

  /**
   * Кандидаты: что показать.
   *
   * @param {number} userId
   * @param {string[]} genres жанры вкуса
   * @returns {Promise<any[]>}
   */
  async function candidates(userId, genres) {
    const { rows } = await pool.query(
      `SELECT s.id, s.slug, coalesce(s.title_ru, s.title_original) AS title,
              s.year_start,
              coalesce(r.value::float, 0) AS imdb,
              (SELECT count(*)::int FROM e_series_genre sg
                WHERE sg.series_id = s.id AND sg.genre_code = ANY($4::text[])) AS genre_hits,
              (SELECT array_agg(sg.genre_code) FROM e_series_genre sg
                WHERE sg.series_id = s.id AND sg.genre_code = ANY($4::text[])) AS genres,
              pv.width AS poster_width
         FROM e_series s
         LEFT JOIN e_external_rating r ON r.series_id = s.id AND r.platform = 'imdb'
         LEFT JOIN LATERAL (
           SELECT iv.width FROM e_image_variant iv
           JOIN e_image i2 ON i2.id = iv.image_id
           WHERE i2.series_id = s.id AND i2.role = 'poster'
           ORDER BY iv.width LIMIT 1
         ) pv ON true
        WHERE s.publication_state = 'published' AND s.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM e_watch_status w
                           WHERE w.user_id = $1 AND w.series_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM e_watch_mark m
                           JOIN e_episode e ON e.id = m.episode_id
                           JOIN e_season sn ON sn.id = e.season_id
                          WHERE m.user_id = $1 AND m.precision = 'exact'
                            AND sn.series_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM e_reco_dismiss d
                           WHERE d.user_id = $1 AND d.series_id = s.id
                             AND d.created_at > now() - ($3 || ' days')::interval)
          AND EXISTS (SELECT 1 FROM e_series_genre sg
                       WHERE sg.series_id = s.id AND sg.genre_code = ANY($4::text[]))
        ORDER BY genre_hits DESC, imdb DESC NULLS LAST, s.slug
        LIMIT $2`,
      [userId, RECO.homeCount, String(RECO.dismissDays), genres],
    );
    return rows;
  }

  /**
   * Похожие пары между отмеченными и кандидатами.
   *
   * @param {number[]} watched отмеченные сериалы
   * @param {number[]} candidatesIds кандидаты
   * @returns {Promise<Map<number, {id: number, weight: number}>>} лучшая пара на кандидата
   */
  async function bestLikes(watched, candidatesIds) {
    if (!watched.length || !candidatesIds.length) return new Map();
    const { rows } = await pool.query(
      `SELECT sm.similar_id, sm.series_id, sm.weight
         FROM e_series_similar sm
        WHERE sm.series_id = ANY($1::bigint[]) AND sm.similar_id = ANY($2::bigint[])
        ORDER BY sm.similar_id, sm.weight DESC`,
      [watched, candidatesIds],
    );
    const best = new Map();
    for (const row of rows) {
      const key = Number(row.similar_id);
      if (!best.has(key)) {
        best.set(key, { id: Number(row.series_id), weight: Number(row.weight) });
      }
    }
    return best;
  }

  /**
   * Названия сериалов и жанров — на двух языках: причина переводима (M11 §11).
   *
   * @param {number[]} seriesIds
   * @returns {Promise<Map<number, {titleRu: string, titleEn: string}>>}
   */
  async function seriesNames(seriesIds) {
    if (!seriesIds.length) return new Map();
    const { rows } = await pool.query(
      `SELECT id, title_ru, title_en, title_original FROM e_series WHERE id = ANY($1::bigint[])`,
      [seriesIds],
    );
    const names = new Map();
    for (const row of rows) {
      names.set(Number(row.id), {
        titleRu: row.title_ru ?? row.title_original,
        titleEn: row.title_en ?? row.title_original,
      });
    }
    return names;
  }

  /**
   * Названия жанров — на двух языках.
   *
   * @param {string[]} codes
   * @returns {Promise<Map<string, {nameRu: string, nameEn: string}>>}
   */
  async function genreNames(codes) {
    if (!codes.length) return new Map();
    const { rows } = await pool.query(
      'SELECT code, name_ru, name_en FROM e_genre WHERE code = ANY($1::text[])',
      [codes],
    );
    const names = new Map();
    for (const row of rows) {
      names.set(row.code, { nameRu: row.name_ru, nameEn: row.name_en });
    }
    return names;
  }

  /**
   * Строка «для вас» для человека.
   *
   * @param {number|null} userId
   * @param {{force?: boolean}} [options]
   * @returns {Promise<{items: any[], personalized: boolean}>}
   */
  async function forUser(userId, { force = false } = {}) {
    if (!userId) return { items: [], personalized: false };

    const key = String(userId);
    const fresh = cache.get(key);
    if (!force && fresh && Date.now() - fresh.at < RECO.cacheSeconds * 1000) {
      return { items: fresh.items, personalized: fresh.personalized };
    }

    const past = await history(userId);
    // Мало истории — причина «потому что вы отметили X» была бы
    // преувеличением, и строка называется «популярное» (EC-M1).
    if (past.marks < RECO.minHistoryMarks && past.ratings < RECO.minHistoryRatings) {
      return remember(key, { items: [], personalized: false });
    }

    const known = [...new Set([...past.watched, ...past.rated])];
    const taste = await tasteGenres(known);
    if (!taste.size) return remember(key, { items: [], personalized: false });

    const rows = await candidates(userId, [...taste.keys()]);
    if (!rows.length) return remember(key, { items: [], personalized: false });

    const ids = rows.map((row) => Number(row.id));
    const likes = await bestLikes(past.watched, ids);
    const likeNames = await seriesNames([...likes.values()].map((like) => like.id));
    const markedNames = await seriesNames(past.watched);
    const genreList = [...new Set(rows.flatMap((row) => row.genres ?? []))];
    const genres = await genreNames(genreList);

    const items = [];
    for (const row of rows) {
      const like = likes.get(Number(row.id));
      const likeName = like ? likeNames.get(like.id) : null;
      if (likeName) {
        items.push({
          slug: row.slug,
          title: row.title,
          year_start: row.year_start,
          imdb: Number(row.imdb ?? 0) || null,
          poster_width: row.poster_width ?? null,
          reason: { kind: 'like', titleRu: likeName.titleRu, titleEn: likeName.titleEn },
        });
        continue;
      }
      const bestGenre = (row.genres ?? [])
        .filter((code) => taste.has(code))
        .sort((a, b) => taste.get(b) - taste.get(a))[0];
      const genre = bestGenre ? genres.get(bestGenre) : null;
      if (genre) {
        items.push({
          slug: row.slug,
          title: row.title,
          year_start: row.year_start,
          imdb: Number(row.imdb ?? 0) || null,
          poster_width: row.poster_width ?? null,
          reason: { kind: 'genre', titleRu: genre.nameRu, titleEn: genre.nameEn },
        });
        continue;
      }
      // Последняя причина — отмеченный сериал того же жанра.
      const marked = past.watched
        .map((id) => markedNames.get(id))
        .filter(Boolean)
        .at(-1);
      if (marked) {
        items.push({
          slug: row.slug,
          title: row.title,
          year_start: row.year_start,
          imdb: Number(row.imdb ?? 0) || null,
          poster_width: row.poster_width ?? null,
          reason: { kind: 'marked', titleRu: marked.titleRu, titleEn: marked.titleEn },
        });
      }
    }

    return remember(key, { items, personalized: items.length > 0 });
  }

  /**
   * Запоминает расчёт на десять минут.
   *
   * @param {string} key
   * @param {{items: any[], personalized: boolean}} result
   * @returns {{items: any[], personalized: boolean}}
   */
  function remember(key, result) {
    cache.set(key, { at: Date.now(), ...result });
    return result;
  }

  /**
   * Скрывает сериал: «не интересно» (F-11-03).
   *
   * @param {number} userId
   * @param {string} slug адрес сериала
   * @returns {Promise<boolean>}
   */
  async function dismiss(userId, slug) {
    const { rows } = await pool.query(
      `INSERT INTO e_reco_dismiss (user_id, series_id)
       SELECT $1, id FROM e_series WHERE slug = $2
       ON CONFLICT (user_id, series_id) DO UPDATE SET created_at = now()
       RETURNING series_id`,
      [userId, String(slug ?? '')],
    );
    cache.delete(String(userId));
    return rows.length > 0;
  }

  return { forUser, dismiss, history };
}
