// Обезличивание по истечении срока (F-01-10 §4, EC-A17, OP-16).
//
// Срок наступает по часам, а сервер может быть выключен в этот момент. Поэтому
// задача не «помнит», что должна была сделать, а спрашивает у базы, кому пора:
// пропущенное догоняется при ближайшем проходе, а не теряется.
//
// Запуск — по таймеру и один раз сразу при старте: если сервер подняли после
// простоя, обезличивание не ждёт следующей минуты.

/**
 * @param {object} deps
 * @param {object} deps.auth хранилище учётных записей
 * @param {object} [deps.journal] журнал безопасности
 * @param {Function} [deps.now] часы, для тестов
 * @returns {Promise<{done:number, failed:number}>} сколько обезличено и сорвалось
 */
export async function runDeletionSweep({ auth, journal, now = () => Date.now() }) {
  const due = await auth.dueDeletions(new Date(now()));
  let done = 0;
  let failed = 0;

  for (const account of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await auth.anonymizeUser(account.id);
      journal?.security({ event: 'account_anonymized', user_id: account.id, requestId: 'задача' });
      done += 1;
    } catch (e) {
      // Ошибка одного аккаунта не должна останавливать очередь: остальные
      // ждут своего обезличивания и потеряли бы срок из-за одного.
      // eslint-disable-next-line no-await-in-loop
      console.error(`[удаление] аккаунт ${account.id}: ${e.message}`);
      failed += 1;
    }
  }

  return { done, failed };
}

/** Как часто задача смотрит, кому пора (F-01-10 §4). */
export const DELETE_TICK_MS = 15 * 60_000;