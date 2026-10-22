// Подборка (F-02-05, S-05).
//
// Главное здесь — порог видимости: подборка из пяти видимых сериалов для
// посетителя не существует (EC-C6, §5 приёмки). Правило одно и для страницы,
// и для бегущей строки главной, поэтому оно живёт в константе, а не в двух
// запросах, которые однажды разойдутся.
//
// Порядок сериалов задаёт администратор (`e_collection_item.ordinal`) и
// никак не «популярность»: тематический набор — это мнение редакции, и
// пересортировывать его по числу голосов было бы подменой.
//
// Архивные сериалы не считаются и не показываются: подборка из шести пунктов,
// где один ушёл в архив, — это уже пять видимых, то есть её нет.

import pg from 'pg';

import { bannerOf } from './banner.js';

/** Порог видимости подборки (F-02-05 §3, EC-C6). */
export const MIN_VISIBLE_SERIES = 6;

/** Больше ста сериалов в подборку не кладут (F-02-05 «Валидация и лимиты»). */
const SERIES_LIMIT = 100;

/** Подборки в бегущей строке главной. */
export const COLLECTION_LIMIT = 6;

/**
 * Источник данных подборок.
 *
 * @param {pg.Pool} pool
 */
export function pgCollections(pool) {
  return {
    /**
     * Подборка для страницы.
     *
     * @param {string} slug
     * @returns {Promise<any|null>} `null`, если подборки для посетителя нет
     */
    async collection(slug) {
      const { rows } = await pool.query(
        'SELECT id, slug, title_ru, description_ru FROM e_collection WHERE slug = $1 AND active AND NOT is_demo',
        [slug],
      );
      const collection = rows[0];
      if (!collection) return null;

      const series = await visibleSeries(pool, collection.id);
      // Порог решает всё: пять видимых сериалов — подборки не существует, даже
      // если прямая ссылка на неё известна и подборка активна.
      if (series.length < MIN_VISIBLE_SERIES) return null;

      const banner = await bannerOf(pool, slug);

      return {
        slug: collection.slug,
        title: collection.title_ru,
        description: collection.description_ru ?? '',
        banner: banner ? { width: banner.width } : null,
        series,
        total: series.length,
      };
    },

    /**
     * Подборки для бегущей строки главной и сетки S-04.
     *
     * @param {number} [limit]
     * @returns {Promise<{slug: string, title: string, count: number}[]>}
     */
    async list(limit = COLLECTION_LIMIT) {
      const { rows } = await pool.query(
        `SELECT c.slug, c.title_ru AS title, count(*)::int AS count
           FROM e_collection c
           JOIN e_collection_item ci ON ci.collection_id = c.id
           JOIN e_series s ON s.id = ci.series_id
          WHERE c.active AND NOT c.is_demo
            AND s.publication_state = 'published' AND s.archived_at IS NULL
          GROUP BY c.id
         HAVING count(*) >= $2
          ORDER BY c.weight DESC, c.title_ru
          LIMIT $1`,
        [limit, MIN_VISIBLE_SERIES],
      );
      return rows;
    },
  };
}

/**
 * Видимые сериалы подборки в порядке админа.
 *
 * @param {pg.Pool} pool
 * @param {number} collectionId
 * @returns {Promise<any[]>}
 */
async function visibleSeries(pool, collectionId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.slug,
            coalesce(s.title_ru, s.title_en, s.title_original) AS title,
            s.year_start, s.year_end,
            (SELECT iv.width FROM e_image_variant iv
               JOIN e_image i ON i.id = iv.image_id
              WHERE i.series_id = s.id AND i.role = 'poster'
              ORDER BY iv.width LIMIT 1) AS poster_width,
            (SELECT r.votes FROM e_external_rating r
              WHERE r.series_id = s.id AND r.platform = 'imdb') AS votes,
            (SELECT i2.role FROM e_image i2
              WHERE i2.series_id = s.id AND i2.role = 'backdrop'
              ORDER BY i2.focal_x LIMIT 1) AS has_backdrop
       FROM e_collection_item ci
       JOIN e_series s ON s.id = ci.series_id
      WHERE ci.collection_id = $1
        AND s.publication_state = 'published' AND s.archived_at IS NULL
      ORDER BY ci.ordinal, s.id
      LIMIT $2`,
    [collectionId, SERIES_LIMIT],
  );

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title ?? '',
    year: row.year_start ?? '',
    yearEnd: row.year_end ?? '',
    posterWidth: row.poster_width,
    votes: row.votes,
    hasBackdrop: row.has_backdrop !== null,
  }));
}