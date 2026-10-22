// Голос «Полезно» под отзывом (F-04-06).
//
// Правила приёма:
//
//  1. Голосует подтверждённый аккаунт — «Зритель и выше» (M2 §2); голос за
//     свой отзыв запрещён (EC-V15). Правило проверяет сервис, а не форма:
//     кнопку можно нарисовать как угодно, правда — в одном месте.
//  2. Примитивы «поставить» и «снять» идемпотентны (F-04-06 §8): повторное
//     «поставить» не дублирует строку (уникальная пара пользователь–материал),
//     повторное «снять» не удаляет ничего. Форма объявляет цель (`to`), а не
//     «инвертируй»: двойная отправка безопасна, состояние читается у кнопки.
//  3. Голос принимается к материалу, который читателю виден, — тому же
//     правилу, что сортирует «Полезные». Снимок правки на проверке виден
//     им же, поэтому голосовать по нему можно: счётчик и порядок не разойдутся.
//  4. «Снять» проверяет только существование отзыва: голос у собственного
//     отзыва появиться не мог, а у снятого его уже нет; удалить свою строку
//     законно всегда (R-SEC-10).

import { READABLE } from './list.js';

export const VOTE_REASONS = {
  MISSING: 'missing',
  KIND: 'kind',
  OWN: 'own',
  NOT_CONFIRMED: 'not-confirmed',
};

/** Отзыв принимает голос: существует, это отзыв, виден читателю,
 * принадлежит сериалу из адреса — адрес не может голосовать по чужому. */
const ELIGIBLE = `SELECT m.kind, m.author_id,
       (SELECT u.email_confirmed FROM e_user u WHERE u.id = $1) AS confirmed
  FROM e_material m
 WHERE m.id = $2 AND m.series_id = $3 AND ${READABLE}`;

/** Отзыв существует и это отзыв: «снять» не спрашивает видимость (см. §4). */
const EXISTS_REVIEW = `SELECT m.series_id FROM e_material m
 WHERE m.id = $1 AND m.kind = 'review' AND m.series_id = $2`;

/** Счётчик голосов отзыва — то же число, что показывает кнопка и сортировка. */
const countOf = async (pool, materialId) => {
  const { rows: [row] } = await pool.query(
    'SELECT count(*)::int AS n FROM e_helpful_vote WHERE material_id = $1',
    [materialId],
  );
  return Number(row.n);
};

/**
 * Голоса «Полезно» отзывов (E-HelpfulVote).
 *
 * @param {any} pool настоящий Pool или тестовый двойник с `query`
 */
export function pgReviewVotes(pool) {
  return {
    /**
     * Поставить голос. Идемпотентно: у голосованного строка уже есть,
     * повторный вызов оставляет счётчик прежним.
     *
     * @param {object} input
     * @param {number} input.userId голосующий
     * @param {number} input.materialId отзыв
     * @param {number} input.seriesId сериал из адреса: чужая витрина не
     *   голосует за чужой отзыв
     * @returns {Promise<{ok: true, voted: true, count: number} |
     *   {ok: false, reason: string, count: number}>}
     */
    async set({ userId, materialId, seriesId }) {
      const { rows: [row] } = await pool.query(ELIGIBLE, [userId, materialId, seriesId]);
      if (!row) return { ok: false, reason: VOTE_REASONS.MISSING, count: await countOf(pool, materialId) };
      if (row.kind !== 'review') return { ok: false, reason: VOTE_REASONS.KIND, count: await countOf(pool, materialId) };
      if (Number(row.author_id) === Number(userId)) {
        return { ok: false, reason: VOTE_REASONS.OWN, count: await countOf(pool, materialId) };
      }
      if (!row.confirmed) {
        return { ok: false, reason: VOTE_REASONS.NOT_CONFIRMED, count: await countOf(pool, materialId) };
      }

      await pool.query(
        `INSERT INTO e_helpful_vote (user_id, material_id) VALUES ($1, $2)
         ON CONFLICT (user_id, material_id) DO NOTHING`,
        [userId, materialId],
      );
      return { ok: true, voted: true, count: await countOf(pool, materialId) };
    },

    /**
     * Снять голос. Идемпотентно: неснятого голоса не было — счётчик прежний.
     *
     * @param {object} input
     * @param {number} input.userId голосовавший
     * @param {number} input.materialId отзыв
     * @param {number} input.seriesId сериал из адреса
     * @returns {Promise<{ok: true, voted: false, count: number} |
     *   {ok: false, reason: string, count: number}>}
     */
    async unset({ userId, materialId, seriesId }) {
      const { rows: [row] } = await pool.query(EXISTS_REVIEW, [materialId, seriesId]);
      if (!row) return { ok: false, reason: VOTE_REASONS.MISSING, count: await countOf(pool, materialId) };

      await pool.query(
        'DELETE FROM e_helpful_vote WHERE user_id = $1 AND material_id = $2',
        [userId, materialId],
      );
      // Свой голос снимается и с материала, ставшего невидимым (бан автора,
      // документ ушёл на проверку): это строка самого читателя, а видимость
      // решает, даёт ли отзыв голосовать заново.
      return { ok: true, voted: false, count: await countOf(pool, materialId) };
    },

    /**
     * Где голосовал читатель, по списку строк одной страницы.
     *
     * @param {object} input
     * @param {number} input.userId
     * @param {number[]} input.materialIds id отзывов страницы
     * @returns {Promise<number[]>} id голосованных
     */
    async mine({ userId, materialIds }) {
      if (!Array.isArray(materialIds) || materialIds.length === 0) return [];
      const { rows } = await pool.query(
        `SELECT material_id FROM e_helpful_vote
          WHERE user_id = $1 AND material_id = ANY($2::bigint[])`,
        [userId, materialIds],
      );
      return rows.map((row) => Number(row.material_id));
    },
  };
}
