// Данные слоя подробной карточки постера (F-02-07, UI-10).
//
// Слой показывает суть сериала, не уходя со списка: год, страна, все жанры,
// рейтинги, описание, режиссёра и первых актёров. На карточке каталога этого
// нет, поэтому слой спрашивает отдельно — по намерению (R-PERF-11), с кэшем
// на стороне клиента.
//
// Источник отдаёт поля как есть: цепочка перевода (R-I18N-06), подписи и
// разметка — дело вида.

import { importSettings } from './settings.js';
import { RATING } from '../settings.js';

/** Сколько знаков описания уходит в слой: четыре строки мелким шрифтом. */
const DESCRIPTION_LIMIT = 600;

/** Сколько актёров показывает слой. */
const CAST_LIMIT = 5;

/**
 * Источник данных слоя постера.
 *
 * @param {import('pg').Pool} pool
 * @returns {{forSlug: Function}}
 */
export function pgPosterCard(pool) {
  return {
    /**
     * Данные слоя для сериала по адресу.
     *
     * Неопубликованный сериал слоя не получает: его нет и в списках, а слой
     * на списке — продолжение списка, а не отдельная страница.
     *
     * @param {string} slug
     * @returns {Promise<object|null>}
     */
    async forSlug(slug) {
      const { rows } = await pool.query(
        `SELECT id, slug, title_ru, title_en, title_original,
                year_start, year_end, description_ru, description_en, exit_state
           FROM e_series
          WHERE slug = $1 AND publication_state <> 'imported'`,
        [slug],
      );
      const series = rows[0];
      if (!series) return null;

      const [genres, countries, people, ratings, nextRelease] = await Promise.all([
        genresOf(pool, series.id),
        countriesOf(pool, series.id),
        peopleOf(pool, series.id),
        ratingsOf(pool, series.id),
        nextReleaseOf(pool, series.id),
      ]);

      return {
        slug: series.slug,
        titleRu: series.title_ru,
        titleEn: series.title_en,
        titleOriginal: series.title_original,
        yearStart: series.year_start,
        yearEnd: series.year_end,
        descriptionRu: cut(series.description_ru),
        descriptionEn: cut(series.description_en),
        exitState: series.exit_state,
        genres,
        countries,
        ratings,
        directors: people.directors,
        cast: people.cast,
        nextRelease,
      };
    },
  };
}

/** Обрезанное по длине описание: ответ слоя не должен раздуваться. */
function cut(text) {
  if (!text) return '';
  if (text.length <= DESCRIPTION_LIMIT) return text;
  return `${text.slice(0, DESCRIPTION_LIMIT).trimEnd()}…`;
}

/** Все жанры сериала: в слое показываются все, а не один, как в каталоге. */
async function genresOf(pool, seriesId) {
  const { rows } = await pool.query(
    `SELECT g.code, g.name_ru, g.name_en
       FROM e_series_genre sg
       JOIN e_genre g ON g.code = sg.genre_code
      WHERE sg.series_id = $1 AND g.active
      ORDER BY g.name_ru`,
    [seriesId],
  );
  return rows;
}

/** Страны производства: коды ISO, названия — через `Intl.DisplayNames`. */
async function countriesOf(pool, seriesId) {
  const { rows } = await pool.query(
    `SELECT c.code
       FROM e_series_country sc
       JOIN e_country c ON c.code = sc.country_code
      WHERE sc.series_id = $1 AND c.active
      ORDER BY c.code
      LIMIT 3`,
    [seriesId],
  );
  return rows.map((row) => row.code);
}

/** Режиссёр (или создатель) и первые актёры. */
async function peopleOf(pool, seriesId) {
  const { rows } = await pool.query(
    `SELECT p.slug, p.name, sp.role, sp.ordinal
       FROM e_series_person sp
       JOIN e_person p ON p.id = sp.person_id
      WHERE sp.series_id = $1
      ORDER BY sp.role, sp.ordinal`,
    [seriesId],
  );
  const directors = rows.filter((row) => row.role === 'director' || row.role === 'creator')
    .slice(0, 2);
  const cast = rows.filter((row) => row.role === 'actor').slice(0, CAST_LIMIT);
  return { directors, cast };
}

/**
 * Рейтинги: IMDb и TMDB из источников, третий — агрегат сайта.
 *
 * Пороги те же, что в шапке сериала: рейтинг, который там не показан, в слое
 * тоже не должен появляться (M2 §0, M4 §0).
 */
async function ratingsOf(pool, seriesId) {
  const { ratingFloor } = await importSettings(pool);
  const { rows } = await pool.query(
    `SELECT platform, value, votes FROM e_external_rating
      WHERE series_id = $1 AND (votes IS NULL OR votes >= $2)`,
    [seriesId, ratingFloor],
  );
  const map = new Map(rows.map((row) => [row.platform, { value: Number(row.value), votes: row.votes }]));

  const site = await pool.query(
    `SELECT (sum_value + prior_mean * prior_weight)::float
              / NULLIF(votes + prior_weight, 0) AS value,
            votes
       FROM e_series_rating_stat WHERE series_id = $1`,
    [seriesId],
  );
  const siteRow = site.rows[0];
  return {
    imdb: map.get('imdb') ?? null,
    tmdb: map.get('tmdb') ?? null,
    site: siteRow && siteRow.value && siteRow.votes >= RATING.minVotesDisplay
      ? { value: Number(siteRow.value), votes: siteRow.votes }
      : null,
  };
}

/** Ближайший выход: строка состояния в слое говорит, когда ждать. */
async function nextReleaseOf(pool, seriesId) {
  const { rows } = await pool.query(
    `SELECT r.release_date, e.number, s.number AS season_number
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
  return { date: row.release_date, season: row.season_number, number: row.number };
}
