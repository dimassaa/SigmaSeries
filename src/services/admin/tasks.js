// Последний результат задач по расписанию (F-09-06, S-82).
//
// Задачи живут в одном процессе и запускаются таймерами. Отдельной таблицы
// статусов нет: экран наблюдает за процессом, а не за историей за год.
// Реестр отвечает на один вопрос — когда задача запускалась в последний раз и
// чем это кончилось. «Не запускалась» — отдельное состояние, не успех.

/**
 * Реестр задач.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] часы, для тестов
 * @returns {any}
 */
export function createTaskRegistry({ now = () => Date.now() } = {}) {
  /** @type {Map<string, any>} */
  const tasks = new Map();

  /**
   * Завести запись задачи, если её ещё нет.
   *
   * @param {string} name
   * @returns {any}
   */
  function ensure(name) {
    const key = String(name ?? '').trim();
    if (!key) throw new Error('task name is required');
    let entry = tasks.get(key);
    if (!entry) {
      entry = {
        name: key,
        state: 'unknown',
        lastRunAt: null,
        lastOkAt: null,
        lastError: null,
        durationMs: null,
      };
      tasks.set(key, entry);
    }
    return entry;
  }

  /**
   * Обернуть задачу: результат записывается, ошибка не проглатывается.
   *
   * @param {string} name
   * @param {Function} fn
   * @returns {Function}
   */
  function wrap(name, fn) {
    const entry = ensure(name);
    return (...args) => {
      const startedAt = now();
      return Promise.resolve()
        .then(() => fn(...args))
        .then((value) => {
          entry.state = 'ok';
          entry.lastRunAt = new Date(startedAt);
          entry.lastOkAt = new Date(startedAt);
          entry.lastError = null;
          entry.durationMs = Math.max(0, now() - startedAt);
          return value;
        }, (error) => {
          entry.state = 'error';
          entry.lastRunAt = new Date(startedAt);
          entry.durationMs = Math.max(0, now() - startedAt);
          entry.lastError = String(error?.message ?? error).slice(0, 200);
          throw error;
        });
    };
  }

  /**
   * Записать результат вручную: для задач, которые не обёрнуты.
   *
   * @param {string} name
   * @param {{ok: boolean, error?: any, at?: number}} result
   * @returns {void}
   */
  function record(name, { ok, error = null, at = now() }) {
    const entry = ensure(name);
    entry.state = ok ? 'ok' : 'error';
    entry.lastRunAt = new Date(at);
    if (ok) {
      entry.lastOkAt = new Date(at);
      entry.lastError = null;
    } else {
      entry.lastError = String(error?.message ?? error ?? 'error').slice(0, 200);
    }
  }

  /**
   * Список задач в стабильном порядке.
   *
   * @returns {any[]}
   */
  function list() {
    return [...tasks.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({ ...entry }));
  }

  /**
   * Сводка для экрана.
   *
   * @returns {{items: any[], failed: number, unknown: number}}
   */
  function snapshot() {
    const items = list();
    return {
      items,
      failed: items.filter((item) => item.state === 'error').length,
      unknown: items.filter((item) => item.state === 'unknown').length,
    };
  }

  return { wrap, record, list, snapshot };
}
