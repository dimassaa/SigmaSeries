// Журнал безопасности.
//
// R-SEC-29 требует три вещи: паролей и токенов в журнале нет, у записи есть
// сквозной идентификатор запроса, переводы строк экранированы. Все три
// обеспечиваются здесь, а не рассчитываются на аккуратность вызывающего:
//
//   • список полей закрытый — лишнее поле не просто не пишется, а вызывает
//     ошибку. Молчаливое отбрасывание хуже: запись выглядела бы полной;
//   • переводы строк не экранируются вручную, а невозможны благодаря
//     JSON: значение с `\n` остаётся одной строкой и подделать запись нельзя;
//   • длина значения ограничена — иначе в журнал уехала бы вся введённая
//     строка.
//
// Куда пишет — дело вызывающего: сейчас это stdout по одной строке на
// событие. При появлении хранилища журнала меняется только sink, формат
// записи остаётся прежним.

/** Длина значения в записи. */
const VALUE_LIMIT = 120;

/**
 * Поля, которые разрешено передавать.
 *
 * Список короткий и расширяется вместе с первым потребителем: пустое поле
 * «на будущее» — это мёртвый код, который завтра никто не проверит.
 */
const FIELDS = {
  user_id: 'number',
  // Кто именно сбросил проверку: в журнале безопасности первый вопрос —
  // «кто это сделал», и он не должен ждать журнала администратора.
  actor_id: 'number',
  sessions_revoked: 'number',
};

/**
 * Журнал безопасности.
 *
 * @param {object} [deps]
 * @param {(line: string) => void} [deps.sink] куда уходит готовая строка
 * @returns {{security: (entry: object) => void}}
 */
export function createJournal({ sink = defaultSink } = {}) {
  return {
    /**
     * Записывает событие безопасности.
     *
     * @param {object} entry
     * @param {string} entry.event название события, латиницей
     * @param {string} entry.requestId идентификатор запроса из middleware
     * @param {number} [entry.user_id]
     * @param {number} [entry.actor_id]
     * @param {number} [entry.sessions_revoked]
     * @throws если нет события или идентификатора, либо поле не в списке:
     *   ошибка громче потерянной записи, но молча терять нельзя
     */
    security(entry) {
      const { event, requestId, ...fields } = entry ?? {};

      if (!event) throw new Error('Журнал безопасности: не указано событие');
      if (!requestId) throw new Error('Журнал безопасности: не указан requestId запроса');

      const record = {
        ts: new Date().toISOString(),
        level: 'security',
        event: limit(event),
        request: limit(requestId),
      };

      for (const [key, value] of Object.entries(fields)) {
        const kind = FIELDS[key];
        if (!kind) {
          throw new Error(
            `Журнал безопасности: неизвестное поле ${key}. Разрешены: ${Object.keys(FIELDS).join(', ')}`,
          );
        }
        if (typeof value !== kind) {
          throw new Error(`Журнал безопасности: поле ${key} должно быть ${kind}`);
        }
        record[key] = value;
      }

      // JSON сериализует управляющие символы, поэтому перевод строки внутри
      // значения физически не может разорвать запись (R-SEC-29).
      sink(JSON.stringify(record));
    },
  };
}

/** Запись по умолчанию: stdout, одна строка на событие. */
function defaultSink(line) {
  process.stdout.write(`${line}\n`);
}

/** Обрезает длинное значение, оставляя начало читаемым. */
function limit(value) {
  const text = String(value);
  return text.length <= VALUE_LIMIT ? text : `${text.slice(0, VALUE_LIMIT)}…`;
}