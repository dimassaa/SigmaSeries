// Поиск по каталогу: сериалы, люди, подборки (F-02-06, S-17).
//
// Три ступени, и порядок не переставляется:
//
//  1. Полнотекстовый поиск PostgreSQL со стеммером Snowball (`russian`).
//     «человеком» находит «людей», «кинематографом» — «кинематографа» — и идёт
//     по индексу `ix_series_search`, потому что выражение в запросе совпадает с
//     выражением в индексе дословно (находка #114).
//  2. Совпадение как есть — запасной путь для опечаток и раскладки: Snowball
//     слова «тяжких» в словаре не знает и ничего не найдёт.
//  3. Ранжирование в Node по правилам §3 — выразить их в tsquery нельзя.
//
// Что важно и не видно сверху: ступень 1 не отбрасывает строки, которые Node
// не смог оценить своим правилом. Именно на этом держится морфология — база
// нашла «людей» по слову «человеком», и сортировщик обязан их оставить, даже
// если его основы разошлись с основами PostgreSQL. Порядок при этом
// сохраняется: такие строки уходят в конец, но не исчезают.

import { isEmptyQuery, normalize, otherLayout, queryStems, rankOf, trimQuery } from './query.js';

/** Сколько кандидатов берёт база до ранжирования в Node. */
const CANDIDATES = 200;

/** Сколько подсказок показывает поле по умолчанию. */
const DEFAULT_SUGGEST_MAX = 8;

/** Порог подсказок: меньше двух знаков подсказки не показывают (§2). */
const DEFAULT_SUGGEST_MIN_CHARS = 2;

/**
 * Ранг для строки, найденной базой, но не оценённой правилами §3.
 *
 * Больше любого настоящего ранга (их пять), но всё-таки число: тест на
 * неубывание рангов должен видеть порядок, а не дыру в нём.
 */
const MORPHOLOGY_RANK = 9;

/**
 * Минимальная длина слова для совпадения как есть.
 *
 * Совпадение подстрокой берёт всё, что содержит слово, а `of` содержится в
 * половине латинских фамилий: `game of thrones` выдавал бы Beau Mirchoff.
 * Слова короче трёх знаков в запасной ступени не участвуют — потерять можно
 * запрос из одних предлогов, которого человек и не ищет.
 */
const MIN_PARTIAL_WORD = 3;

/**
 * Текст, по которому ищется сериал.
 *
 * Повторяет выражение `ix_series_search` из `DATABASE.md` посимвольно.
 * Расхождение здесь означает не «чуть медленнее», а «индекс не используется, и
 * каждый запрос читает таблицу целиком».
 */
const SERIES_TEXT = "coalesce(s.title_ru,'') || ' ' || coalesce(s.title_original,'') || ' ' || coalesce(s.title_en,'')";

const SERIES_COLUMNS = `
       s.id, s.slug,
       coalesce(s.title_ru, s.title_en, s.title_original) AS title,
       s.title_ru, s.title_en, s.title_original,
       s.year_start, s.exit_state,
       r.votes,
       (SELECT iv.width FROM e_image_variant iv
          JOIN e_image i ON i.id = iv.image_id
         WHERE i.series_id = s.id AND i.role = 'poster'
         ORDER BY iv.width LIMIT 1) AS poster_width`;

const SERIES_FROM = `
       e_series s
       LEFT JOIN e_external_rating r ON r.series_id = s.id AND r.platform = 'imdb'`;

/**
 * Что и где ищется.
 *
 * Три одинаковых по форме описания — чтобы ступени 1 и 2 не расходились между
 * собой: у сериалов, людей и подборок разные только текст, видимость и то,
 * какое поле показывается человеку.
 */
const TARGETS = {
  series: {
    columns: SERIES_COLUMNS,
    from: SERIES_FROM,
    text: SERIES_TEXT,
    visible: "s.publication_state = 'published' AND s.archived_at IS NULL",
    titleOf: null,   // сравниваются все три названия
  },
  people: {
    columns: 'p.id, p.slug, p.name, p.kind',
    from: 'e_person p',
    text: 'p.name',
    // Человек показывается, если он есть хотя бы в одном видимом сериале.
    // `EXISTS` вместо соединения — иначе одна роль в одном сериале даёт
    // несколько одинаковых строк, и `DISTINCT` пришлось бы тащить в каждый
    // запрос вместе с его требованиями к `ORDER BY`.
    visible: `EXISTS (
       SELECT 1 FROM e_series_person sp
         JOIN e_series s ON s.id = sp.series_id
        WHERE sp.person_id = p.id
          AND s.publication_state = 'published' AND s.archived_at IS NULL)`,
    titleOf: (row) => row.name,
  },
  collections: {
    columns: 'c.id, c.slug, c.title_ru AS title, c.description_ru AS description',
    from: 'e_collection c',
    text: 'c.title_ru',
    visible: 'c.active AND c.is_demo = FALSE',
    titleOf: (row) => row.title,
  },
};

export function pgSearch(pool) {
  return {
    /**
     * Полный поиск.
     *
     * @param {object} options
     * @param {string} options.query
     * @param {number} [options.limit]
     * @param {{series?: number, people?: number, collections?: number}} [options.offsets]
     *   сколько строк группы человек уже пролистал (#121)
     * @returns {Promise<object>}
     */
    async find({ query, limit = 24, offsets = {} }) {
      const trimmed = trimQuery(query);
      const original = trimmed.query;
      const empty = { query: original, truncated: trimmed.truncated, layoutFixed: null, ...emptyGroups(0) };

      if (isEmptyQuery(original)) return empty;

      // Сначала ищем как введено. Только если ничего не нашлось — пробуем другую
      // раскладку и говорим об этом (F-02-06 §3): пометка появляется там, где
      // человек действительно ошибся, а не перед каждым запросом.
      const direct = await run(pool, original, limit, offsets);
      if (direct.total > 0) {
        return { ...empty, ...direct };
      }

      const translated = otherLayout(original);
      if (translated) {
        // Смещения при смене раскладки не переносятся: они относятся к другой
        // выдаче, и перенос показал бы человеку строки, которых он не видел.
        const fixed = await run(pool, translated, limit, {});
        if (fixed.total > 0) {
          return { ...empty, layoutFixed: translated, ...fixed };
        }
      }

      return empty;
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
      const limit = max ?? await setting(pool, 'search.suggest_max', DEFAULT_SUGGEST_MAX);
      const minChars = await setting(pool, 'search.suggest_min_chars', DEFAULT_SUGGEST_MIN_CHARS);

      if (isEmptyQuery(trimmed.query) || trimmed.query.length < minChars) {
        return { series: [], people: [], collections: [] };
      }

      // Подсказки не листаются: смещения у них нет, и лишние строки только
      // замедляли бы ввод.
      const found = await run(pool, trimmed.query, limit);
      return { series: found.series, people: found.people, collections: found.collections };
    },

    /** Выражение поиска по сериалу — проверяется тестом против `DATABASE.md`. */
    vectorExpression: `to_tsvector('russian', ${SERIES_TEXT})`,
  };
}

/**
 * Поиск по всем трём видам с ранжированием.
 *
 * Смещение своё у каждой группы: человек листает сериалы и не должен при этом
 * терять подборки, которые уже видел (#121).
 *
 * @param {object} pool
 * @param {string} query
 * @param {number} limit
 * @param {{series?: number, people?: number, collections?: number}} [offsets]
 * @returns {Promise<object>}
 */
async function run(pool, query, limit, offsets = {}) {
  const needles = queryStems(query);
  if (!needles.length) return emptyGroups(0);

  // Слова запроса как есть: в базе лежит исходный текст, и сравнение основы с
  // ним не совпало бы никогда («полосат» ≠ «полосатый»). Основы нужны позже, для
  // ранга.
  const words = normalize(query).split(' ').filter(Boolean);

  const [series, people, collections] = await Promise.all([
    searchTarget(pool, TARGETS.series, words, needles),
    searchTarget(pool, TARGETS.people, words, needles),
    searchTarget(pool, TARGETS.collections, words, needles),
  ]);

  const found = { series, people, collections };
  const cut = { series: [], people: [], collections: [] };
  const groups = {};
  const counts = {};

  for (const [name, group] of Object.entries(found)) {
    const offset = Math.max(0, Number(offsets[name]) || 0);
    const items = group.items.slice(offset, offset + limit);
    cut[name] = items;
    counts[name] = group.found;
    groups[name] = {
      found: group.found,
      offset,
      shown: items.length,
      // «Показать ещё» только если за показанным что-то есть. Считается по
      // найденному, а не по показанному: иначе на последней странице ссылка
      // вела бы в пустоту, а при смещении за концом — обещала бы несуществующее.
      more: offset + items.length < group.found,
    };
  }

  return {
    ...cut,
    counts,
    groups,
    total: counts.series + counts.people + counts.collections,
  };
}

/** Пустой ответ: те же поля, что и непустой, чтобы вид не проверял их наличие. */
function emptyGroups(total) {
  const group = () => ({ found: 0, offset: 0, shown: 0, more: false });
  return {
    series: [], people: [], collections: [],
    counts: { series: 0, people: 0, collections: 0 },
    groups: { series: group(), people: group(), collections: group() },
    total,
  };
}

/**
 * Поиск по одной цели: полнотекстовый, при пустом результате — как есть.
 *
 * @param {object} pool
 * @param {object} target описание из `TARGETS`
 * @param {string[]} words слова запроса как есть
 * @param {string[]} needles основы слов запроса
 * @returns {Promise<{items: object[], found: number}>}
 */
async function searchTarget(pool, target, words, needles) {
  const vector = `to_tsvector('russian', ${target.text})`;
  const byText = await pool.query(
    `SELECT ${target.columns},
            ts_rank_cd(${vector}, plainto_tsquery('russian', $1)) AS text_rank
       FROM ${target.from}
      WHERE ${target.visible}
        AND ${vector} @@ plainto_tsquery('russian', $1)
      ORDER BY text_rank DESC
      LIMIT $2`,
    [words.join(' '), CANDIDATES],
  );

  // Найденное базой не выбрасывается: об этом сказано в шапке файла.
  if (byText.rows.length) return rank(byText.rows, needles, target.titleOf);

  const parts = words.filter((word) => word.length >= MIN_PARTIAL_WORD);
  if (!parts.length) return [];

  const byLike = await pool.query(
    `SELECT ${target.columns}
       FROM ${target.from}
      WHERE ${target.visible}
        AND ${anyWord(target.text, parts, 1)}
      LIMIT $${parts.length + 1}`,
    [...parts.map((word) => `%${word}%`), CANDIDATES],
  );

  return rank(byLike.rows, needles, target.titleOf);
}

/**
 * Условие «любое слово запроса встречается в тексте как есть».
 *
 * `ё` приводится к `е` прямо в базе: текст из `IMPORT` может сохранить `ё`,
 * а нормализация в Node приводит его к `е` всегда, и без перевода слово не
 * находило бы само себя. Значения подставляются только параметрами (R-SEC-16).
 *
 * @param {string} text выражение текста
 * @param {string[]} words
 * @param {number} offset номер первого параметра
 * @returns {string}
 */
function anyWord(text, words, offset) {
  const conditions = words
    .map((_, index) => `translate(${text}, 'ёЁ', 'еЕ') ILIKE $${offset + index}`)
    .join(' OR ');
  return `(${conditions})`;
}

/**
 * Ранжирование кандидатов.
 *
 * Название для сравнения берётся из всех трёх полей сериала: человек ищет «Игра
 * престолов» по-русски и `Game of Thrones` по-английски, а в базе лежат оба.
 * Приоритет совпадения — русское название, как оно показано в карточке.
 *
 * @param {object[]} rows
 * @param {string[]} needles
 * @param {((row: object) => string)|null} [titleOf]
 * @returns {{items: object[], found: number}} отсортированные целиком и их число
 */
function rank(rows, needles, titleOf = null) {
  const scored = [];
  for (const row of rows) {
    const haystacks = titleOf ? [titleOf(row)] : [row.title_ru, row.title_original, row.title_en].filter(Boolean);
    let best = null;
    for (const hay of haystacks) {
      const found = rankOf(queryStems(hay), needles);
      if (found === null) continue;
      if (best === null || found < best) best = found;
    }
    // Строка без оценки Node остаётся в выдаче: база её нашла, и это основание
    // лучше, чем наше собственное мнение о сходстве основ.
    scored.push({ ...row, rank: best ?? MORPHOLOGY_RANK });
  }

  // Ранг важнее всего остального: сначала насколько совпало, потом насколько
  // известно (`text_rank` отдаёт база), затем по названию — чтобы порядок не
  // прыгал между прогонами.
  scored.sort((a, b) => (a.rank - b.rank)
    || ((b.votes ?? 0) - (a.votes ?? 0))
    || ((b.text_rank ?? 0) - (a.text_rank ?? 0))
    || String(a.title ?? a.name ?? '').localeCompare(String(b.title ?? b.name ?? '')));

  // Возвращаются все строки целиком, а не первые `limit`: счётчик «Найдено»
  // и ссылка «показать ещё» считаются по этому же списку, и обрезка до
  // показа сделала бы их бессмысленными (#120, #121).
  return { items: scored, found: scored.length };
}

/** Число из настроек модуля, а не из кода. */
async function setting(pool, key, fallback) {
  const { rows } = await pool.query('SELECT value FROM e_system_setting WHERE key = $1', [key]);
  const value = Number(rows[0]?.value);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}