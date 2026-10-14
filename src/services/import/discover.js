// «Новинки и идущие» через TMDB (F-12-04).
//
// Обзор TMDB отвечает на два разных вопроса — «что началось недавно» и «что
// выходит в окне», — и ни один из них не отвечает на второй. Поэтому обзоров
// два, а результат один: так в календарь попадает и свежее, и то, что уже
// выходит, но ещё не закончилось.
//
// Исключение жанров обязано совпадать с путём IMDb (DEC-022): сериал,
// отсечённый при отборе по IMDb-рейтингу, не должен проходить через TMDB.

import { EXCLUDED_GENRES_TMDB, IMPORT_SETTINGS } from '../../config/settings.js';

export { EXCLUDED_GENRES_TMDB };

/** Сколько страниц обзора берём за запуск (§9). */
export const MAX_PAGES = 5;

/**
 * Границы окна дат.
 *
 * Месяц считается календарным, а не как «минус 30 дней»: при `new_window_months
 * = 12` отсчёт от 365 дней зимой съел бы лишний месяц, и новинкиDecember-январь
 * выпадали бы из каталога.
 *
 * @param {{today?: Date, until: string, months?: number}} options
 * @returns {{newFrom: string, airFrom: string, airTo: string}}
 */
export function windowBounds({ today = new Date(), until, months = IMPORT_SETTINGS.newWindowMonths }) {
  const month = (date, delta) => {
    const shifted = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, date.getUTCDate()));
    return shifted.toISOString().slice(0, 10);
  };
  const todayIso = today.toISOString().slice(0, 10);
  return { newFrom: month(today, -months), airFrom: todayIso, airTo: until };
}

/**
 * Причина включения по набору обзоров, где сериал встретился (§4).
 *
 * @param {string[]} reasons
 * @returns {'new'|'airing'|'both'}
 */
export function reasonOf(reasons) {
  const set = new Set(reasons);
  if (set.size > 1) return 'both';
  return set.has('airing') ? 'airing' : 'new';
}

/**
 * Объединяет обзоры и режет по потолку.
 *
 * Сортировка по популярности TMDB, а не по дате: из трёх тысяч подходящих в
 * каталог должны попасть те, о которых знают, а не те, что вышли вчера
 * (EC-I7).
 *
 * @param {{reason:'new'|'airing', items: object[]}[]} windows
 * @param {{cap?: number}} [options]
 * @returns {object[]} отобранные позиции с полем `reason`
 */
export function mergeDiscoveries(windows, { cap = IMPORT_SETTINGS.newCap } = {}) {
  const byId = new Map();
  for (const window of windows) {
    for (const item of window.items ?? []) {
      const known = byId.get(item.id);
      if (known) {
        known.reasons.push(window.reason);
        continue;
      }
      byId.set(item.id, { ...item, reasons: [window.reason] });
    }
  }

  return [...byId.values()]
    .map((row) => ({ ...row, reason: reasonOf(row.reasons) }))
    .sort((a, b) => {
      if ((b.popularity ?? 0) !== (a.popularity ?? 0)) return (b.popularity ?? 0) - (a.popularity ?? 0);
      return a.id - b.id;   // при равенстве — по идентификатору, чтобы порядок не прыгал
    })
    .slice(0, cap);
}

/**
 * Превращает имена жанров в идентификаторы TMDB.
 *
 * Незнакомое имя возвращается отдельно, а не теряется: если TMDB переименует
 * жанр, исключение потеряет силу, и это должно попасть в отчёт, а не
 * остаться незамеченным.
 *
 * @param {string[]} names
 * @param {Record<string, number>} genreMap имя → идентификатор
 * @returns {{ids: number[], unresolved: string[]}}
 */
export function resolveExcludedGenres(names, genreMap) {
  const ids = [];
  const unresolved = [];
  for (const name of names) {
    const id = genreMap[name];
    if (id === undefined) unresolved.push(name);
    else ids.push(id);
  }
  return { ids, unresolved };
}

/**
 * Собирает кандидатов из обзоров TMDB.
 *
 * @param {object} deps
 * @param {object} deps.tmdb клиент из `createTmdbClient`
 * @param {string} deps.until `import.until`
 * @param {Date} [deps.today]
 * @param {number} [deps.cap]
 * @param {number} [deps.pages]
 * @returns {Promise<{items: object[], unresolvedGenres: string[]}>}
 */
export async function discoverCandidates({ tmdb, until, today = new Date(), cap = IMPORT_SETTINGS.newCap, pages = MAX_PAGES }) {
  const genreMap = await tmdb.getTvGenres();
  const { ids, unresolved } = resolveExcludedGenres(EXCLUDED_GENRES_TMDB, genreMap);
  const bounds = windowBounds({ today, until });

  const common = {
    sort_by: 'popularity.desc',
    include_adult: 'false',
    language: 'ru-RU',
    ...(ids.length ? { without_genres: ids.join(',') } : {}),
  };

  // Обзор «вышло в окне» ограничен пятью страницами ещё и потому, что он
  // самый широкий: в спайке под условие попадало 2183 сериала.
  const [newItems, airingItems] = await Promise.all([
    tmdb.discoverTv({ ...common, first_air_date_gte: bounds.newFrom, first_air_date_lte: bounds.airTo }, pages),
    tmdb.discoverTv({ ...common, air_date_gte: bounds.airFrom, air_date_lte: bounds.airTo }, pages),
  ]);

  return {
    items: mergeDiscoveries(
      [{ reason: 'new', items: newItems }, { reason: 'airing', items: airingItems }],
      { cap },
    ),
    unresolvedGenres: unresolved,
  };
}

/** Ключ позиции для сериала без IMDb-идентификатора (§4). */
export function internalKey(tmdbId) {
  return `tmdb:${tmdbId}`;
}