// Лимит частоты в памяти процесса (`R-SEC-31`).
//
// Счёт по ключу в памяти, а не в базе: он защищает от забытой страницы и от
// случайного перебора, а не от распределённой атаки. При нескольких процессах
// каждый считает свою долю — для второй задачи нужен общий счётчик, и это
// отдельное решение (ADR-004: процесс один).
//
// Проверка идёт по адресу сети или по пользователю — то есть по тому, чем
// посетитель отличается от другого. Ключ задаёт вызывающий: для поиска это
// адрес (гостей больше, чем аккаунтов), для статуса — пользователь.

/**
 * Счётчик частоты.
 *
 * @param {object} options
 * @param {number} options.limit сколько попыток за окно
 * @param {number} options.windowMs окно в миллисекундах
 * @returns {{allow: (key: string, now?: number) => boolean, windowMs: number}}
 */
export function createRateLimiter({ limit, windowMs }) {
  /** @type {Map<string, number[]>} ключ → моменты попыток */
  const hits = new Map();

  return {
    windowMs,

    /**
     * Разрешить ли попытку.
     *
     * Попытка, которая не прошла, не записывается: иначе после серии
     * отклонений ключ «залипает» и человеку пришлось бы ждать окна даже
     * после паузы.
     *
     * @param {string} key
     * @param {number} [now]
     * @returns {boolean} `false`, если лимит исчерпан
     */
    allow(key, now = Date.now()) {
      const times = (hits.get(key) ?? []).filter((time) => now - time < windowMs);
      if (times.length >= limit) {
        hits.set(key, times);
        return false;
      }
      times.push(now);
      hits.set(key, times);

      // Периодическая чистка: без неё карта растёт по числу заходивших ключей и
      // никогда не сжимается.
      if (hits.size > 5000) {
        for (const [existing, list] of hits) {
          if (!list.some((time) => now - time < windowMs)) hits.delete(existing);
        }
      }
      return true;
    },
  };
}