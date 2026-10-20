// Служебное уведомление администратору о прогоне импорта (F-12-09 §17, №94).
//
// Отправлять было некуда: у администратора нет адреса для служебных писем, а
// прогон запускает он сам и ждёт его в консоли. Уведомление в ленте —
// единственное место, где администратор видит сообщение, не открывая базу и не
// читая журнал процесса, который к тому времени уже отработал.
//
// Уведомление создаётся один раз на прогон: ключ дедупликации включает
// номер прогона, поэтому повторный запуск того же прогона не заваливает ленту
// одинаковыми сообщениями, а новый прогон сообщает о себе снова.

import { pgNotifications } from '../notify/notification.js';

/**
 * Сообщить администраторам о прогоне импорта.
 *
 * @param {object} args
 * @param {import('pg').Pool} args.pool
 * @param {string} args.kind вид уведомления (из реестра `KINDS`)
 * @param {object} [args.params] параметры текста
 * @param {string} args.dedupKey ключ, по которому повтор не создаётся
 * @returns {Promise<number>} сколько уведомлений создано
 */
export async function notifyAdmins({ pool, kind, params = {}, dedupKey }) {
  const { rows } = await pool.query(
    `SELECT DISTINCT user_id FROM e_role_assignment
      WHERE role = 'admin' AND (expires_at IS NULL OR expires_at > now())`,
  );
  const userIds = rows.map((row) => Number(row.user_id));
  if (!userIds.length) return 0;

  const { created } = await pgNotifications(pool).create({ userIds, kind, params, dedupKey });
  return created;
}
