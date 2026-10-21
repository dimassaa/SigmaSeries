// Очередь тяжёлого хеширования пароля (EC-A16, F-01-11 §8б).
//
// argon2id стоит десятки миллисекунд процессорного времени. Всплеск
// регистраций — или перебор паролей — съедает машину целиком: страница
// перестаёт отвечать не потому, что код плох, а потому, что все потоки
// заняты хешами. Правило F-01-11 §8б ограничивает число одновременных
// хешей двумя, а остальные ждут в очереди.
//
// Очередь — общее состояние процесса, а не запроса: счётчик занятых
// слотов один на сервер, и создавать его на каждый запрос значило бы не
// ограничивать ничего. Поэтому очередь создаётся один раз (в `server.js`)
// и передаётся туда, где нужен.

import { AUTH } from '../../config/settings.js';

/**
 * Очередь не справилась: места не хватило или ждать пришлось дольше срока.
 *
 * Отдельный тип нужен вызывающему, чтобы ответить «сервис занят», а не
 * «ошибка сервера»: очередь переполняется при всплеске, и это не авария.
 */
export class HashQueueBusyError extends Error {
  /**
   * @param {'full'|'timeout'} reason почему очередь не справилась
   */
  constructor(reason) {
    super(`hash queue busy: ${reason}`);
    this.name = 'HashQueueBusyError';
    /** @type {'full'|'timeout'} */
    this.reason = reason;
  }
}

/**
 * Очередь хеширования: не более `parallel` задач одновременно.
 *
 * Пока все слоты заняты, задачи ждут в порядке прихода. Ждать дольше
 * `waitMs` бессмысленно — человек уйдёт раньше, чем получит ответ, — и
 * такая задача отбрасывается с ошибкой. Мест в очереди тоже не бесконечно:
 * при волне из сотни регистраций лишние получают отказ сразу, а не ждут
 * минуту впустую.
 *
 * @param {object} [options]
 * @param {number} [options.parallel] сколько хешей считать одновременно
 * @param {number} [options.capacity] сколько задач может ждать в очереди
 * @param {number} [options.waitMs] сколько ждать в очереди до отказа
 * @returns {{run: (fn: () => Promise<any>) => Promise<any>, stats: () => object}}
 */
export function createHashQueue({
  parallel = AUTH.hashParallel,
  capacity = AUTH.hashQueueMax,
  waitMs = AUTH.hashWaitMs,
} = {}) {
  /** @type {number} сколько задач считается прямо сейчас */
  let running = 0;
  /**
   * @type {Array<{fn: Function, resolve: Function, reject: Function, timer: any}>}
   * задачи в порядке прихода
   */
  const waiting = [];

  /** Запускает задачи, пока есть свободные слоты. */
  function pump() {
    while (running < parallel && waiting.length > 0) {
      const task = waiting.shift();
      clearTimeout(task.timer);
      running += 1;
      // Слот освобождается до передачи результата: вызвавший должен увидеть
      // свободную очередь сразу, а не после лишнего такта.
      (async () => {
        try {
          const value = await task.fn();
          running -= 1;
          pump();
          task.resolve(value);
        } catch (error) {
          running -= 1;
          pump();
          task.reject(error);
        }
      })();
    }
  }

  /**
   * Выполняет задачу, дождавшись свободного слота.
   *
   * @template T
   * @param {() => Promise<T>} fn тяжёлая операция (хеш пароля)
   * @returns {Promise<T>}
   */
  function run(fn) {
    return new Promise((resolve, reject) => {
      // Место в очереди нужно только тем, кому придётся ждать. Если свободен
      // слот, задача начнётся сразу, и отказывать ей незачем.
      const startsAtOnce = running < parallel && waiting.length === 0;
      if (!startsAtOnce && waiting.length >= capacity) {
        reject(new HashQueueBusyError('full'));
        return;
      }
      const task = { fn, resolve, reject, timer: null };
      task.timer = setTimeout(() => {
        const index = waiting.indexOf(task);
        // Задача уже началась — тогда таймер погашен, и отказ неуместен.
        if (index === -1) return;
        waiting.splice(index, 1);
        reject(new HashQueueBusyError('timeout'));
      }, waitMs);
      waiting.push(task);
      pump();
    });
  }

  return {
    run,
    /** Состояние очереди — для проверок и журнала. */
    stats() {
      return { running, waiting: waiting.length, parallel, capacity };
    },
  };
}
