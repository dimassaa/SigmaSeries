// Обезличивание аккаунтов по истечении срока (F-01-10 §4, F-01-01 §8(г)).
//
// Срок наступает по часам, а сервер может быть выключен в этот момент. Поэтому
// задача не «помнит», что должна была сделать, а спрашивает у базы, кому пора:
// пропущенное догоняется при ближайшем проходе, а не теряется.
//
// Два срока, одно действие: удаление по заявке человека и неподтверждённый
// аккаунт, который не дождался письма. Задача одна и та же, потому что
// заканчивается одинаково — `anonymizeUser`, — и различаются только тем,
// КОГДА аккаунту пора.
//
// Запуск — по таймеру и один раз сразу при старте: если сервер подняли после
// простоя, обезличивание не ждёт следующей минуты.

import { AUTH, DAY } from '../../config/settings.js';

/**
 * Обезличивает список аккаунтов, не давая одной ошибке остановить очередь.
 *
 * @param {any} auth хранилище учётных записей
 * @param {number[]} ids
 * @param {string} label для журнала и сообщения об ошибке
 * @param {any} [journal]
 * @returns {Promise<{done:number, failed:number}>}
 */
async function anonymizeEach(auth, ids, label, journal) {
  let done = 0;
  let failed = 0;

  for (const userId of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await auth.anonymizeUser(userId);
      journal?.security({ event: 'account_anonymized', user_id: userId, requestId: 'задача' });
      done += 1;
    } catch (e) {
      // Ошибка одного аккаунта не должна останавливать очередь: остальные
      // ждут своего обезличивания и потеряли бы срок из-за одного.
      // eslint-disable-next-line no-await-in-loop
      console.error(`[${label}] аккаунт ${userId}: ${e.message}`);
      failed += 1;
    }
  }

  return { done, failed };
}

/**
 * @param {object} deps
 * @param {any} deps.auth хранилище учётных записей
 * @param {any} [deps.journal] журнал безопасности
 * @param {Function} [deps.now] часы, для тестов
 * @returns {Promise<{done:number, failed:number}>} сколько обезличено и сорвалось
 */
export async function runDeletionSweep({ auth, journal, now = () => Date.now() }) {
  const at = new Date(now());
  const due = (await auth.dueDeletions(at)).map((account) => account.id);
  return anonymizeEach(auth, due, 'удаление', journal);
}

/**
 * Обезличивание неподтверждённых аккаунтов (F-01-01 §8(г), STATES §2).
 *
 * `STATES` ведёт `Unverified → Anonymized: не подтверждён за 7 дней`.
 * Обезличивание, а не удаление: запись остаётся под своим идентификатором
 * (на неё ссылаются материалы и оценки, а `R-SQL-02` запрещает `DELETE` из
 * `e_user` вовсе), но адрес и ник освобождаются и аккаунт больше не может
 * войти.
 *
 * @param {object} deps
 * @param {any} deps.auth хранилище учётных записей
 * @param {any} [deps.journal]
 * @param {Function} [deps.now] часы, для тестов
 * @param {number} [deps.ttlDays] `auth.unverified_ttl_days`
 * @returns {Promise<{done:number, failed:number}>}
 */
export async function runUnverifiedSweep({
  auth, journal, now = () => Date.now(), ttlDays = AUTH.unverifiedTtlDays,
}) {
  const cutoff = new Date(now() - ttlDays * DAY);
  const due = await auth.dueUnverified(cutoff);
  return anonymizeEach(auth, due, 'неподтверждённый', journal);
}

/** Как часто задача смотрит, кому пора (F-01-10 §4). */
export const DELETE_TICK_MS = 15 * 60_000;