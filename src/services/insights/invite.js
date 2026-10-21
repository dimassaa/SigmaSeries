// Приглашение к итогам (M7, F-01-01 §3).
//
// Приглашение получает тот, у кого уже есть точные отметки, и кто ещё не
// получал приглашения за этот год: годовой заход без «сходил и посмотрел»
// превращается в спам, и человек перестаёт его открывать.
//
// Приглашение уходит один раз в год на человека — за это отвечает
// `dedup_key`, а не память процесса: перезапуск сервера не должен прислать
// второе.

import { WRAPPED } from '../../config/settings.js';

/** Вид уведомления. */
export const RECAP_INVITE_KIND = 'recap_ready';

/**
 * Приглашения к итогам.
 *
 * @param {import('pg').Pool} pool
 */
export function pgRecapInvites(pool) {
  return {
    /**
     * Кому предложить итоги.
     *
     * @param {number} [limit]
     * @returns {Promise<number[]>} идентификаторы пользователей
     */
    async candidates(limit = 500) {
      const { rows } = await pool.query(
        `WITH marked AS (
           SELECT user_id, count(*)::int AS n
             FROM e_watch_mark
            WHERE precision = 'exact'
            GROUP BY user_id
           HAVING count(*) >= $1
         )
         SELECT m.user_id
           FROM marked m
           JOIN e_user u ON u.id = m.user_id
          WHERE u.status = 'active' AND u.email_confirmed
            AND NOT EXISTS (
              SELECT 1 FROM e_notification n
               WHERE n.user_id = m.user_id
                 AND n.kind = $2
                 AND n.dedup_key = 'recap:' || EXTRACT(YEAR FROM now())::int::text
            )
          LIMIT $3`,
        [WRAPPED.minMarks, RECAP_INVITE_KIND, limit],
      );
      return rows.map((row) => Number(row.user_id));
    },

    /**
     * Создаёт приглашение.
     *
     * @param {number} userId
     * @returns {Promise<boolean>} создано ли (повтор — нет)
     */
    async invite(userId) {
      const { rows } = await pool.query(
        `INSERT INTO e_notification (user_id, kind, category, params, dedup_key)
         VALUES ($1, $2, 'service', $3, 'recap:' || EXTRACT(YEAR FROM now())::int::text)
         ON CONFLICT (user_id, dedup_key) DO NOTHING
         RETURNING id`,
        [userId, RECAP_INVITE_KIND, JSON.stringify({})],
      );
      return rows.length > 0;
    },
  };
}

/**
 * Разовая проверка: кому предложить итоги.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<number>} сколько приглашений создано
 */
export async function runRecapInvites(pool) {
  const invites = pgRecapInvites(pool);
  const users = await invites.candidates();
  let created = 0;
  for (const userId of users) {
    if (await invites.invite(userId)) created += 1;
  }
  return created;
}
