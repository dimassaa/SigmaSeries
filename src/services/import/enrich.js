// Обогащение сериала из TMDB: описания, статусы, сезоны и серии (F-12-03).
//
// Всё, что приходит из TMDB, считается недоверенным (R-SEC-15): длина
// ограничивается, разметка не пропускается, а битое значение не должно
// ронять прогон. Проверка года и состояния выхода живёт не здесь — это
// F-12-06; здесь только сырой слой, из которого та посчитает.
//
// Сколько стоит один сериал: два запроса карточки (ru и en) плюс по одному
// на сезон. Замер спецификации — около 13 запросов и 26 минут на 1197 сериалов.

import { IMPORT_SETTINGS } from '../../config/settings.js';

/** Пределы из F-12-03 §9: всё, что длиннее, обрезается и помечается. */
export const LIMITS = {
  title: 300,
  description: 5000,
  cast: 10,
};

/** Состояния TMDB → состояние выхода (F-12-06 §4(4)). */
export const STATUS_BY_TMDB = {
  Ended: 'ended',
  Canceled: 'cancelled',
  'In Production': 'announced',
  Planned: 'announced',
  Pilot: 'announced',
  'Returning Series': 'waiting',
};

/** Ставка выхода для RU/BY, дальше — по данным другой страны (H-25). */
const PREFERRED_AGE_COUNTRIES = ['RU', 'BY'];

/**
 * Обрезает строку и говорит, пришлось ли.
 *
 * Обрезка молча опаснее отказа: усечённое описание выглядит как целое.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {{text:string, truncated:boolean}}
 */
export function clampText(value, max) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/**
 * Разметка из источника не исполняется (R-SEC-15).
 *
 * TMDB отдаёт описание с тегами `<i>` и `<a>`: наша схема экранирует всё
 * при выводе, поэтому хранить сырые теги незачем, а вдруг где-то текст
 * попадёт в атрибут — вычистить здесь дешевле.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {{text:string, truncated:boolean}}
 */
export function cleanText(value, max) {
  const raw = clampText(value, max);
  const text = raw.text.replace(/<[^>]*>/g, '');
  return { text, truncated: raw.truncated || text.length !== raw.text.length };
}

/**
 * Собирает сырой слой сериала из карточки TMDB.
 *
 * @param {object} options
 * @param {object} options.detailsRu карточка на `ru-RU`
 * @param {object} [options.detailsEn] карточка на `en-US`
 * @param {object[]} [options.seasons] сезоны с сериями
 * @param {object} options.imdb данные отбора: tconst, startYear, endYear, genres, votes, rating
 * @returns {object}
 */
export function buildRawSeries({ detailsRu, detailsEn, seasons = [], imdb }) {
  const titles = {
    original: clampText(detailsRu?.original_name || detailsRu?.name, LIMITS.title),
    ru: cleanText(detailsRu?.name, LIMITS.title),
    en: cleanText(detailsEn?.name ?? detailsRu?.name, LIMITS.title),
  };

  const descriptions = {
    ru: cleanText(detailsRu?.overview, LIMITS.description),
    en: cleanText(detailsEn?.overview, LIMITS.description),
  };
  // Английское описание нужно, только когда русского нет: два языка хранить
  // незачем, если русский есть — так требует «пригодна к показу».
  if (descriptions.ru.text) descriptions.en = { text: '', truncated: descriptions.en.truncated };

  return {
    tconst: imdb.tconst,
    tmdbId: detailsRu?.id ?? null,
    status: detailsRu?.status ?? null,
    titles,
    descriptions,
    years: {
      start: imdb.startYear ?? yearOfDate(detailsRu?.first_air_date),
      end: imdb.endYear ?? yearOfDate(detailsRu?.last_air_date),
    },
    nextEpisode: dates(detailsRu?.next_episode_to_air),
    lastEpisode: dates(detailsRu?.last_episode_to_air),
    genres: (detailsRu?.genres ?? []).map((genre) => ({ code: genre.id, name: genre.name })),
    imdbGenres: imdb.genres ?? [],
    votes: { average: imdb.numVotes ? imdb.averageRating : null, count: imdb.numVotes ?? null },
    tmdbVotes: {
      average: detailsRu?.vote_average ?? null,
      count: detailsRu?.vote_count ?? null,
    },
    ageRating: pickAgeRating(detailsRu?.content_ratings?.results),
    // Пути к картинкам нужны следующей стадии (F-12-05), а перечитывать ради
    // них API означало бы второй обход по всему каталогу. Список фонов
    // небольшой: путь, размеры, оценка и язык — без самих байтов.
    tmdb: {
      posterPath: detailsRu?.poster_path ?? null,
      // Фон шапки — обычный backdrop_path. Фоны из images.backdrops почти
      // всегда языковые, то есть с выжженным текстом, и годятся только как
      // переводы; чистый лежит именно здесь (F-12-05 §4).
      backdropPath: detailsRu?.backdrop_path ?? null,
      backdrops: (detailsRu?.images?.backdrops ?? []).map((row) => ({
        filePath: row.file_path,
        width: row.width,
        height: row.height,
        voteAverage: row.vote_average,
        language: row.iso_639_1 ?? null,
      })),
    },
    keywords: (detailsRu?.keywords?.results ?? []).map((k) => k.name).slice(0, 50),
    // Страна производства и сети приходят из той же карточки, что и всё
    // остальное (F-12-03 §4(4)). IMDb в датасетах стран не отдаёт, поэтому
    // источник один — TMDB, и второй запрос не нужен.
    countries: (detailsRu?.origin_country ?? []).map((code) => String(code).toUpperCase()).slice(0, 8),
    networks: (detailsRu?.networks ?? [])
      .filter((network) => Number.isInteger(network?.id) && network?.name)
      .map((network) => ({
        id: network.id,
        name: String(network.name).slice(0, 200),
        countryCode: network.origin_country ? String(network.origin_country).toUpperCase() : null,
      }))
      .slice(0, 12),
    seasons: seasons.map(normalizeSeason),
  };
}

/** Год из `YYYY-MM-DD`. */
function yearOfDate(date) {
  if (!date) return null;
  const year = Number(String(date).slice(0, 4));
  return Number.isInteger(year) ? year : null;
}

/** Ближайшая и прошлая серия: TMDB отдаёт это одним объектом с полями. */
function dates(episode) {
  if (!episode) return null;
  return {
    season: episode.season_number ?? null,
    number: episode.episode_number ?? null,
    date: episode.air_date || null,
  };
}

/**
 * Выбор возрастной метки (H-25): сначала RU/BY, иначе первая доступная.
 *
 * Отсутствие метки карточку неполной не делает (EC-D13) — это информационная
 * причина, а не пробел в содержании.
 *
 * @param {{iso_3166_1:string, rating:string}[]} [results]
 * @returns {{code:string, rating:string}|null}
 */
export function pickAgeRating(results) {
  if (!Array.isArray(results) || !results.length) return null;
  const preferred = results.find((row) => PREFERRED_AGE_COUNTRIES.includes(row.iso_3166_1));
  const chosen = preferred ?? results[0];
  return { code: chosen.iso_3166_1, rating: chosen.rating };
}

/**
 * Нормализует сезон: номер, названия и серия.
 *
 * Сезон 0 — спецвыпуски: он загружается, но в прогресс не входит (H-38).
 *
 * @param {object} season ответ `/season/{n}`
 * @returns {object}
 */
export function normalizeSeason(season) {
  return {
    number: season?.season_number ?? null,
    titleRu: cleanText(season?.name, LIMITS.title),
    descriptionRu: cleanText(season?.overview, LIMITS.description),
    episodes: (season?.episodes ?? []).map((episode) => ({
      number: episode.episode_number ?? null,
      titleRu: cleanText(episode?.name, LIMITS.title),
      descriptionRu: cleanText(episode?.overview, LIMITS.description),
      date: episode?.air_date || null,
      runtimeMin: episode?.runtime ?? null,
    })),
  };
}

/**
 * Обогащает один сериал: карточка на двух языках и его сезоны.
 *
 * @param {object} options
 * @param {number} options.tmdbId
 * @param {object} options.imdb
 * @param {object} options.tmdb клиент TMDB
 * @returns {Promise<object>} сырой слой
 */
export async function enrichSeries({ tmdbId, imdb, tmdb }) {
  const [detailsRu, detailsEn] = await Promise.all([
    tmdb.getDetailsLocalized(tmdbId, 'ru-RU'),
    tmdb.getDetailsLocalized(tmdbId, 'en-US'),
  ]);

  // Номеров сезонов берём из карточки: один ответ на сезон, а не перебор
  // 1..N — у части сериалов сезоны нумеруются с пропуском.
  const numbers = (detailsRu?.seasons ?? [])
    .map((season) => season.season_number)
    .filter((number) => Number.isInteger(number) && number > 0);

  const seasons = [];
  for (const number of numbers) {
    const season = await tmdb.getSeason(tmdbId, number, 'ru-RU').catch(() => null);
    // Незагруженный сезон не роняет сериал: он помечается и повторится в
    // следующем запуске (F-12-03 §5). Нормализуются сезоны в buildRawSeries —
    // нормализовать их здесь, а потом ещё раз там значило бы потерять номер.
    if (season) seasons.push(season);
  }

  return buildRawSeries({ detailsRu, detailsEn, seasons, imdb });
}

/**
 * Обогащает список сериалов параллельно (`import.api_concurrency`).
 *
 * @param {object} options
 * @param {{tmdbId:number, imdb:object}[]} options.items
 * @param {object} options.tmdb
 * @param {number} [options.concurrency]
 * @returns {Promise<{raw:object|null, error:string|null}[]>}
 */
export async function enrichAll({ items, tmdb, concurrency = IMPORT_SETTINGS.apiConcurrency }) {
  const out = new Array(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        out[index] = { raw: await enrichSeries({ ...items[index], tmdb }), error: null };
      } catch (error) {
        out[index] = { raw: null, error: String(error?.message ?? error) };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
}