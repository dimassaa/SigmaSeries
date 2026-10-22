// Служебные уведомления сотрудникам: администратору и редактору.
//
// Служебные сообщения идут в ленту: у администратора нет адреса для служебных
// писем, а сообщение он ждёт там, где и работает, — в ленте уведомлений.
//
// Ключ дедупликации обязателен: повтор о том же не должен заваливать ленту
// одинаковыми сообщениями.

import { pgNotifications } from './notification.js';

/**
 * Сообщить сотрудникам.
 *
 * @param {object} args
 * @param {import('pg').Pool} args.pool
 * @param {string} args.kind вид уведомления (из реестра `KINDS`)
 * @param {any} [args.params] параметры текста
 * @param {string} args.dedupKey ключ, по которому повтор не создаётся
 * @param {string[]} [args.roles] роли получателей; по умолчанию — администратор
 *   и редактор (служебные виды в реестре адресованны обоим, M3 §8е)
 * @returns {Promise<number>} сколько уведомлений создано
 */
export async function notifyStaff({
  pool, kind, params = {}, dedupKey, roles = ['admin', 'editor'],
}) {
  const { rows } = await pool.query(
    `SELECT DISTINCT user_id FROM e_role_assignment
      WHERE role = ANY($1::text[]) AND (expires_at IS NULL OR expires_at > now())`,
    [roles],
  );
  const userIds = rows.map((row) => Number(row.user_id));
  if (!userIds.length) return 0;

  const { created } = await pgNotifications(pool).create({ userIds, kind, params, dedupKey });
  return created;
}
