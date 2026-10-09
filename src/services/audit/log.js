// Журнал аудита — построение записи и очистка метаданных.
// Спецификация: docs/01-product/features/M9-admin.md F-09-03.
// Требования: R-SEC-29 (только чтение), R-SEC-33 (секреты не попадают в журнал).
//
// Правило очистки не косметическое. Журнал — единственное доказательство
// того, что действие было санкционированным. Если в него попадёт пароль или
// токен, то утечка журнала превращается в утечку учётных данных, а сам
// журнал перестаёт быть безопасным для хранения.

// Ключи, значение которых не имеет права попасть в журнал ни при каких
// условиях.
//
// Сравнение по словам, а не по подстроке. Подстрока маскировала `keywords`
// и `keyboard` из-за «key», и в журнал попадал мусор вместо данных.
// Имя разбирается на слова по подчёркиваниям, дефисам и границе camelCase,
// после чего сверяется с набором: passwordHash, password_hash и
// PasswordHash дают один результат.
const SECRET_WORDS = new Set([
  'pass', 'password', 'passwd', 'secret', 'token', 'hash', 'key', 'salt',
  'credential', 'credentials', 'cookie', 'authorization', 'private', 'cipher',
]);

// Слитное написание в нижнем регистре (`passwordhash`) не разбирается на слова,
// поэтому добавлено правило по окончанию. Именно окончание, а не начало:
// `keywords`, `keyboard` и `hashrate` не должны маскироваться, а вот
// `passwordhash`, `privateKey`, `monkey` — должны. Ложное срабатывание на
// слове, оканчивающемся на «key», предпочтительнее утечки ключа.
const SECRET_SUFFIX = ['password', 'passwd', 'secret', 'token', 'hash', 'key', 'salt', 'cookie', 'cipher'];

function isSecretKey(key) {
  const words = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/i)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.some((w) => SECRET_WORDS.has(w))) return true;
  const squashed = words.join('');
  return SECRET_SUFFIX.some((sfx) => squashed.length > sfx.length && squashed.endsWith(sfx));
}

/** Значения, которые маскируются, а не удаляются: полезны при разборе. */
export const REDACTED = '[скрыто]';

/**
 * Убирает секреты из объекта метаданных.
 *
 * Рекурсивный: секрет часто лежит не на верхнем уровне, а в
 * `before.user.emailHash`, и проверка только верхнего уровня его пропустит.
 *
 * @template T
 * @param {T} value
 * @param {number} [depth] ограничение глубины — от защиты от зацикливания
 * @returns {T}
 */
export function sanitize(value, depth = 0) {
  if (depth > 8) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretKey(k) ? REDACTED : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Строит запись журнала.
 *
 * Причина обязательна не для удобства: без неё запись говорит «кто что
 * сделал», но не «на каком основании», и разбор инцидента упирается в
 * домыслы. Причина хранится в самой записи, а не в интерфейсе — иначе
 * теряется при выгрузке (F-09-03 правило (в)).
 *
 * @param {object} input
 * @param {number|null} input.actorId
 * @param {string} input.action
 * @param {string} input.objectType
 * @param {number|null} [input.objectId]
 * @param {'ok'|'denied'|'error'} [input.result]
 * @param {string} input.reason обязательна
 * @param {object} [input.before]
 * @param {object} [input.after]
 * @returns {object} строка для e_audit_log
 */
export function buildEntry({ actorId, action, objectType, objectId = null, result = 'ok', reason, before, after }) {
  if (!reason || !String(reason).trim()) {
    throw new Error('Причина обязательна: без неё запись не объясняет ничего');
  }
  if (!action) throw new Error('Действие обязательно');
  if (!objectType) throw new Error('Тип объекта обязателен');

  const entry = {
    actor_id: actorId ?? null,
    action: String(action),
    object_type: String(objectType),
    object_id: objectId,
    result,
    reason: String(reason).trim(),
  };

  const b = before ? sanitize(before) : null;
  const a = after ? sanitize(after) : null;
  if (b && Object.keys(b).length) entry.before_data = b;
  if (a && Object.keys(a).length) entry.after_data = a;

  return entry;
}

/**
 * Что именно изменилось между двумя состояниями.
 *
 * В журнал попадает только различие, а не снимки целиком: снимок — это
 * копия всех персональных данных объекта в журнале, который читают и
 * выгружают.
 *
 * @returns {{before:object, after:object}|null}
 */
export function diff(before, after) {
  if (!before || !after) return null;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const b = {};
  const a = {};
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return Object.keys(b).length ? { before: sanitize(b), after: sanitize(a) } : null;
}