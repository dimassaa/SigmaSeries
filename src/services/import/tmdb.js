// Клиент TMDB и проверка пары IMDb ↔ TMDB (F-12-02).
//
// Ошибки здесь асимметричны, и отсюда всё остальное. Ложное совпадение склеит
// два разных сериала в один: постер, описание и отзывы одного окажутся у
// другого, и заметят это читатели, а не тесты. Пропуск же означает лишь
// «карточка неполная», чинится вручную и стоит одного сериала в каталоге.
// Поэтому сомнение всегда разрешается в пропуск, а не в догадку (F-12-02 §4,
// H-28).

import { IMPORT_SETTINGS } from '../../config/settings.js';

/** Ошибка TMDB, дошедшая до предела попыток. */
export class TmdbError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TmdbError';
    this.status = status;
  }
}

/** Задержки между попытками для 5xx и сети (F-12-09 §3). */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

/** К 429 прибавляем 250 мс, чтобы не ловить отказ снова на границе. */
const RETRY_AFTER_PAD_MS = 250;

/** Сколько раз пробуем до отказа (F-12-09 §9). */
const MAX_ATTEMPTS = 5;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Год из `YYYY-MM-DD`; в TMDB год выхода — это год начала, не завершения. */
export function yearOf(date) {
  if (!date || typeof date !== 'string') return null;
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) ? year : null;
}

/**
 * Проверяет пару по обратному идентификатору и году (H-28).
 *
 * Название не сверяется: в спайке оба «расхождения» оказались разными
 * локализациями одного и того же сериала.
 *
 * @param {{tconst:string, startYear:number|null, details:object}} pair
 * @returns {{ok:boolean, outcome:'ok'|'pair_doubt', reason?:string}}
 */
export function verifyPair({ tconst, startYear, details }) {
  const reverse = details?.external_ids?.imdb_id;
  if (!reverse) return { ok: false, outcome: 'pair_doubt', reason: 'no_reverse_id' };
  if (reverse !== tconst) return { ok: false, outcome: 'pair_doubt', reason: 'reverse_id_mismatch' };

  // Год IMDb иногда отсутствует (\N). Тогда проверять нечего, и обратного
  // идентификатора достаточно: он однозначнее названия.
  if (startYear === null || startYear === undefined) return { ok: true, outcome: 'ok' };

  const tmdbYear = yearOf(details.first_air_date);
  if (tmdbYear === null) return { ok: false, outcome: 'pair_doubt', reason: 'no_tmdb_year' };
  if (Math.abs(tmdbYear - startYear) > 1) return { ok: false, outcome: 'pair_doubt', reason: 'year_mismatch' };

  return { ok: true, outcome: 'ok' };
}

/**
 * Выбирает кандидата из ответа `/find`.
 *
 * Ответ может содержать кино, людей и сериалы — берём только сериалы. Их
 * бывает несколько (сезон и мини-сериал с одним IMDb-идентификатором), и
 * тогда выбирает тот, чей обратный идентификатор совпал: это то же правило,
 * что и при проверке пары, только применённое заранее (§5).
 *
 * @param {object} options
 * @param {object[]} options.results
 * @param {number|null} [options.tconst]
 * @param {(id:number) => Promise<object>} options.getDetails
 * @returns {Promise<{tmdbId:number|null, outcome:string, reason?:string}>}
 */
export async function pickCandidate({ results, tconst = null, getDetails }) {
  const tv = (results ?? []).filter((row) => row.media_type === 'tv');
  if (!tv.length) return { tmdbId: null, outcome: 'no_tmdb', reason: 'not_found' };

  if (tv.length === 1 || !tconst) return { tmdbId: tv[0].id, outcome: 'ok' };

  const cards = await Promise.all(tv.map((row) => getDetails(row.id)));
  const matched = cards.findIndex((card) => card?.external_ids?.imdb_id === tconst);
  if (matched === -1) return { tmdbId: null, outcome: 'pair_doubt', reason: 'ambiguous' };
  return { tmdbId: tv[matched].id, outcome: 'ok' };
}

/**
 * Клиент TMDB с ограничением скорости и повторами.
 *
 * @param {object} options
 * @param {string} options.token ключ API (v4 — Bearer, v3 — api_key)
 * @param {string} [options.baseUrl]
 * @param {number} [options.rps] запросов в секунду (`import.rps`)
 * @param {(ms:number) => Promise<void>} [options.sleep]
 * @returns {{findByImdbId: Function, getDetails: Function}}
 */
export function createTmdbClient({ token, baseUrl = 'https://api.themoviedb.org/3', rps = IMPORT_SETTINGS.rps, sleep = wait }) {
  if (!token) throw new Error('не задан TMDB_TOKEN: сопоставление без ключа невозможно');

  // Токен v4 — длинный JWT, v3 — 32 символа. Ошибиться здесь нельзя: тихо
  // ушедший 401 выглядел бы как «сериал не найден», и тысяча позиций ушла бы
  // в no_tmdb вместо того, чтобы сказать «ключ неверный».
  const isBearer = token.length > 40;

  /** Отметка времени последнего запроса: пауза 1/rps между запросами. */
  let lastAt = 0;

  /** Справочник жанров: один запрос на прогон, список не меняется. */
  let genreCache = null;

  async function request(pathname) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const gap = Math.round(1000 / rps) - (Date.now() - lastAt);
      if (gap > 0) await sleep(gap);
      lastAt = Date.now();

      let response;
      try {
        const url = new URL(`${baseUrl}${pathname}`);
        if (!isBearer) url.searchParams.set('api_key', token);
        const headers = isBearer ? { Authorization: `Bearer ${token}` } : {};
        response = await fetch(url, { headers });
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) throw new TmdbError(`сеть недоступна: ${error.message}`);
        await sleep(BACKOFF_MS[attempt - 1]);
        continue;
      }

      if (response.status === 401) {
        throw new TmdbError('TMDB отклонил ключ (401) — неверный ключ, запуск прерывается', 401);
      }
      if (response.status === 404) return { notFound: true };
      if (response.status === 429) {
        const header = Number(response.headers.get('retry-after') ?? 1);
        const waitMs = Math.max(0, header * 1000 + RETRY_AFTER_PAD_MS);
        if (attempt === MAX_ATTEMPTS) throw new TmdbError('TMDBRate limit не снялся после 5 попыток', 429);
        await sleep(waitMs);
        continue;
      }
      if (response.status >= 500) {
        if (attempt === MAX_ATTEMPTS) {
          throw new TmdbError(`TMDB отвечает ${response.status} после ${MAX_ATTEMPTS} попыток`, response.status);
        }
        await sleep(BACKOFF_MS[attempt - 1]);
        continue;
      }
      if (!response.ok) throw new TmdbError(`TMDB отвечает ${response.status}`, response.status);
      return response.json().catch(() => ({}));
    }
    throw new TmdbError('запрос не выполнен: попытки исчерпаны');
  }

  return {
    /**
     * Ищет сериал по внешнему идентификатору IMDb (F-12-02 §4).
     *
     * @param {string} tconst
     * @returns {Promise<{tvResults: object[], notFound?: boolean}>}
     */
    async findByImdbId(tconst) {
      const body = await request(`/find/${encodeURIComponent(tconst)}?external_source=imdb_id`);
      if (body?.notFound) return { tvResults: [], notFound: true };
      return { tvResults: body?.tv_results ?? [], notFound: false };
    },

    /**
     * Карточка сериала с внешними идентификаторами.
     *
     * @param {number} id
     * @returns {Promise<object>}
     */
    async getDetails(id) {
      return request(`/tv/${encodeURIComponent(String(id))}?append_to_response=external_ids`);
    },

    /**
     * Карточка сериала для обогащения (F-12-03 §4(1)).
     *
     * Запрашивается на языке, поэтому русское и английское названия приходят
     * двумя запросами, а не одним ответом со всеми переводами: переводы всех
     * языков — это сотни килобайт на сериал, и хранить их в базе незачем.
     *
     * @param {number} id
     * @param {string} language `ru-RU` или `en-US`
     * @returns {Promise<object>}
     */
    async getDetailsLocalized(id, language) {
      return request(
        `/tv/${encodeURIComponent(String(id))}`
        + `?language=${encodeURIComponent(language)}`
        + '&append_to_response=content_ratings,external_ids,keywords,images',
      );
    },

    /**
     * Сезон со всеми сериями (F-12-03 §4(2)).
     *
     * Отдельный запрос на серию не делается: TMDB отдаёт их списком в одном
     * ответе, а на 1000 сериалов разница составила бы тысячи запросов.
     *
     * @param {number} id
     * @param {number} number
     * @param {string} language
     * @returns {Promise<object>}
     */
    async getSeason(id, number, language) {
      return request(
        `/tv/${encodeURIComponent(String(id))}/season/${encodeURIComponent(String(number))}`
        + `?language=${encodeURIComponent(language)}`,
      );
    },

    /**
     * Справочник жанров сериалов: имя → идентификатор.
     *
     * Нужен, чтобы исключать жанры поимённо: идентификаторы у TMDB заданы
     * числами, а DEC-022 говорит о списке имён. Запрашивается один раз и
     * запоминается — список не меняется от прогона к прогону.
     *
     * @returns {Promise<Record<string, number>>}
     */
    async getTvGenres() {
      if (!genreCache) {
        const body = await request('/genre/tv/list?language=en');
        genreCache = Object.fromEntries((body?.genres ?? []).map((row) => [row.name, row.id]));
      }
      return genreCache;
    },

    /**
     * Обзор сериалов с пагинацией (F-12-04 §4, §9).
     *
     * Ограничение скорости здесь сделано отдельно от `request()`: обзор
     * делает до пяти запросов подряд, и каждому из них нужна своя пауза,
     * иначе всплеск уходит мимо ограничения.
     *
     * @param {Record<string, string|number>} params фильтры TMDB
     * @param {number} [pages] сколько страниц взять
     * @returns {Promise<object[]>}
     */
    async discoverTv(params, pages = 1) {
      const items = [];
      for (let page = 1; page <= pages; page += 1) {
        const url = new URL(`${baseUrl}/discover/tv`);
        for (const [key, value] of Object.entries({ ...params, page })) {
          url.searchParams.set(key, String(value));
        }
        if (!isBearer) url.searchParams.set('api_key', token);
        const headers = isBearer ? { Authorization: `Bearer ${token}` } : {};
        const gap = Math.round(1000 / rps) - (Date.now() - lastAt);
        if (gap > 0) await sleep(gap);
        lastAt = Date.now();

        const response = await fetch(url, { headers });
        if (response.status === 401) {
          throw new TmdbError('TMDB отклонил ключ (401) — неверный ключ, запуск прерывается', 401);
        }
        if (!response.ok) throw new TmdbError(`TMDB отвечает ${response.status}`, response.status);

        const body = await response.json().catch(() => ({}));
        const results = body?.results ?? [];
        items.push(...results);
        // Страниц бывает меньше запрошенного: идти дальше незачем.
        if (!results.length || page >= (body?.total_pages ?? pages)) break;
      }
      return items;
    },
  };
}