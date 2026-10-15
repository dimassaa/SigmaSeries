// Поиск по каталогу: сериалы, люди, подборки (F-02-06, S-17).
//
// Индекс названий — это вычисление на лету, а не отдельная таблица: при
// 1200 сериалах (измерение DATA-SOURCES §10) полнотекстовый индекс даёт
// преимущество только на порядках больше, а лишняя таблица означала бы ещё
// одно место, где индекс может разойтись с каталогом. Ранжирование целиком в
// SQL не выражается — сравнение основ и расстояние Левенштейна живут в Node,
// поэтому кандидаты сужаются базой, а порядок и падеж — здесь.

import { isEmptyQuery, normalize, otherLayout, queryStems, rankOf, trimQuery } from './query.js';

/** Сколько кандидатов берёт база до ранжирования в Node. */
const CANDIDATES = 200;

/** Сколько подсказок показывает поле по умолчанию. */
const DEFAULT_SUGGEST_MAX = 8;

/** Порог подсказок: меньше двух знаков подсказки не показывают (§2). */
const DEFAULT_SUGGEST_MIN_CHARS = 2;

export function pgSearch(pool) {
  return {
    /**
     * Полный поиск.
     *
     * @param {object} options
     * @param {string} options.query
     * @param {number} [options.limit]
     * @returns {Promise<{query: string, truncated: boolean, layoutFixed: string|null,
     *   series: object[], people: object[], collections: object[], total: number}>}
     */
    async find({ query, limit = 24 }) {
      const trimmed = trimQuery(query);
      const original = trimmed.query;

      if (isEmptyQuery(original)) {
        return { query: original, truncated: trimmed.truncated, layoutFixed: null, series: [], people: [], collections: [], total: 0 };
      }

      // Сначала ищем как введено. Только если ничего не нашлось — пробуем другую
      // раскладку и говорим об этом (F-02-06 §3): подсказка появляется там, где
      // человек действительно ошибся, а не перед каждым запросом.
      const direct = await run(pool, original, limit);
      if (direct.total > 0) {
        return { query: original, truncated: trimmed.truncated, layoutFixed: null, ...direct };
      }

      const translated = otherLayout(original);
      if (translated) {
        const fixed = await run(pool, translated, limit);
        if (fixed.total > 0) {
          return {
            query: original,
            truncated: trimmed.truncated,
            layoutFixed: translated,
            ...fixed,
          };
        }
      }

      return { query: original, truncated: trimmed.truncated, layoutFixed: null, ...direct };
    },

    /**
     * Популярные жанры — для пустого состояния поиска.
     *
     * Не «популярные» в смысле рейтинга, а самые наполненные: пустая выдача
     * чаще всего означает слишком узкий запрос, и предложить жанр с двадцатью
     * сериалами полезнее, чем жанр с тремя.
     *
     * @param {number} [limit]
     * @returns {Promise<{code: string, title: string}[]>}
     */
    async genres(limit = 6) {
      const { rows } = await pool.query(`
        SELECT g.code, g.name_ru AS title
          FROM e_genre g
          JOIN e_series_genre sg ON sg.genre_code = g.code
          JOIN e_series s ON s.id = sg.series_id
         WHERE s.publication_state = 'published' AND s.archived_at IS NULL
           AND g.active
         GROUP BY g.code, g.name_ru
         ORDER BY count(*) DESC, g.name_ru
         LIMIT $1`, [limit]);
      return rows;
    },

    /**
     * Подсказки для поля (UI-09).
     *
     * @param {object} options
     * @param {string} options.query
     * @param {number} [options.max]
     * @returns {Promise<{series: object[], people: object[], collections: object[]}>}
     */
    async suggest({ query, max = null }) {
      const trimmed = trimQuery(query);
      const limit = max ?? await suggestMax(pool);

      if (isEmptyQuery(trimmed.query) || trimmed.query.length < await suggestMinChars(pool)) {
        return { series: [], people: [], collections: [] };
      }

      const found = await run(pool, trimmed.query, limit);
      return {
        series: found.series.slice(0, limit),
        people: found.people.slice(0, limit),
        collections: found.collections.slice(0, limit),
      };
    },
  };
}

/**
 * Поиск по всем трём видам с ранжированием.
 *
 * @param {object} pool
 * @param {string} query
 * @param {number} limit
 */
async function run(pool, query, limit) {
  const needles = queryStems(query);
  if (!needles.length) return { series: [], people: [], collections: [], total: 0 };

  // Предварительный отбор базой идёт по СЛОВАМ как они есть, а не по основам:
  // в баке лежит исходный текст, и сравнение основы с ним не совпало бы
  // никогда («полосат» ≠ «полосатый»). Основы нужны позже, в Node, для ранга.
  const words = normalize(query).split(' ').filter(Boolean);

  const [series, people, collections] = await Promise.all([
    findSeries(pool, needles, words, limit),
    findPeople(pool, needles, words, limit),
    findCollections(pool, needles, words, limit),
  ]);

  return {
    series: series.items,
    people: people.items,
    collections: collections.items,
    total: series.total + people.total + collections.total,
  };
}

/**
 * Условие «любое слово запроса встречается в тексте».
 *
 * Значения подставляются только параметрами: слова приходят из адреса, а
 * собирать из них строку условия нельзя (R-SEC-16).
 *
 * @param {string[]} words
 * @returns {{text: (column: string, offset: number) => string, params: (words: string[]) => string[]}}
 */
function anyWord(words) {
  const list = words.length ? words : [''];
  return {
    text: (column, offset) => `(${list
      .map((_, index) => `${column} ILIKE $${offset + index}`)
      .join(' OR ')})`,
    params: (values) => values.map((word) => `%${word}%`),
  };
}

/**
 * Нормализация на стороне базы.
 *
 * `ё → е` обязана происходить и в SQL: локаль базы — `ru_RU.UTF-8`, где `ILIKE`
 * не считает «ёж» и «еж» одним словом, а Node уже нормализовал запрос. Без
 * этого человек пишет «режиссер» и не находит «Режиссёр» — а это фамилия в
 * названии должности, то есть почти весь каталог IMDb-людей.
 *
 * `unaccent` требует расширения, которого в списке `STACK` §3 нет, поэтому
 * приведение делается таблицей `translate` — двух букв здесь хватает.
 *
 * @param {string} expression
 * @returns {string}
 */
const folded = (expression) => `translate(${expression}, 'ёЁ', 'еЕ')`;

/**
 * Сериалы.
 *
 * Кандидаты берутся по вхождению и по началу слова — этого достаточно, чтобы не
 * принести в Node весь каталог, а ранжирование всё равно делается здесь.
 *
 * Индекс `ix_series_search` полнотекстовый и по `to_tsvector` его не покрывает:
 * он нужен для морфологии, которой здесь нет. При 1200 сериалах (DATA-SOURCES
 * §10) последовательный проход по таблице — единицы миллисекунд; при росте на
 * порядок понадобится `pg_trgm`, и это отдельное решение (находка).
 */
async function findSeries(pool, needles, words, limit) {
  const match = anyWord(words);

  const { rows } = await pool.query(
    `SELECT s.id, s.slug,
            coalesce(s.title_ru, s.title_en, s.title_original) AS title,
            s.title_ru, s.title_en, s.title_original,
            s.year_start,
            r.votes,
            (SELECT iv.width FROM e_image_variant iv
               JOIN e_image i ON i.id = iv.image_id
              WHERE i.series_id = s.id AND i.role = 'poster'
              ORDER BY iv.width LIMIT 1) AS poster_width
       FROM e_series s
       LEFT JOIN e_external_rating r ON r.series_id = s.id AND r.platform = 'imdb'
       WHERE s.publication_state = 'published'
         AND s.archived_at IS NULL
         AND ${match.text(folded("concat_ws(' ', s.title_ru, s.title_en, s.title_original)"), 1)}
       ORDER BY r.votes DESC NULLS LAST, s.title_ru
       LIMIT $${words.length + 1}`,
    [...match.params(words), CANDIDATES],
  );

  const ranked = rank(rows, needles, limit);
  return { items: ranked.items, total: ranked.total };
}

/** Люди: актёры и режиссёры из опубликованных сериалов. */
async function findPeople(pool, needles, words, limit) {
  const match = anyWord(words);
  const { rows } = await pool.query(
    `SELECT DISTINCT p.id, p.slug, p.name, p.kind
       FROM e_person p
       JOIN e_series_person sp ON sp.person_id = p.id
       JOIN e_series s ON s.id = sp.series_id
      WHERE s.publication_state = 'published' AND s.archived_at IS NULL
        AND ${match.text(folded('p.name'), 1)}
      LIMIT $${words.length + 1}`,
    [...match.params(words), CANDIDATES],
  );

  const ranked = rank(rows, needles, limit, (row) => row.name);
  return { items: ranked.items, total: ranked.total };
}

/** Подборки: активные и видимые. */
async function findCollections(pool, needles, words, limit) {
  const match = anyWord(words);
  const { rows } = await pool.query(
    `SELECT c.id, c.slug, c.title, c.description
       FROM e_collection c
      WHERE c.active AND c.is_demo = FALSE
        AND ${match.text(folded('c.title'), 1)}
      LIMIT $${words.length + 1}`,
    [...match.params(words), CANDIDATES],
  );

  const ranked = rank(rows, needles, limit, (row) => row.title);
  return { items: ranked.items, total: ranked.total };
}

/**
 * Ранжирование кандидатов.
 *
 * Название для сравнения берётся из всех трёх полей: человек ищет «Игра
 * престолов» по-русски и `Game of Thrones` по-английски, а в базе лежат оба.
 * Приоритет совпадения — русский, как он показан в карточке.
 *
 * @param {object[]} rows
 * @param {string[]} needles
 * @param {number} limit
 * @param {(row: object) => string} [titleOf]
 */
function rank(rows, needles, limit, titleOf = defaultTitleOf) {
  const scored = [];
  for (const row of rows) {
    const haystacks = haystacksOf(row, titleOf);
    let best = null;
    for (const hay of haystacks) {
      const rank = rankOf(queryStems(hay), needles);
      if (rank === null) continue;
      if (best === null || rank < best) best = rank;
    }
    if (best === null) continue;
    scored.push({ ...row, rank: best });
  }

  // Ранг важнее голосов: сначала насколько совпало, потом насколько известно.
  scored.sort((a, b) => (a.rank - b.rank)
    || ((b.votes ?? 0) - (a.votes ?? 0))
    || String(a.title ?? a.name ?? '').localeCompare(String(b.title ?? b.name ?? '')));

  return { items: scored.slice(0, limit), total: scored.length };
}

function defaultTitleOf(row) {
  return `${row.title_ru ?? ''} ${row.title_original ?? ''} ${row.title_en ?? ''}`;
}

/** Названия, по которым сравнивается совпадение: русское, оригинал, английское. */
function haystacksOf(row, titleOf) {
  if (titleOf !== defaultTitleOf) return [titleOf(row)];
  return [row.title_ru, row.title_original, row.title_en].filter(Boolean);
}

async function suggestMax(pool) {
  const { rows } = await pool.query("SELECT value FROM e_system_setting WHERE key = 'search.suggest_max'");
  const value = Number(rows[0]?.value);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_SUGGEST_MAX;
}

async function suggestMinChars(pool) {
  const { rows } = await pool.query("SELECT value FROM e_system_setting WHERE key = 'search.suggest_min_chars'");
  const value = Number(rows[0]?.value);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_SUGGEST_MIN_CHARS;
}