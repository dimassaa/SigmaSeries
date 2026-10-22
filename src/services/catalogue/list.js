// Источник данных каталога (F-02-03, S-02).
//
// Страница фильтруется и сортируется в базе: 1133 сериала, из которых треть
// отсеется фильтрами, и привезти их в Node, чтобы отсортировать в памяти, —
// значит держать в памяти весь каталог на каждый чих.
//
// Два правила, из-за которых сервис выглядит строже обычного:
//
//  • порядок и имена колонок приходят только из белого списка (R-SEC-16):
//    сортировка приходит из адреса, а адрес приходит от человека;
//  • размер страницы берётся из настроек, а не из аргумента: `limit` от
//    клиента запрещён (F-02-03 §7), иначе один запрос вернул бы весь каталог.

import pg from 'pg';

import { importSettings } from './settings.js';

/**
 * Порядок сортировки: имя из адреса → текст `ORDER BY`.
 *
 * Ключ не подставляется в запрос: значение берётся отсюда, поэтому «`votes);
 * DROP TABLE e_series`» в адресе остаётся строкой, а не командой. Имена колонок
 * — из внешнего запроса, а не из вложенного: сортировка идёт по результату.
 */
const SORTS = {
  // Популярность — по голосам IMDb: это единственное число, которым люди
  // пользуются в жизни, а не то, что придумал редактор.
  popular: 'votes DESC NULLS LAST, title ASC',
  rating: 'rating DESC NULLS LAST, title ASC',
  // «Новизна» — дата первой серии, а не год начала: сериал, вышедший в
  // сентябре, новее того, кто стартовал в январе и вернулся вторым сезоном.
  new: 'first_release DESC NULLS LAST, title ASC',
  title: 'title ASC',
};

const DEFAULT_SORT = 'popular';

/** Порядок состояний для человека; в базе он алфавитный и ничего не значит. */
const STATE_ORDER = ['airing', 'waiting', 'announced', 'ended', 'cancelled'];

const BASE_SELECT = `
  SELECT s.id,
         s.slug,
         coalesce(s.title_ru, s.title_en, s.title_original) AS title,
         s.year_start,
         s.year_end,
         s.exit_state,
         (SELECT g.code FROM e_series_genre sg JOIN e_genre g ON g.code = sg.genre_code
           WHERE sg.series_id = s.id ORDER BY g.code LIMIT 1) AS genre_code,
         (SELECT g.name_ru FROM e_series_genre sg JOIN e_genre g ON g.code = sg.genre_code
           WHERE sg.series_id = s.id ORDER BY g.code LIMIT 1) AS genre_name,
         r.value::float AS rating,
         r.votes,
         first.first_release,
         poster.width AS poster_width
    FROM e_series s
    LEFT JOIN e_external_rating r ON r.series_id = s.id AND r.platform = 'imdb'
    LEFT JOIN LATERAL (
      SELECT min(rel.release_date)::text AS first_release
        FROM e_season se JOIN e_release rel ON rel.season_id = se.id
       WHERE se.series_id = s.id
    ) first ON true
    LEFT JOIN LATERAL (
      SELECT iv.width FROM e_image_variant iv
        JOIN e_image i ON i.id = iv.image_id
       WHERE i.series_id = s.id AND i.role = 'poster'
       ORDER BY iv.width LIMIT 1
    ) poster ON true
   WHERE s.publication_state = 'published' AND s.archived_at IS NULL`;

/**
 * Источник данных каталога.
 *
 * @param {any} pool настоящий Pool или тестовый двойник с `query`
 */
export function pgCatalogueList(pool) {
  return {
    /**
     * Страница каталога.
     *
     * @param {object} [filters]
     * @param {string[]} [filters.genres] коды жанров; неизвестные игнорируются
     * @param {number|null} [filters.yearFrom]
     * @param {number|null} [filters.yearTo]
     * @param {number|null} [filters.ratingFrom] рейтинг IMDb «от»
     * @param {string[]} [filters.states] состояния выхода
     * @param {string[]} [filters.countries] коды стран ISO 3166-1
     * @param {(string|number)[]} [filters.networks] идентификаторы сетей TMDB
     * @param {string} [filters.sort] ключ из белого списка
     * @param {number} [filters.page] с единицы
     * @returns {Promise<{items: any[], total: number, page: number, pages: number,
     *   size: number, sort: string, applied: any}>}
     */
    async list(filters = {}) {
      const { pageSize: size, ratingFloor } = await importSettings(pool);
      const where = [];
      const params = [];

      const genres = await knownCodes(pool, 'e_genre', 'code', filters.genres);
      if (genres) {
        params.push(genres);
        where.push(`EXISTS (SELECT 1 FROM e_series_genre sg
                             WHERE sg.series_id = s.id AND sg.genre_code = ANY($${params.length}::text[]))`);
      }
      if (Number.isInteger(filters.yearFrom)) {
        params.push(filters.yearFrom);
        where.push(`s.year_start >= $${params.length}`);
      }
      if (Number.isInteger(filters.yearTo)) {
        params.push(filters.yearTo);
        where.push(`s.year_start <= $${params.length}`);
      }
      if (Number.isFinite(filters.ratingFrom)) {
        params.push(filters.ratingFrom);
        where.push(`r.value >= $${params.length}`);
        // Порог голосов — часть фильтра, а не украшение: «рейтинг от 8» про
        // оценку без голосов — это не про то, что человек спросил.
        params.push(ratingFloor);
        where.push(`r.votes >= $${params.length}`);
      }

      const states = (filters.states ?? []).filter((state) => STATE_ORDER.includes(state));
      if (states.length) {
        params.push(states);
        where.push(`s.exit_state = ANY($${params.length}::text[])`);
      }

      const countries = await knownCodes(pool, 'e_country', 'code', filters.countries, /^[A-Z]{2}$/);
      if (countries) {
        params.push(countries);
        where.push(`EXISTS (SELECT 1 FROM e_series_country sc
                             WHERE sc.series_id = s.id AND sc.country_code = ANY($${params.length}::text[]))`);
      }

      const networks = await knownCodes(pool, 'e_network', 'id::text', filters.networks, /^\d+$/);
      if (networks) {
        params.push(networks.map(Number));
        where.push(`EXISTS (SELECT 1 FROM e_series_network sn
                             WHERE sn.series_id = s.id AND sn.network_id = ANY($${params.length}::int[]))`);
      }

      const sort = Object.hasOwn(SORTS, filters.sort) ? filters.sort : DEFAULT_SORT;
      const page = Math.max(1, Number(filters.page) || 1);
      params.push(size, (page - 1) * size);

      const filtered = `${BASE_SELECT}${where.length ? ` AND ${where.join(' AND ')}` : ''}`;
      const { rows } = await pool.query(
        `SELECT *, count(*) OVER () AS total
           FROM (${filtered}) t
          ORDER BY ${SORTS[sort].replace('$rating_floor', String(ratingFloor))}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      // Окно счёта живёт в тех же строках, что и выдача, поэтому страница за
      // концом списка приходит пустой — и вместе с ней пустым total. А он нужен:
      // по нему маршрут отвечает 301 на последнюю страницу (EC-K6).
      const total = rows.length ? Number(rows[0].total) : await countAll(pool, filtered, params.slice(0, -2));
      return {
        items: rows.map((row) => ({
          id: row.id,
          slug: row.slug,
          title: row.title,
          yearStart: row.year_start,
          yearEnd: row.year_end,
          exitState: row.exit_state,
          genreCode: row.genre_code,
          genreName: row.genre_name,
          // Рейтинг показывается только за порогом голосов: карточка в каталоге
          // и карточка сериала показывают одно и то же число (M2 §0).
          rating: row.votes !== null && row.votes >= ratingFloor ? row.rating : null,
          votes: row.votes,
          firstRelease: row.first_release,
          posterWidth: row.poster_width,
        })),
        total,
        page,
        pages: Math.max(1, Math.ceil(total / size)),
        size,
        sort,
        applied: {
          genres: genres ?? [],
          yearFrom: Number.isInteger(filters.yearFrom) ? filters.yearFrom : null,
          yearTo: Number.isInteger(filters.yearTo) ? filters.yearTo : null,
          ratingFrom: Number.isFinite(filters.ratingFrom) ? filters.ratingFrom : null,
          states,
          countries,
          networks,
          ratingFloor,
        },
      };
    },

    /**
     * Границы и списки для фильтров.
     *
     * Числа берутся из каталога, а не заданы константой: ползунок, который
     * предлагает год, которого в базе нет, — это фильтр, который ничего не
     * делает (F-02-03 §7).
     *
     * Поиск по справочнику сужает список вариантов, а не выдачу: человек ищет
     * «HBO» в списке сетей, а находит то, что уже выбрано, плюс подсказку.
     * Работает без скриптов — это обычный ввод в той же форме.
     *
     * @param {{networkSearch?: string, countrySearch?: string}} [search]
     * @returns {Promise<{genres: any[], states: any[], countries: any[],
     *   networks: any[], yearMin: number, yearMax: number, ratingMin: number, ratingMax: number}>}
     */
    async filters(search = {}) {
      const networkSearch = String(search.networkSearch ?? '').trim().toLowerCase();
      const countrySearch = String(search.countrySearch ?? '').trim().toLowerCase();
      const like = (value) => `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

      const [genres, countries, networks, bounds, counts] = await Promise.all([
        pool.query(`
          SELECT g.code, g.name_ru, g.name_en, count(*)::int AS n
            FROM e_genre g
            JOIN e_series_genre sg ON sg.genre_code = g.code
            JOIN e_series s ON s.id = sg.series_id
           WHERE s.publication_state = 'published' AND s.archived_at IS NULL
           GROUP BY g.code, g.name_ru, g.name_en
           HAVING count(*) > 0
           ORDER BY g.name_ru`),
        pool.query(`
          SELECT c.code, c.name_ru, c.name_en, count(DISTINCT sc.series_id)::int AS n
            FROM e_country c
            JOIN e_series_country sc ON sc.country_code = c.code
            JOIN e_series s ON s.id = sc.series_id
           WHERE s.publication_state = 'published' AND s.archived_at IS NULL
             AND ($1::text = '' OR lower(c.name_ru) LIKE $1 ESCAPE '\\' OR lower(c.name_en) LIKE $1 ESCAPE '\\')
           GROUP BY c.code, c.name_ru, c.name_en
           ORDER BY count(DISTINCT sc.series_id) DESC, c.name_ru
           LIMIT 60`, [like(countrySearch)]),
        // Сетей у TMDB сотни, а в каталоге их единицы: список показывается
        // только те, что встречаются, и ограничен сверху, иначе фильтр станет
        // простынёй длиннее экрана.
        pool.query(`
          SELECT n.id::text AS id, n.name, count(sn.series_id)::int AS n
            FROM e_network n
            JOIN e_series_network sn ON sn.network_id = n.id
            JOIN e_series s ON s.id = sn.series_id
           WHERE s.publication_state = 'published' AND s.archived_at IS NULL
             AND ($1::text = '' OR lower(n.name) LIKE $1 ESCAPE '\\')
           GROUP BY n.id, n.name
           ORDER BY count(sn.series_id) DESC, n.name
           LIMIT 40`, [like(networkSearch)]),
        pool.query(`
          SELECT min(s.year_start)::int AS year_min, max(s.year_start)::int AS year_max,
                 min(r.value)::float AS rating_min, max(r.value)::float AS rating_max
            FROM e_series s
            LEFT JOIN e_external_rating r ON r.series_id = s.id AND r.platform = 'imdb'
           WHERE s.publication_state = 'published' AND s.archived_at IS NULL
             AND s.year_start IS NOT NULL`),
        pool.query(`
          SELECT s.exit_state, count(*)::int AS n
            FROM e_series s
           WHERE s.publication_state = 'published' AND s.archived_at IS NULL
           GROUP BY s.exit_state`),
      ]);

      const byState = new Map(counts.rows.map((row) => [row.exit_state, row.n]));
      const first = bounds.rows[0] ?? {};

      return {
        genres: genres.rows.map((row) => ({
          code: row.code,
          nameRu: row.name_ru,
          nameEn: row.name_en,
          count: row.n,
        })),
        countries: countries.rows.map((row) => ({
          code: row.code,
          nameRu: row.name_ru,
          nameEn: row.name_en,
          count: row.n,
        })),
        networks: networks.rows.map((row) => ({ id: row.id, name: row.name, count: row.n })),
        states: STATE_ORDER.map((key) => ({ key, count: byState.get(key) ?? 0 })),
        yearMin: first.year_min ?? new Date().getFullYear(),
        yearMax: first.year_max ?? new Date().getFullYear(),
        ratingMin: first.rating_min ?? 0,
        ratingMax: first.rating_max ?? 10,
      };
    },
  };
}

/**
 * Сколько сериалов подходит под фильтры, когда сама страница пуста.
 *
 * Отдельный запрос и только для этого случая: на каждой нормальной странице
 * число уже возвращается оконной функцией, а лишний `COUNT` на каждом
 * открытии каталога стоил бы прохода по таблице ради числа, которое уже есть.
 *
 * @param {any} pool настоящий Pool или тестовый двойник с `query`
 * @param {string} filtered текст `SELECT … FROM … WHERE …` с параметрами на `$1…`
 * @param {unknown[]} params параметры без `LIMIT` и `OFFSET`
 * @returns {Promise<number>}
 */
async function countAll(pool, filtered, params) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM (${filtered}) t`, params);
  return rows[0].n;
}

/**
 * Оставляет из запрошенных значений только те, что есть в справочнике.
 *
 * Сверка идёт с базой, а не со списком в коде: справочник меняется импортом,
 * и список в сервисе разошёлся бы с ним при первом же новом жанре или стране.
 * Пустой результат — «фильтр не задан», а не «ноль сериалов»: иначе адрес с
 * опечаткой (`?country=ZZ`) показывал бы пустую страницу вместо базового
 * списка (F-02-03 §4).
 *
 * @param {any} pool
 * @param {string} table справочник: `e_genre`, `e_country`, `e_network`
 * @param {string} column колонка со значением, приводимая к тексту
 * @param {unknown[]} requested
 * @param {RegExp} [shape] чему обязано соответствовать значение из адреса
 * @returns {Promise<string[]|null>}
 */
async function knownCodes(pool, table, column, requested, shape = null) {
  const list = [...new Set((requested ?? [])
    .map((value) => String(value).trim())
    .filter((value) => value && (!shape || shape.test(value))))];
  if (!list.length) return null;

  const { rows } = await pool.query(
    `SELECT ${column}::text AS value FROM ${table} WHERE ${column}::text = ANY($1::text[])`,
    [list],
  );
  return rows.length ? rows.map((row) => row.value) : null;
}