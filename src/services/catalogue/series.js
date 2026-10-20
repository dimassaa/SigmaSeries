// Данные страницы сериала (F-02-01).
//
// Запросов четыре, а не один: страница показывает сезоны с сериями, людей и
// выходы, и склеить это одним SELECT можно было бы только дорогим
// размножением строк. Зато каждый запрос отвечает на один вопрос и читается
// отдельно — как и положено источнику, который не знает про разметку.

import { importSettings } from './settings.js';
import { RATING } from '../settings.js';

/** Сколько сериалов в списке одного сезона показываем сразу. */
const EPISODES_LIMIT = 50;

/**
 * Источник данных карточки из базы.
 *
 * @param {import('pg').Pool} pool
 */
export function pgSeries(pool) {
  return {
    /**
     * Шапка сериала для вторичных страниц: строка серии без содержимого.
     *
     * Список отзывов (S-09) показывает название, описание и признак «снят с
     * публикации» — ни людей, ни эпизодов, ни картинок он не рендерит, и тянуть
     * их десятком запросов значило бы вылететь за бюджет страницы (F-04-05
     * §14). Отказы те же, что у `bySlug`: нет строки или источник не
     * опубликован — `null`, опубликован и снят — строка с `archived: true`.
     *
     * @param {string} slug
     * @returns {Promise<object|null>}
     */
    async lite(slug) {
      const { rows } = await pool.query(
        `SELECT id, slug, title_ru, title_en, title_original,
                description_ru, description_en,
                publication_state, archived_at
           FROM e_series
          WHERE slug = $1`,
        [slug],
      );
      const series = rows[0];
      if (!series) return null;
      if (series.publication_state === 'imported') return null;

      return {
        id: series.id,
        slug: series.slug,
        title: series.title_ru || series.title_original,
        titleOriginal: series.title_original,
        titleEn: series.title_en,
        description: series.description_ru || series.description_en || '',
        descriptionRu: series.description_ru,
        archived: series.archived_at !== null,
      };
    },

    /**
     * Сериал по адресу.
     *
     * `archived_at IS NOT NULL` НЕ исключается здесь: страница архивного
     * сериала должна ответить 410 с человеческим текстом (EC-C1), а не 404 —
     * иначе посетитель решит, что такого сериала не было.
     *
     * @param {string} slug
     * @returns {Promise<object|null>}
     */
    async bySlug(slug) {
      const { rows } = await pool.query(
        `SELECT id, slug, imdb_key, tmdb_id,
                title_ru, title_en, title_original,
                year_start, year_end, description_ru, description_en,
                exit_state, publication_state, archived_at, reasons, level
           FROM e_series
          WHERE slug = $1`,
        [slug],
      );
      const series = rows[0];
      if (!series) return null;
      if (series.publication_state === 'imported') return null;

      const images = await imagesOf(pool, series.id);
      const [genres, people, seasons, ratings, nextRelease] = await Promise.all([        genresOf(pool, series.id),
        peopleOf(pool, series.id),
        seasonsOf(pool, series.id),
        ratingsOf(pool, series.id),
        nextReleaseOf(pool, series.id),
      ]);

      return {
        id: series.id,
        slug: series.slug,
        imdbKey: series.imdb_key,
        tmdbId: series.tmdb_id,
        title: series.title_ru || series.title_original,
        titleOriginal: series.title_original,
        titleEn: series.title_en,
        yearStart: series.year_start,
        yearEnd: series.year_end,
        description: series.description_ru || series.description_en || '',
        // Английский адрес без перевода отдаётся как есть, но помечается
        // noindex: переводить описание «на лету» нечем (R-SEO-04).
        descriptionRu: series.description_ru,
        exitState: series.exit_state,
        archived: series.archived_at !== null,
        level: series.level,
        reasons: series.reasons ?? [],
        posterWidth: images.poster,
        backdropWidth: images.backdrop,
        genres,
        people,
        seasons,
        ratings,
        nextRelease,
      };
    },
  };
}

/**
 * Ширины картинок, уже загруженных для сериала.
 *
 * Слой данных не строит адрес: он не знает локали, а адрес картинки её
 * содержит (ADR-003). Поэтому отдаём роль и ширину, а вид собирает ссылку сам.
 *
 * Ширина выбирается та, что не больше нужной и самая большая из таких: на
 * маленьком экране большой файл всё равно не покажут, а грузить придётся.
 *
 * @param {object} pool
 * @param {number} seriesId
 * @returns {Promise<{poster: number|null, backdrop: number|null}>}
 */
async function imagesOf(pool, seriesId) {
  const { rows } = await pool.query(
    `SELECT i.role, iv.width
       FROM e_image i
       JOIN e_image_variant iv ON iv.image_id = i.id
      WHERE i.series_id = $1
      ORDER BY i.role, iv.width`,
    [seriesId],
  );

  const fit = (role, wanted) => {
    const widths = [...new Set(rows.filter((row) => row.role === role).map((row) => row.width))];
    if (!widths.length) return null;
    return widths.filter((width) => width <= wanted).sort((a, b) => b - a)[0] ?? widths[0];
  };

  return { poster: fit('poster', 342), backdrop: fit('backdrop', 1280) };
}

async function genresOf(pool, seriesId) {
  const { rows } = await pool.query(
    `SELECT g.code, g.name_ru FROM e_series_genre sg
       JOIN e_genre g ON g.code = sg.genre_code
      WHERE sg.series_id = $1 AND g.active
      ORDER BY g.name_ru`,
    [seriesId],
  );
  return rows;
}

/** Режиссёры и «В ролях»: человек без `imdb_key` не попадает (M2 — только IMDb). */
async function peopleOf(pool, seriesId) {
  const { rows } = await pool.query(
    `SELECT p.slug, p.name, sp.role
       FROM e_series_person sp
       JOIN e_person p ON p.id = sp.person_id
      WHERE sp.series_id = $1
      ORDER BY sp.role, sp.ordinal
      LIMIT 12`,
    [seriesId],
  );
  const directors = rows.filter((row) => row.role === 'director').slice(0, 5);
  const cast = rows.filter((row) => row.role === 'actor').slice(0, 10);
  return { directors, cast, total: rows.length };
}

/**
 * Сезоны с сериями и датами.
 *
 * Спецвыпуски (номер 0) в список не попадают: они скрыты по умолчанию (H-38).
 */
async function seasonsOf(pool, seriesId) {
  const { rows: seasons } = await pool.query(
    `SELECT id, number, title_ru FROM e_season
      WHERE series_id = $1 AND number > 0
      ORDER BY number`,
    [seriesId],
  );
  if (!seasons.length) return [];

  const { rows: episodes } = await pool.query(
    `SELECT e.season_id, e.number, e.title_ru, e.runtime_min, r.release_date
       FROM e_episode e
       JOIN e_season s ON s.id = e.season_id
       LEFT JOIN LATERAL (
         SELECT rl.release_date
           FROM e_release rl
           JOIN e_release_episode rle ON rle.release_id = rl.id
          WHERE rle.episode_id = e.id
          ORDER BY rl.release_date
          LIMIT 1
       ) r ON true
      WHERE s.series_id = $1 AND s.number > 0
      ORDER BY s.number, e.number`,
    [seriesId],
  );

  return seasons.map((season) => ({
    id: season.id,
    number: season.number,
    title: season.title_ru || '',
    episodes: episodes
      .filter((row) => row.season_id === season.id)
      .slice(0, EPISODES_LIMIT)
      .map((row) => ({
        number: row.number,
        title: row.title_ru || '',
        runtime: row.runtime_min,
        date: row.release_date,
      })),
  }));
}

/** Три рейтинга в шапке: IMDb и TMDB из источников, третий — агрегат сайта (M4). */
async function ratingsOf(pool, seriesId) {
  // Порог голосов тот же, что в каталоге: «8,5 от трёх человек» не должно
  // появляться на карточке после того, как из выдачи каталога исчезло (M2 §0).
  const { ratingFloor } = await importSettings(pool);
  const { rows } = await pool.query(
    `SELECT platform, value, votes FROM e_external_rating
      WHERE series_id = $1 AND (votes IS NULL OR votes >= $2)`,
    [seriesId, ratingFloor],
  );
  const map = new Map(rows.map((row) => [row.platform, { value: Number(row.value), votes: row.votes }]));
  // Агрегат сайта — сглаженное среднее, а не деление на голоса (OP-03, H-24):
  // «10» от одного человека не должно стоять рядом с «8,5» от тысячи.
  const site = await pool.query(
    `SELECT (sum_value + prior_mean * prior_weight)::float
              / NULLIF(votes + prior_weight, 0) AS value,
            votes, prior_mean, prior_weight
       FROM e_series_rating_stat WHERE series_id = $1`,
    [seriesId],
  );
  const siteRow = site.rows[0];
  return {
    imdb: map.get('imdb') ?? null,
    tmdb: map.get('tmdb') ?? null,
    // Порог показа у рейтинга сайта свой (M4 §0: 5 голосов — `rating.min_votes_display`),
    // а не порог внешних рейтингов: с F-04-03 то же число и с тем же порогом
    // показывается в блоке оценки, и разойтись им неоткуда. Порог внешних тут
    // не годится — на 5–9 голосах шапка молчала бы, а блок показывал число.
    site: siteRow && siteRow.value && siteRow.votes >= RATING.minVotesDisplay
      ? { value: Number(siteRow.value), votes: siteRow.votes }
      : null,
  };
}

/** Ближайший выход: серия с датой не в прошлом. */
async function nextReleaseOf(pool, seriesId) {
  const { rows } = await pool.query(
    `SELECT r.release_date, e.number, s.number AS season_number, e.title_ru
       FROM e_release r
       JOIN e_season s ON s.id = r.season_id
       LEFT JOIN e_release_episode rle ON rle.release_id = r.id
       LEFT JOIN e_episode e ON e.id = rle.episode_id
      WHERE s.series_id = $1 AND r.release_date >= CURRENT_DATE
      ORDER BY r.release_date
      LIMIT 1`,
    [seriesId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    date: row.release_date,
    season: row.season_number,
    number: row.number,
    title: row.title_ru || '',
  };
}