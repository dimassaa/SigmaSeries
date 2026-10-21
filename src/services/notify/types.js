// Реестр типов уведомлений (F-03-08 §8е).
//
// Реестр существует, а не разбросанные строки в коде, потому что его читают
// три разных места: создание уведомления (категория и канал), чтение в ленте
// (шаблон) и настройки человека (какие категории он может выключить). Три
// списка в трёх файлах разошлись бы при первом же новом типе — и человек
// получил бы уведомление, которого сам отключить не может.
//
// Категория — это то, что человек выключает целиком («выходы», «модерация»,
// «служебное»), а тип — то, что он читает («вышла серия», «перенесена»).

/** Типы и то, что о них известно при создании. */
export const KINDS = {
  release_today: { category: 'release', channel: 'in_service' },
  release_changed: { category: 'release', channel: 'in_service' },
  release_cancelled: { category: 'release', channel: 'in_service' },
  schedule_announced: { category: 'release', channel: 'in_service' },
  moderation_result: { category: 'moderation', channel: 'in_service' },
  reply: { category: 'reply', channel: 'in_service' },
  import_failed: { category: 'service', channel: 'staff' },
  // Прогон импорта остановлен: ключ отклонили (F-12-09 §17).
  import_key_rejected: { category: 'service', channel: 'staff' },
  // Прогон импорта остановлен на середине: размыкатель открыт (F-12-09 §17).
  import_partial: { category: 'service', channel: 'staff' },
  mail_failed: { category: 'service', channel: 'staff' },
  collection_hidden: { category: 'service', channel: 'staff' },
  spam_surge: { category: 'service', channel: 'staff' },
  // Бюджет помеченных попыток превышен в третий раз (R-MOD-08).
  spam_budget_hit: { category: 'service', channel: 'staff' },
  queue_threshold: { category: 'service', channel: 'staff' },
  rating_anomaly: { category: 'service', channel: 'staff' },
  // Приглашение к персональным итогам (M7, F-07-01 §3).
  recap_ready: { category: 'service', channel: 'in_service' },
};

/**
 * Категория типа.
 *
 * Неизвестный тип — это ошибка вызывающего кода, а не повод создать
 * уведомление без категории: с такой категорией его нельзя было бы ни показать
 * в ленте, ни отключить настройкой.
 *
 * @param {string} kind
 * @returns {string}
 */
export function categoryOf(kind) {
  const found = KINDS[kind];
  if (!found) throw new Error(`неизвестный тип уведомления: ${kind}`);
  return found.category;
}

/** Типы, которые пишет ежечасная задача F-03-08 (триггер «в» — P1). */
export const RELEASE_KINDS = ['release_today', 'release_changed', 'release_cancelled'];