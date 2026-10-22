// Список отзывов сериала: строки страницы, счётчики групп и «лучшие» для S-06
// (F-04-05, OP-04).
//
// Правила выборки:
//
//  1. Читателю виден текущий текст, а пока правка проходит проверку — прежний
//     (R-MOD-21, EC-V9): тот же снимок `visible_body`, что у блока «Ваш отзыв».
//  2. Отзывы автора под действующим баном с признаком «скрыть материалы» не
//     показываются вовсе (M4 §8в); снятый и истёкший бан не помнятся.
//  3. Группа — по текущей оценке автора (EC-V3): оценка изменилась — отзыв
//     перешёл в другую вкладку. Соединение с оценкой внутреннее: карточке
//     нужно число, и без оценки строка в ленту не попадает (H-75: отзыв —
//     это оценка плюс текст; через приложение другой пары не бывает).
//  4. Счётчики вкладок считаются в области фильтров длины и языка, но не
//     группы: число на вкладке — то, что человек увидит, кликнув по ней.
//  5. Порядок «Полезные» — число голосов, затем дата (F-04-06 §8): пока
//     голосов нет, лента свежая, а не пустая. Добор по `id` — чтобы страницы
//     не пересекались при равных ключах.

import { REVIEW } from '../settings.js';
import { POSITIVE_FROM, MIXED_FROM, RATING_FILTERS, LENGTH_FILTERS } from '../rating/group.js';

/** Значения сортировки — значения адреса; первый — умолчание (F-04-05 §4). */
export const SORT_KEYS = ['helpful', 'new', 'long'];

/** Текст читателя: у правки на проверке — прежняя версия (R-MOD-21). */
const VISIBLE_BODY = `CASE WHEN m.state IN ('checking', 'flagged') AND m.visible_body IS NOT NULL
    THEN m.visible_body ELSE m.body END`;

/** Спойлер той же версии, что и текст: снимок хранит и его. */
const VISIBLE_SPOILER = `CASE WHEN m.state IN ('checking', 'flagged') AND m.visible_body IS NOT NULL
    THEN m.visible_spoiler ELSE m.spoiler END`;

/** Строка видна читателю: опубликована или имеет снимок; автор не под баном.
 *
 * Фрагмент условия об алиасе `m`; его же принимает сервис голосов — счётчик
 * кнопки и порядок «Полезных» считаются по одному правилу (F-04-06 §8).
 */
export const READABLE = `(m.state IN ('published', 'approved')
    OR (m.state IN ('checking', 'flagged') AND m.visible_body IS NOT NULL))
  AND NOT EXISTS (SELECT 1 FROM e_restriction ban
                   WHERE ban.user_id = m.author_id AND ban.kind = 'ban'
                     AND ban.hide_materials AND ban.revoked_at IS NULL
                     AND (ban.expires_at IS NULL OR ban.expires_at > now()))`;

const FROM = `FROM e_material m
  JOIN e_user u ON u.id = m.author_id
  JOIN e_rating r
    ON r.user_id = m.author_id AND r.object_type = 'series' AND r.series_id = m.series_id`;

/** Сериал отзыва: странице отзыва нужен его адрес и признак снятия с публикации. */
const JOIN_SERIES = 'JOIN e_series s ON s.id = m.series_id';

/** Число голосов «полезно» у строки — ключ сортировки по умолчанию и число
 * в кнопке «Полезно» (F-04-06 §19): одна и та же величина в обоих местах. */
const VOTES = '(SELECT count(*) FROM e_helpful_vote v WHERE v.material_id = m.id)';

const COLUMNS = `m.id, u.nickname, u.status AS author_status, r.value AS author_rating,
    m.author_id, m.created_at, m.lang, ${VISIBLE_SPOILER} AS spoiler, ${VISIBLE_BODY} AS body,
    ${VOTES} AS helpful_count`;

const SORTS = {
  helpful: `${VOTES} DESC, m.created_at DESC, m.id DESC`,
  new: 'm.created_at DESC, m.id DESC',
  long: `char_length(btrim(${VISIBLE_BODY})) DESC, m.created_at DESC, m.id DESC`,
};

/**
 * Условие группы по оценке; значения дописываются в `params`.
 *
 * Фрагмент строится один раз на запрос и используется и в счётчиках, и в
 * ленте: границы — из классификатора (OP-04), чтобы вкладки и выборка не
 * разошлись. `TRUE` — группа не выбрана.
 *
 * @param {string|null} group
 * @param {Array} params изменяется
 * @returns {string}
 */
function groupCondition(group, params) {
  if (!RATING_FILTERS.includes(group)) return 'TRUE';
  if (group === 'positive') {
    params.push(POSITIVE_FROM);
    return `r.value >= $${params.length}`;
  }
  if (group === 'mixed') {
    params.push(MIXED_FROM, POSITIVE_FROM);
    return `r.value >= $${params.length - 1} AND r.value < $${params.length}`;
  }
  params.push(MIXED_FROM);
  return `r.value < $${params.length}`;
}

/** Строка списка для вида: имена полей — как в остальном коде. */
function itemOf(row) {
  return {
    id: Number(row.id),
    authorId: Number(row.author_id),
    authorNickname: row.nickname,
    authorStatus: row.author_status,
    authorRating: row.author_rating,
    createdAt: row.created_at,
    lang: row.lang,
    spoiler: row.spoiler,
    body: row.body,
    helpfulCount: Number(row.helpful_count),
  };
}

/**
 * Источник данных списка отзывов (S-09) и блока «Лучшие» (S-06).
 *
 * @param {any} pool настоящий Pool или тестовый двойник с `query`
 */
export function pgReviewList(pool) {
  return {
    /**
     * Страница списка.
     *
     * @param {object} input
     * @param {number} input.seriesId
     * @param {{group?: string, length?: string, lang?: string, sort?: string}} [input.filters]
     *   значения сверх допустимых игнорируются (F-04-05 §5)
     * @param {number} [input.page] с единицы
     * @param {number} [input.pageSize]
     * @returns {Promise<{items: any[], total: number, page: number, pages: number,
     *   counts: {all: number, positive: number, mixed: number, negative: number},
     *   applied: {group: string|null, length: string|null, lang: string|null, sort: string}}>}
     */
    async page({ seriesId, filters = {}, page = 1, pageSize = REVIEW.pageSize }) {
      const size = Math.max(1, Number(pageSize) || REVIEW.pageSize);
      const current = Math.max(1, Number(page) || 1);
      const sort = SORT_KEYS.includes(filters.sort) ? filters.sort : SORT_KEYS[0];
      const group = RATING_FILTERS.includes(filters.group) ? filters.group : null;
      const length = LENGTH_FILTERS.includes(filters.length) ? filters.length : null;
      const lang = filters.lang === 'ru' || filters.lang === 'en' ? filters.lang : null;

      // Область длины и языка — общая у ленты и счётчиков; группа сужает
      // только total и ленту, но не числа на вкладках.
      /** @type {any[]} */
      const params = [seriesId];
      const where = [`m.kind = 'review'`, 'm.series_id = $1', READABLE];
      if (length === 'short') {
        params.push(REVIEW.shortMaxChars);
        where.push(`char_length(btrim(${VISIBLE_BODY})) < $${params.length}`);
      }
      if (length === 'long') {
        params.push(REVIEW.longMinChars);
        where.push(`char_length(btrim(${VISIBLE_BODY})) >= $${params.length}`);
      }
      if (lang) {
        params.push(lang);
        where.push(`m.lang = $${params.length}`);
      }

      // Счётчики и total — один агрегат: сумма групп равна «Все» на тех же
      // строках, потому что строка без оценки в ленту не попадает вовсе.
      const countParams = [...params];
      const positive = groupCondition('positive', countParams);
      const mixed = groupCondition('mixed', countParams);
      const negative = groupCondition('negative', countParams);
      const selected = groupCondition(group, countParams);
      const { rows: [counts] } = await pool.query(
        `SELECT count(*)::int AS all,
                count(*) FILTER (WHERE ${positive})::int AS positive,
                count(*) FILTER (WHERE ${mixed})::int AS mixed,
                count(*) FILTER (WHERE ${negative})::int AS negative,
                count(*) FILTER (WHERE ${selected})::int AS total
           ${FROM}
          WHERE ${where.join(' AND ')}`,
        countParams,
      );

      const itemParams = [...params];
      const itemWhere = [...where];
      const chosen = groupCondition(group, itemParams);
      if (chosen !== 'TRUE') itemWhere.push(chosen);
      itemParams.push(size, (current - 1) * size);
      const { rows } = await pool.query(
        `SELECT ${COLUMNS}
           ${FROM}
          WHERE ${itemWhere.join(' AND ')}
          ORDER BY ${SORTS[sort]}
          LIMIT $${itemParams.length - 1} OFFSET $${itemParams.length}`,
        itemParams,
      );

      const total = counts.total;
      return {
        items: rows.map(itemOf),
        total,
        page: current,
        pages: Math.max(1, Math.ceil(total / size)),
        counts: {
          all: counts.all, positive: counts.positive, mixed: counts.mixed, negative: counts.negative,
        },
        applied: { group, length, lang, sort },
      };
    },

    /**
     * «Лучшие» для страницы сериала (F-02-01 §4): тот же порядок, что и у
     * ленты по умолчанию, и не больше лимита.
     *
     * @param {{seriesId: number, limit?: number}} input
     * @returns {Promise<any[]>}
     */
    async top({ seriesId, limit = REVIEW.topOnSeriesPage }) {
      const size = Math.max(1, Number(limit) || REVIEW.topOnSeriesPage);
      const { rows } = await pool.query(
        `SELECT ${COLUMNS}
           ${FROM}
          WHERE m.kind = 'review' AND m.series_id = $1 AND ${READABLE}
          ORDER BY ${SORTS.helpful}
          LIMIT $2`,
        [seriesId, size],
      );
      return rows.map(itemOf);
    },

    /**
     * Один отзыв для страницы отзыва (F-04-09, S-10).
     *
     * Правило видимости — то же, что у ленты: иначе список и страница
     * показывали бы разное, а счётчик «Полезно» и порядок считаются по
     * одному правилу (F-04-06 §8). Поэтому строка читается всегда, а
     * «читаема ли она» приезжает флагом: неопубликованный отзыв и отзыв
     * под баном отличаются от отсутствующего (у первых двух — «hidden»,
     * у третьего — «missing»), и страница отвечает на оба одинаково.
     *
     * Снятый с публикации сериал отзыву не мешает: решение «410 или
     * страница» принимает страница, а не данные (EC-V14).
     *
     * @param {{id: number}} input
     * @returns {Promise<{ok: true, review: any, series: any}
     *   | {ok: false, reason: 'missing'|'hidden'}>}
     */
    async one({ id }) {
      const materialId = Number(id);
      if (!Number.isInteger(materialId) || materialId <= 0) {
        return { ok: false, reason: 'missing' };
      }

      const { rows } = await pool.query(
        `SELECT ${COLUMNS}, (${READABLE}) AS readable,
                s.id AS series_id, s.slug AS series_slug,
                coalesce(nullif(s.title_ru, ''), s.title_original) AS series_title,
                s.archived_at AS series_archived
           ${FROM}
           ${JOIN_SERIES}
          WHERE m.id = $1 AND m.kind = 'review'`,
        [materialId],
      );
      const row = rows[0];
      if (!row) return { ok: false, reason: 'missing' };
      if (!row.readable) return { ok: false, reason: 'hidden' };

      return {
        ok: true,
        review: itemOf(row),
        series: {
          id: Number(row.series_id),
          slug: row.series_slug,
          title: row.series_title,
          archived: row.series_archived !== null,
        },
      };
    },
  };
}
