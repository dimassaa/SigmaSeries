// Список пользователей для администратора (F-09-01, S-71).
//
// Числа агрегируются, а не считаются по таблице: при тысячах пользователей
// счёт на каждой строке даёт секунды (F-09-01 §8в). Email показывается
// частично: такой экран часто показывают на защите, а полный адрес в
// списке — лишняя утечка (F-09-01 §8б). При явном поиске по адресу
// результат выводится полностью: искатель и есть администратор.

import { blindIndex, decryptValue } from '../auth/crypto.js';

/** Статусы, которые видны по умолчанию; удалённые — только по явному фильтру. */
const HIDDEN_BY_DEFAULT = ['deleted'];

/**
 * Адрес для показа: первые и последние знаки, середина — точками.
 *
 * @param {string|null} address
 * @returns {string}
 */
export function maskAddress(address) {
  if (!address) return '';
  const at = address.indexOf('@');
  if (at <= 0) return address;
  const name = address.slice(0, at);
  const domain = address.slice(at);
  const head = name.slice(0, 1);
  const tail = name.length > 1 ? name.slice(-1) : '';
  return `${head}${'*'.repeat(Math.max(1, name.length - 2))}${tail}${domain}`;
}

/**
 * Останется ли кто-нибудь администратором после снятия роли.
 *
 * Правило живёт отдельно от запроса: «последнего администратора снять
 * нельзя» (F-09-02 §5) — а проверить его на общей базе нельзя, там всегда
 * есть чужие администраторы от других проверок.
 *
 * @param {number[]} admins список администраторов
 * @param {number} userId человек, которому роль снимают
 * @returns {boolean} true, если после снятия не останется ни одного
 */
export function leavesNoAdmin(admins, userId) {
  return admins.filter((id) => id !== userId).length === 0;
}

/**
 * Источник списка пользователей.
 *
 * @param {import('pg').Pool} pool
 * @returns {object}
 */
export function pgAdminUsers(pool) {
  /**
   * Страница списка с фильтрами.
   *
   * Фильтры комбинируются по «и», значения одного фильтра — по «или»
   * (F-09-01 §8а).
   *
   * @param {{nickname?: string, email?: string, roles?: string[], status?: string,
   *   registeredFrom?: string|null, registeredTo?: string|null, page?: number,
   *   pageSize?: number, showDeleted?: boolean}} input
   * @returns {Promise<{items: object[], total: number, page: number, pages: number,
   *   roles: string[], statuses: string[]}>}
   */
  async function list({
    nickname = '', email = '', roles = [], status = '', registeredFrom = null,
    registeredTo = null, page = 1, pageSize = 50, showDeleted = false,
  } = {}) {
    const current = Math.max(1, Number(page) || 1);
    const size = Math.max(1, Number(pageSize) || 50);
    const params = [];
    const where = [];

    if (nickname) {
      params.push(`%${nickname}%`);
      where.push(`u.nickname ILIKE $${params.length}`);
    }
    if (email) {
      params.push(blindIndex(email));
      where.push(`u.email_blind_idx = $${params.length}`);
    }
    if (roles.length) {
      params.push(roles);
      where.push(`EXISTS (
        SELECT 1 FROM e_role_assignment ra
         WHERE ra.user_id = u.id AND ra.role = ANY($${params.length}::text[])
           AND (ra.expires_at IS NULL OR ra.expires_at > now()))`);
    }
    if (status) {
      params.push(status);
      where.push(`u.status = $${params.length}`);
    } else if (!showDeleted) {
      // Список значений задан нами, а не человеком, поэтому литерал здесь
      // безопасен; параметр был бы лишним.
      where.push(`u.status NOT IN (${HIDDEN_BY_DEFAULT.map((value) => `'${value}'`).join(', ')})`);
    }
    if (registeredFrom) {
      params.push(registeredFrom);
      where.push(`u.registered_at >= $${params.length}::timestamptz`);
    }
    if (registeredTo) {
      params.push(registeredTo);
      where.push(`u.registered_at <= $${params.length}::timestamptz`);
    }
    where.push('u.deleted_at IS NULL');

    const { rows: [tally] } = await pool.query(
      `SELECT count(*)::int AS total FROM e_user u WHERE ${where.join(' AND ')}`,
      params,
    );
    const total = Number(tally.total);
    const pages = Math.max(1, Math.ceil(total / size));

    const { rows } = await pool.query(
      `SELECT u.id, u.nickname, u.email_enc, u.registered_at, u.last_active_at, u.locale,
              u.status, u.theme,
              (SELECT array_agg(ra.role ORDER BY ra.role) FROM e_role_assignment ra
                WHERE ra.user_id = u.id
                  AND (ra.expires_at IS NULL OR ra.expires_at > now())) AS roles,
              (SELECT count(*)::int FROM e_rating r WHERE r.user_id = u.id) AS ratings,
              (SELECT count(*)::int FROM e_material m WHERE m.author_id = u.id
                 AND m.state <> 'deleted') AS materials
         FROM e_user u
        WHERE ${where.join(' AND ')}
        ORDER BY u.registered_at DESC, u.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, size, (current - 1) * size],
    );

    // Адреса расшифровываются здесь же: отдельный запрос на строку съел бы
    // бюджет страницы, а расшифровка стоит ничего.
    const items = rows.map((row) => {
      const address = row.email_enc ? decryptValue(row.email_enc, 'email') : null;
      return {
        id: Number(row.id),
        nickname: row.nickname,
        // При поиске по адресу он и так уже известен — показываем полностью.
        address: address ? (email ? address : maskAddress(address)) : null,
        registeredAt: row.registered_at,
        lastActiveAt: row.last_active_at,
        locale: row.locale,
        status: row.status,
        roles: row.roles ?? [],
        ratings: Number(row.ratings),
        materials: Number(row.materials),
      };
    });

    return { items, total, page: current, pages, roles: [], statuses: [] };
  }

  /**
   * Карточка пользователя для администратора (F-09-02, S-72).
   *
   * @param {number} userId
   * @returns {Promise<object|null>}
   */
  async function one(userId) {
    const { rows } = await pool.query(
      `SELECT u.id, u.nickname, u.email_enc, u.registered_at, u.last_active_at, u.locale,
              u.status, u.theme, u.deleted_at,
              (SELECT array_agg(ra.role ORDER BY ra.role) FROM e_role_assignment ra
                WHERE ra.user_id = u.id
                  AND (ra.expires_at IS NULL OR ra.expires_at > now())) AS roles,
              (SELECT count(*)::int FROM e_rating r WHERE r.user_id = u.id) AS ratings,
              (SELECT count(*)::int FROM e_material m WHERE m.author_id = u.id
                 AND m.state <> 'deleted') AS materials
         FROM e_user u
        WHERE u.id = $1`,
      [userId],
    );
    const row = rows[0];
    if (!row) return null;
    const address = row.email_enc ? decryptValue(row.email_enc, 'email') : null;

    const { rows: restrictions } = await pool.query(
      `SELECT id, kind, reason, hide_materials, set_at, expires_at
         FROM e_restriction
        WHERE user_id = $1 AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY set_at DESC`,
      [userId],
    );
    const { rows: materials } = await pool.query(
      `SELECT id, kind, state, created_at, submitted_at FROM e_material
        WHERE author_id = $1 AND state <> 'deleted'
        ORDER BY submitted_at DESC LIMIT 20`,
      [userId],
    );
    const { rows: decisions } = await pool.query(
      `SELECT d.id, d.decision, d.reason, d.decided_at FROM e_editor_decision d
        WHERE d.editor_id = $1 ORDER BY d.decided_at DESC LIMIT 20`,
      [userId],
    );

    return {
      id: Number(row.id),
      nickname: row.nickname,
      address,
      registeredAt: row.registered_at,
      lastActiveAt: row.last_active_at,
      locale: row.locale,
      status: row.status,
      roles: row.roles ?? [],
      ratings: Number(row.ratings),
      materials: Number(row.materials),
      restrictions: restrictions.map((item) => ({
        id: Number(item.id),
        kind: item.kind,
        reason: item.reason,
        hideMaterials: item.hide_materials,
        setAt: item.set_at,
        expiresAt: item.expires_at,
      })),
      materialList: materials.map((item) => ({
        id: Number(item.id),
        kind: item.kind,
        state: item.state,
        createdAt: item.created_at,
        submittedAt: item.submitted_at,
      })),
      decisions: decisions.map((item) => ({
        id: Number(item.id),
        decision: item.decision,
        reason: item.reason,
        decidedAt: item.decided_at,
      })),
    };
  }

  /**
   * Администраторы — те, у кого роль есть сейчас.
   *
   * @returns {Promise<number[]>}
   */
  async function admins() {
    const { rows } = await pool.query(
      `SELECT DISTINCT user_id FROM e_role_assignment
        WHERE role = 'admin' AND (expires_at IS NULL OR expires_at > now())`,
    );
    return rows.map((row) => Number(row.user_id));
  }

  return { list, one, admins };
}
