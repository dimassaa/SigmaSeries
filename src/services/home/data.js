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
 */
export function pgData(pool) {
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
    async banners() {
      const { bannersPerDay } = await current();
      const { rows } = await pool.query(`
        SELECT s.slug,
               coalesce(s.title_ru, s.title_original) AS title,
               s.year_start,
               s.year_end,
               b.kind AS reason,
               r.value::float AS imdb,
               i.file IS NOT NULL AS has_backdrop,
               (SELECT iv.width FROM e_image_variant iv WHERE iv.image_id = i.id
                 ORDER BY iv.width DESC LIMIT 1) AS backdrop_width
          FROM e_banner b
          JOIN e_series s ON s.id = b.series_id
          LEFT JOIN e_image i
                 ON i.id = (SELECT id FROM e_image
                             WHERE series_id = s.id AND role = 'backdrop'
                             ORDER BY focal_x LIMIT 1)
          LEFT JOIN e_external_rating r
                 ON r.series_id = s.id AND r.platform = 'imdb'
         WHERE b.active AND b.show_on <= CURRENT_DATE
           AND s.archived_at IS NULL
         ORDER BY b.show_on DESC
         LIMIT $1`, [bannersPerDay]);
      return rows.map(decorateBanner);
    },

    async fresh() {
      const { freshPerPage } = await current();
      const { rows } = await pool.query(`
        SELECT s.slug,
               coalesce(s.title_ru, s.title_original) AS title,
               s.year_start,
               rel.release_date,
               pv.width AS poster_width
          FROM e_series s
          JOIN e_season se ON se.series_id = s.id
          JOIN e_release rel ON rel.season_id = se.id
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
         GROUP BY s.id, rel.release_date, pv.width
         ORDER BY rel.release_date DESC, s.year_start
         LIMIT $1`, [freshPerPage]);
      return rows.map(decorateSeries);
    },

    async collections() {
      const { marqueeCollections } = await current();
      // Порог шести видимых сериалов — тот же, что и на странице подборки
      // (F-02-05 §5): подборка из пяти пунктов не появляется на главной.
      // Считать по-разному значило бы, что ссылка ведёт в 404.
      const { rows } = await pool.query(`
        SELECT c.slug, c.title, count(*)::int AS count
          FROM e_collection c
          JOIN e_collection_item ci ON ci.collection_id = c.id
          JOIN e_series s ON s.id = ci.series_id
         WHERE c.active AND NOT c.is_demo
           AND s.publication_state = 'published' AND s.archived_at IS NULL
         GROUP BY c.id
        HAVING count(*) >= $2
         ORDER BY c.weight DESC, c.title
         LIMIT $1`, [marqueeCollections, MIN_VISIBLE_SERIES]);
      return rows.map((r) => ({ slug: r.slug, title: r.title, count: r.count }));
    },

    async genres() {
      const { genresPerRow } = await current();
      const { rows } = await pool.query(`
        SELECT g.code, coalesce(NULLIF($2, 'ru'), g.name_ru) AS title,
               count(sg.series_id)::int AS series_count
          FROM e_genre g
          LEFT JOIN e_series_genre sg ON sg.genre_code = g.code
          LEFT JOIN e_series s ON s.id = sg.series_id AND s.archived_at IS NULL
         WHERE g.active
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
  };
}

function decorateSeries(r) {
  return {
    slug: r.slug,
    title: r.title ?? '',
    year: r.year_start ?? '',
    posterWidth: r.poster_width,
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
  };
}

/**
 * Собирает данные главной.
 *
 * Ошибка базы пробрасывается: подменять её пустым состоянием нельзя —
 * посетитель увидел бы «ничего не выходит» вместо «сервис сломался».
 * Разница между «нет данных» и «не удалось получить» обязана быть видна.
 */
export async function collectHomeData(data, locale) {
  const [banners, fresh, collections, genres] = await Promise.all([
    data.banners(),
    data.fresh(locale),
    data.collections(),
    data.genres(locale),
  ]);
  return { banners, fresh, collections, genres };
}