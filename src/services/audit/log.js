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
 * @param {any} value
 * @param {number} [depth] ограничение глубины — от защиты от зацикливания
 * @returns {any}
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
 * @param {string} [input.action]
 * @param {string} [input.objectType]
 * @param {number|null} [input.objectId]
 * @param {'ok'|'denied'|'error'} [input.result]
 * @param {string} input.reason обязательна
 * @param {any} [input.before]
 * @param {any} [input.after]
 * @returns {any} строка для e_audit_log
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
 * @returns {{before:Record<string, any>, after:Record<string, any>}|null}
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
/**
 * Запись журнала в базу.
 *
 * Писатель живёт здесь, а не в вызывающем коде по трём причинам: очистка
 * секретов (`sanitize`) обязана применяться всегда, формат строки — одно
 * место, а не копия в каждом модуле, и потому что без писателя таблица
 * `e_audit_log` была пустой: построители записи существовали, а записи не
 * создавал никто — и S-81 показывать было нечего.
 *
 * @param {import('pg').Pool} pool
 * @returns {{write: (entry: any) => Promise<any>, prune: (options?: any) => Promise<number>,
 *   list: (input?: any) => Promise<{items: any[], total: number, page: number, pages: number}>}}
 */
export function pgAuditLog(pool) {
  return {
    /**
     * Записать действие.
     *
     * @param {any} entry те же поля, что у `buildEntry`
     * @returns {Promise<any>} записанная строка
     */
    async write(entry) {
      const row = buildEntry(entry);
      const { rows } = await pool.query(
        `INSERT INTO e_audit_log
           (actor_id, action, object_type, object_id, result, reason, before_data, after_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
         RETURNING id, at`,
        [
          row.actor_id, row.action, row.object_type, row.object_id, row.result, row.reason,
          row.before_data ? JSON.stringify(row.before_data) : null,
          row.after_data ? JSON.stringify(row.after_data) : null,
        ],
      );
      return rows[0];
    },

    /**
     * Убрать записи старше срока (`audit.retention_days`).
     *
     * Ключа нет — значит «бессрочно»: так и написано в настройках модуля, и
     * выдумывать срок, которого автор не решал, нельзя. Число приходит от
     * администратора в S-83, и тогда уборка едет в ежечасный проход.
     *
     * @param {{keepDays?: number|null}} [options]
     * @returns {Promise<number>} сколько записей убрано
     */
    /**
     * Страница журнала: только чтение, с фильтрами (F-09-03, S-81).
     *
     * @param {{action?: string|null, actorId?: number|null, objectType?: string|null,
     *   objectId?: number|null, from?: string|null, to?: string|null, page?: number,
     *   pageSize?: number}} input
     * @returns {Promise<{items: any[], total: number, page: number, pages: number}>}
     */
    async list({
      action = null, actorId = null, objectType = null, objectId = null,
      from = null, to = null, page = 1, pageSize = 50,
    } = {}) {
      const current = Math.max(1, Number(page) || 1);
      const size = Math.max(1, Number(pageSize) || 50);
      const params = [];
      const where = [];
      if (action) {
        params.push(action);
        where.push(`a.action = $${params.length}`);
      }
      if (actorId) {
        params.push(actorId);
        where.push(`a.actor_id = $${params.length}`);
      }
      if (objectType) {
        params.push(objectType);
        where.push(`a.object_type = $${params.length}`);
      }
      if (objectId) {
        params.push(objectId);
        where.push(`a.object_id = $${params.length}`);
      }
      if (from) {
        params.push(from);
        where.push(`a.at >= $${params.length}::timestamptz`);
      }
      if (to) {
        params.push(to);
        where.push(`a.at <= $${params.length}::timestamptz`);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const { rows: [tally] } = await pool.query(
        `SELECT count(*)::int AS total FROM e_audit_log a ${clause}`,
        params,
      );
      const total = Number(tally.total);

      const { rows } = await pool.query(
        `SELECT a.id, a.at, a.actor_id, a.action, a.object_type, a.object_id, a.result,
                a.reason, a.before_data, a.after_data,
                u.nickname AS actor_nickname
           FROM e_audit_log a
           LEFT JOIN e_user u ON u.id = a.actor_id
           ${clause}
          ORDER BY a.at DESC, a.id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, size, (current - 1) * size],
      );

      return {
        items: rows.map((row) => ({
          id: Number(row.id),
          at: row.at,
          actorId: row.actor_id === null ? null : Number(row.actor_id),
          actorNickname: row.actor_nickname,
          action: row.action,
          objectType: row.object_type,
          objectId: row.object_id === null ? null : Number(row.object_id),
          result: row.result,
          reason: row.reason,
          before: row.before_data,
          after: row.after_data,
        })),
        total,
        page: current,
        pages: Math.max(1, Math.ceil(total / size)),
      };
    },

    async prune({ keepDays = null } = {}) {
      const days = Number(keepDays);
      if (!Number.isFinite(days) || days <= 0) return 0;

      const { rowCount } = await pool.query(
        `DELETE FROM e_audit_log WHERE at < now() - ($1 || ' days')::interval`,
        [String(days)],
      );
      return rowCount;
    },
  };
}
