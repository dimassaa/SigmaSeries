// Источник данных главной страницы.
//
// Сервис не знает про HTTP, а источник не знает про разметку: он отдаёт
// готовые значения, перевод причины баннера делает представление.
// Поэтому один и тот же источник работает и в тестах, и в приложении.

import pg from 'pg';

import { MIN_VISIBLE_SERIES } from '../catalogue/collection.js';
import { homeSettings } from './settings.js';

/**
 * Данные из базы.
 *
 * Каждый метод возвращает готовые к показу значения: `yearRange` уже собрана,
 * рейтинг уже отформатирован по-русски, вариант картинки уже выбран.
 * Форматирование в базе не делается — его нельзя отладить запросом.
 *
 * @param {pg.Pool} pool
 * @param {{recommendations?: {forUser: (userId: number|null) => Promise<{items: any[], personalized: boolean}>}|null}} [deps]
 */
export function pgData(pool, { recommendations = null } = {}) {
  // Настройки читаются один раз на источник: главная открывается часто, а
  // ключи меняются администратором в S-83, а не на каждый запрос. Источник
  // живёт дольше одного открытия страницы, поэтому чтение на каждый вызов
  // оборачивалось бы двенадцатью запросами на страницу (M6 §0).
  const settings = { settings: null };

  const current = async () => {
    if (!settings.settings) settings.settings = await homeSettings(pool);
    return settings.settings;
  };

  return {
    /** Настройки главной: интервал бегущей строки и прочее. */
    settings: current,
    async banners() {
      const { bannersPerDay } = await current();
      // Баннеры показываются за последний день, на который их посчитали, а не
      // за смесь дней: иначе после пересчёта, давшего два баннера вместо трёх,
      // на странице остался бы вчерашний третий.
      const { rows } = await pool.query(`
        WITH latest AS (
          SELECT max(show_on) AS day FROM e_banner WHERE active AND show_on <= $2
        )
        SELECT s.slug,
               coalesce(s.title_ru, s.title_original) AS title,
               s.year_start,
               s.year_end,
               CASE
                 WHEN b.kind = 'editorial' AND NOT EXISTS (
                        SELECT 1 FROM e_editorial_pick p
                         WHERE p.series_id = b.series_id
                           AND p.active_from <= $2
                           AND (p.active_until IS NULL OR p.active_until >= $2))
                   THEN CASE WHEN s.exit_state = 'airing' THEN 'new' ELSE 'classic' END
                 ELSE b.kind
               END AS reason,
               r.value::float AS imdb,
               s.archived_at IS NOT NULL AS withdrawn,
               (SELECT iv.width FROM e_image_variant iv
                  JOIN e_image i ON i.id = iv.image_id
                 WHERE i.series_id = s.id AND i.role = 'backdrop'
                   AND s.archived_at IS NULL
                 ORDER BY iv.width DESC LIMIT 1) AS backdrop_width
          FROM e_banner b
          JOIN latest l ON l.day = b.show_on
          JOIN e_series s ON s.id = b.series_id
          LEFT JOIN e_external_rating r
                 ON r.series_id = s.id AND r.platform = 'imdb'
         WHERE b.active AND b.show_on <= $2
         ORDER BY CASE b.kind WHEN 'new' THEN 1 WHEN 'classic' THEN 2 ELSE 3 END
         LIMIT $1`, [bannersPerDay, localDate()]);
      return rows.map(decorateBanner);
    },

    async fresh() {
      const { freshPerPage, freshPages } = await current();
      // Три круга по шесть приходят одним ответом: переключение круга не
      // ходит в сеть и не меняет адрес (F-06-03 §8а).
      const { rows } = await pool.query(`
        WITH ranked AS (
          SELECT s.slug,
                 coalesce(s.title_ru, s.title_original) AS title,
                 s.year_start,
                 rel.release_date,
                 r.value::float AS imdb,
                 pv.width AS poster_width,
                 row_number() OVER (
                   ORDER BY rel.release_date DESC, r.value DESC NULLS LAST, s.slug
                 ) AS rn
            FROM e_series s
            JOIN e_season se ON se.series_id = s.id
            JOIN e_release rel ON rel.season_id = se.id
            LEFT JOIN e_external_rating r
                   ON r.series_id = s.id AND r.platform = 'imdb'
            LEFT JOIN LATERAL (
              SELECT iv.width FROM e_image_variant iv
              JOIN e_image i2 ON i2.id = iv.image_id
              WHERE i2.series_id = s.id AND i2.role = 'poster'
              ORDER BY iv.width LIMIT 1
            ) pv ON true
           WHERE s.archived_at IS NULL
             AND s.exit_state IN ('airing','announced')
             AND rel.release_date <= CURRENT_DATE
             AND rel.release_date >= CURRENT_DATE - INTERVAL '14 days'
           GROUP BY s.id, rel.release_date, r.value, pv.width
        )
        SELECT * FROM ranked WHERE rn <= $1 ORDER BY rn`,
      [freshPerPage * freshPages]);
      const items = rows.map(decorateSeries);
      const circles = [];
      for (let i = 0; i < items.length; i += freshPerPage) {
        circles.push(items.slice(i, i + freshPerPage));
      }
      return circles;
    },

    async collections() {
      const { marqueeCollections } = await current();
      // Порог шести видимых сериалов — тот же, что и на странице подборки
      // (F-02-05 §5): подборка из пяти пунктов не появляется на главной.
      // Считать по-разному значило бы, что ссылка ведёт в 404.
      const { rows } = await pool.query(`
        SELECT c.slug, c.title_ru AS title, count(*)::int AS count,
               coalesce(
                 (SELECT iv.width FROM e_image_variant iv
                   JOIN e_image i ON i.id = iv.image_id
                  WHERE i.id = c.banner_image_id
                  ORDER BY iv.width DESC LIMIT 1),
                 -- Фон по умолчанию — кадр первого сериала подборки (F-06-04 §4).
                 (SELECT iv.width FROM e_image_variant iv
                   JOIN e_image i ON i.id = iv.image_id
                   JOIN e_collection_item first_item
                     ON first_item.series_id = i.series_id
                  WHERE first_item.collection_id = c.id
                    AND first_item.ordinal = (SELECT min(ordinal) FROM e_collection_item
                                               WHERE collection_id = c.id)
                    AND i.role = 'backdrop'
                  ORDER BY iv.width DESC LIMIT 1)
               ) AS banner_width,
               coalesce(
                 (SELECT s2.slug FROM e_collection_item first_item
                    JOIN e_series s2 ON s2.id = first_item.series_id
                   WHERE first_item.collection_id = c.id
                     AND first_item.ordinal = (SELECT min(ordinal) FROM e_collection_item
                                                WHERE collection_id = c.id)),
                 (SELECT s3.slug FROM e_collection_item any_item
                    JOIN e_series s3 ON s3.id = any_item.series_id
                   WHERE any_item.collection_id = c.id)
               ) AS banner_slug
          FROM e_collection c
          JOIN e_collection_item ci ON ci.collection_id = c.id
          JOIN e_series s ON s.id = ci.series_id
         WHERE c.active AND NOT c.is_demo
           AND s.publication_state = 'published' AND s.archived_at IS NULL
         GROUP BY c.id
        HAVING count(*) >= $2
         ORDER BY c.weight DESC, c.title_ru
         LIMIT $1`, [marqueeCollections, MIN_VISIBLE_SERIES]);
      return rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        count: r.count,
        bannerWidth: r.banner_width,
        bannerSlug: r.banner_slug,
      }));
    },

    /**
     * Ряд «Для вас»: вошедшему — по его жанрам, гостю — популярное.
     *
     * Персонализация опирается на то, чем человек уже показал интерес:
     * оценки, отметки и «любимые», выбранные при регистрации (F-06-06 §8б).
     * Если данных нет или рекомендации выключены в настройках, показывается
     * популярное — без сообщения об ошибке (F-06-06 §5).
     *
     * @param {number|null} userId
     * @returns {Promise<{items: any[], personalized: boolean}>}
     */
    async forYou(userId) {
      const popular = async () => {
        const { rows } = await pool.query(`
          SELECT s.slug, coalesce(s.title_ru, s.title_original) AS title, s.year_start,
                 r.value::float AS imdb,
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
           ORDER BY r.value DESC NULLS LAST, s.year_start DESC
           LIMIT 6`);
        return rows.map(decorateSeries);
      };

      if (!userId) return { items: await popular(), personalized: false };

      const { rows: [flag] } = await pool.query(
        'SELECT recs_enabled FROM e_user WHERE id = $1', [userId],
      );
      if (!flag?.recs_enabled) return { items: await popular(), personalized: false };

      // Персональные рекомендации (M11, F-11-01): у каждой позиции есть
      // причина. Движка нет — строка называется «популярное».
      if (recommendations) {
        const reco = await recommendations.forUser(userId);
        if (reco.items.length) {
          return { items: reco.items.map(decorateSeries), personalized: true };
        }
        return { items: await popular(), personalized: false };
      }

      const { rows } = await pool.query(`
        WITH my_genres AS (
          SELECT DISTINCT sg.genre_code
            FROM e_series_genre sg
            JOIN e_rating r ON r.series_id = sg.series_id
           WHERE r.user_id = $1
          UNION
          SELECT DISTINCT sg.genre_code
            FROM e_series_genre sg
            JOIN e_taste_seed ts ON ts.series_id = sg.series_id
           WHERE ts.user_id = $1
        )
        SELECT s.slug, coalesce(s.title_ru, s.title_original) AS title, s.year_start,
               r.value::float AS imdb,
               pv.width AS poster_width
          FROM e_series s
          JOIN e_series_genre sg ON sg.series_id = s.id
          JOIN my_genres g ON g.genre_code = sg.genre_code
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
         GROUP BY s.id, r.value, pv.width
         ORDER BY r.value DESC NULLS LAST, s.year_start DESC
         LIMIT 6`, [userId]);

      if (!rows.length) return { items: await popular(), personalized: false };
      return { items: rows.map(decorateSeries), personalized: true };
    },

    async genres() {
      const { genresPerRow } = await current();
      const { rows } = await pool.query(`
        SELECT g.code, coalesce(NULLIF($2, 'ru'), g.name_ru) AS title,
               count(sg.series_id)::int AS series_count
          FROM e_genre g
          LEFT JOIN e_series_genre sg ON sg.genre_code = g.code
          LEFT JOIN e_series s ON s.id = sg.series_id AND s.archived_at IS NULL
         WHERE g.active AND g.is_raw = FALSE
         GROUP BY g.code, g.name_ru, g.name_en
        HAVING count(sg.series_id) > 0
         ORDER BY series_count DESC
         LIMIT $1`, [genresPerRow, 'ru']);
      return rows.map((r) => ({ code: r.code, title: r.title }));
    },
  };
}

function decorateBanner(r) {
  return {
    seriesSlug: r.slug,
    title: r.title ?? '',
    // Причина приходит кодом и переводится в представлении: источник
    // не знает про язык интерфейса.
    reason: r.reason,
    yearRange: yearRange(r.year_start, r.year_end),
    imdb: formatRating(r.imdb),
    backdropWidth: r.backdrop_width,
    // Сериал, снятый с публикации, остаётся на баннере до ближайшей смены
    // суток — вместо него заглушка с пометкой (EC-H3).
    withdrawn: Boolean(r.withdrawn),
  };
}

/**
 * Локальная дата в формате `YYYY-MM-DD`.
 *
 * @param {Date} [at]
 * @returns {string}
 */
function localDate(at = new Date()) {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function decorateSeries(r) {
  return {
    slug: r.slug,
    title: r.title ?? '',
    year: r.year_start ?? '',
    posterWidth: r.poster_width,
    // Причина рекомендации (M11): без неё строка — догадка.
    ...(r.reason ? { reason: r.reason } : {}),
  };
}

function yearRange(from, to) {
  if (!from) return '';
  return to && to !== from ? `${from}–${to}` : String(from);
}

/** Рейтинг в русской записи: 9.1 → «9,1». Разделитель зависит от локали. */
function formatRating(value) {
  if (value == null) return '—';
  return String(Math.round(value * 10) / 10).replace('.', ',');
}

/**
 * Заглушка: одинаковый интерфейс без базы.
 *
 * Нужна не только тестам. Раздел с пустым каталогом должен открываться и
 * показывать пустые состояния, а не 500, — иначе на свежей установке
 * первая же страница не работает.
 */
export function stubData(over = {}) {
  const empty = async () => [];
  return {
    banners: over.banners ?? empty,
    fresh: over.fresh ?? empty,
    collections: over.collections ?? empty,
    genres: over.genres ?? empty,
    settings: over.settings ?? (async () => ({ marqueeIntervalMs: 4000 })),
  };
}

/**
 * Собирает данные главной.
 *
 * Ошибка базы пробрасывается: подменять её пустым состоянием нельзя —
 * посетитель увидел бы «ничего не выходит» вместо «сервис сломался».
 * Разница между «нет данных» и «не удалось получить» обязана быть видна.
 */
export async function collectHomeData(data, locale, userId = null) {
  const [banners, fresh, collections, genres, settings, forYou] = await Promise.all([
    data.banners(),
    data.fresh(locale),
    data.collections(),
    data.genres(locale),
    // Интервал бегущей строки нужен в разметке: значение из базы, а не из кода.
    data.settings ? data.settings() : Promise.resolve(null),
    data.forYou ? data.forYou(userId) : Promise.resolve({ items: [], personalized: false }),
  ]);
  return {
    banners, fresh, collections, genres, forYou,
    marqueeIntervalMs: settings ? settings.marqueeIntervalMs : 4000,
  };
}