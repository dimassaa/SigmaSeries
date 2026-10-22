// Лёгкий размыкатель (F-12-09 §3).
//
// Задача простая, а ловушки в ней три. Первая: окно считается в запросах, а не
// во времени — при 10 запросах в секунду «последние полчаса» это 18 тысяч
// запросов, и порог в 50% не сработает никогда. Вторая: после паузы окно
// обязано очищаться, иначе пауза повторялась бы до бесконечности на одних и
// тех же ответах. Третья: вызовы идут из нескольких работников параллельно, и
// без очереди двое успевают увидеть одно окно и дать две паузы подряд.
//
// Значения — стартовые (H-24): окно 50 запросов, порог 50%, пауза 5 минут,
// пауз не больше трёх, после чего запуск считается частичным.

export const WINDOW = 50;
export const FAILURE_THRESHOLD = 0.5;
export const PAUSE_MS = 5 * 60 * 1000;
export const MAX_PAUSES = 3;

/**
 * Размыкатель.
 *
 * @param {object} [options]
 * @param {(ms:number) => Promise<void>} [options.sleep] пауза; в тестах — мгновенная
 * @param {() => number} [options.now] часы; в тестах — свои
 * @param {number} [options.window]
 * @param {number} [options.threshold]
 * @param {number} [options.pauseMs]
 * @param {number} [options.maxPauses]
 * @returns {any}
 */
export function createBreaker({
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  window = WINDOW,
  threshold = FAILURE_THRESHOLD,
  pauseMs = PAUSE_MS,
  maxPauses = MAX_PAUSES,
} = {}) {
  /** Последние исходы запросов: true — неудача. Кольцевой буфер. */
  const outcomes = new Array(window).fill(false);
  let cursor = 0;
  let filled = 0;
  let failures = 0;
  let pausedCount = 0;

  /** Очередь проверок: `record` зовут из нескольких работников сразу. */
  let queue = Promise.resolve();

  const breaker = {
    get pausedCount() {
      return pausedCount;
    },
    get tripped() {
      return pausedCount >= maxPauses;
    },
    /** Сколько исходов сейчас в окне. */
    get size() {
      return filled;
    },
    /** Доля неудач в окне. */
    get failureRate() {
      return filled ? failures / filled : 0;
    },

    /**
     * Записывает исход запроса и при необходимости останавливается.
     *
     * @param {boolean} failed
     * @returns {Promise<void>}
     */
    record(failed) {
      queue = queue.then(() => check(failed));
      return queue;
    },
  };

  /** Проверка окна. Выполняется строго по очереди. */
  async function check(failed) {
    if (breaker.tripped) return;

    if (filled === window) {
      if (outcomes[cursor]) failures -= 1;
    } else {
      filled += 1;
    }
    outcomes[cursor] = failed;
    if (failed) failures += 1;
    cursor = (cursor + 1) % window;

    // Проверка только на полном окне: на трёх запросах из трёх неудачных пауза
    // была бы гарантирована при любом старте прогона.
    if (filled < window) return;
    if (failures / filled <= threshold) return;

    pausedCount += 1;
    await sleep(pauseMs);
    // Окно очищается: после паузы прошлые неудачи больше не про источник, а
    // про то, что было до неё. Иначе следующая же проверка дала бы ещё одну
    // паузу на том же самом.
    outcomes.fill(false);
    cursor = 0;
    filled = 0;
    failures = 0;
  }

  return breaker;
}