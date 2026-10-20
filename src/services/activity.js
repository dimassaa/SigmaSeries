// Активность людей и гостей.
//
// «Онлайн» — это активность за последние 15 минут, а не открытые сессии:
// сессия живёт месяц, и считать её было бы враньём (F-09-05 §8а).
//
// Сырые отметки активности не хранятся (F-09-05 §7): в памяти держится, кто
// недавно обращался, а раз в час в базу пишется число. Пропущенный час —
// разрыв, а не ноль: ноль означал бы «никого не было», а на деле приложение
// в этот час просто лежало (F-09-05 §5).

/** Кто недавно обращался: ключ → время в миллисекундах. */
const recent = new Map();

/**
 * Отметить активность.
 *
 * @param {string} key идентификатор человека или гостя
 */
export function markActivity(key) {
  if (!key) return;
  recent.set(key, Date.now());
}

/**
 * Сколько людей было активны за окно.
 *
 * @param {number} windowMin окно в минутах
 * @returns {{registered: number, guests: number}} зарегистрированные и гости
 */
export function activityCount(windowMin = 15) {
  const cut = Date.now() - windowMin * 60_000;
  let registered = 0;
  let guests = 0;
  for (const [key, at] of recent) {
    if (at < cut) {
      recent.delete(key);
      continue;
    }
    if (key.startsWith('u:')) registered += 1;
    else guests += 1;
  }
  return { registered, guests };
}
