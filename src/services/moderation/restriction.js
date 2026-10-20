// Мьют и бан со стороны редактора (F-05-08, R-MOD-08, R-MOD-11).
//
// Мьют останавливает поток материалов, не отнимая доступа к сервису:
// во время него не принимается ни один материал, а чтение, оценки и отметки
// работают. Бан — полная блокировка, и её может дать только администратор.
//
// Решение всегда с причиной и сроком, и всегда попадает в аудит (F-05-08 §8г):
// автор видит срок и причину, а не код правила.

import { MODERATION } from '../../config/settings.js';

/** Кто может кого ограничивать: роли, которым это нельзя (EC-R4). */
const STAFF_ROLES = ['editor', 'analyst', 'admin'];

/**
 * Источник ограничений модерации.
 *
 * @param {import('pg').Pool} pool
 * @param {object} deps
 * @param {object} [deps.auth] источник учётных записей (роли, сессии)
 * @param {object} [deps.audit] журнал действий
 * @returns {object}
 */
export function pgModerationRestrictions(pool, { auth = null, audit = null } = {}) {
  /**
   * Активное ограничение пользователя (мьют или бан).
   *
   * @param {number} userId
   * @param {Date} [at]
   * @returns {Promise<object|null>}
   */
  async function active(userId, at = new Date()) {
    const { rows } = await pool.query(
      `SELECT id, kind, kind_max_h, reason, hide_materials, set_by, set_at, expires_at
         FROM e_restriction
        WHERE user_id = $1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > $2)
        ORDER BY set_at DESC
        LIMIT 1`,
      [userId, at],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      kind: row.kind,
      maxHours: row.kind_max_h,
      reason: row.reason,
      hideMaterials: row.hide_materials,
      setBy: row.set_by === null ? null : Number(row.set_by),
      setAt: row.set_at,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Выдать мьют.
   *
   * Один активный мьют на пользователя: повторный продлевает его, а не
   * заводит второй (F-05-08 §9). Срок редактора ограничен сверху, админ
   * может больше (§8б).
   *
   * @param {{userId: number, hours: number, reason: string, byId: number,
   *   isAdmin?: boolean}} input
   * @returns {Promise<{ok: boolean, reason?: string, until?: Date|null}>}
   */
  async function mute({ userId, hours, reason, byId, isAdmin = false }) {
    const cause = String(reason ?? '').trim();
    if (!cause) return { ok: false, reason: 'reason' };

    const span = Number(hours);
    if (!Number.isFinite(span) || span < 1) return { ok: false, reason: 'hours' };
    const ceiling = isAdmin ? MODERATION.muteMaxHoursAdmin : MODERATION.muteMaxHours;
    if (span > ceiling) return { ok: false, reason: 'hours' };

    // Мьют привилегированного запрещён (EC-R4): служебного человека наказывает
    // администратор, и только он.
    if (!isAdmin && auth) {
      const roles = await auth.roles(userId);
      if (roles.some((role) => STAFF_ROLES.includes(role))) {
        return { ok: false, reason: 'privileged' };
      }
    }

    const until = new Date(Date.now() + span * 3600_000);
    const { rows: [current] } = await pool.query(
      `SELECT id FROM e_restriction
        WHERE user_id = $1 AND kind = 'mute' AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY set_at DESC LIMIT 1`,
      [userId],
    );

    if (current) {
      await pool.query(
        'UPDATE e_restriction SET expires_at = $2, reason = $3, set_by = $4, set_at = now() WHERE id = $1',
        [current.id, until, cause, byId],
      );
    } else {
      await pool.query(
        `INSERT INTO e_restriction (user_id, kind, kind_max_h, reason, set_by, expires_at)
         VALUES ($1, 'mute', $2, $3, $4, $5)`,
        [userId, span, cause, byId, until],
      );
    }

    if (audit) {
      await audit.write({
        actorId: byId,
        action: 'user.mute',
        objectType: 'user',
        objectId: userId,
        result: 'ok',
        reason: `hours=${span}; ${cause}`,
      });
    }
    return { ok: true, until };
  }

  /**
   * Выдать бан: полная блокировка, только администратор.
   *
   * @param {{userId: number, reason: string, byId: number, hideMaterials?: boolean}} input
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function ban({ userId, reason, byId, hideMaterials = false }) {
    const cause = String(reason ?? '').trim();
    if (!cause) return { ok: false, reason: 'reason' };

    await pool.query(
      `INSERT INTO e_restriction (user_id, kind, reason, hide_materials, set_by, expires_at)
       VALUES ($1, 'ban', $2, $3, $4, NULL)`,
      [userId, cause, hideMaterials, byId],
    );
    // Статус аккаунта: при бане человек не должен войти снова. Сессии
    // отзываются, но новый вход взял бы старый пароль — запрещает статус.
    await pool.query(
      "UPDATE e_user SET status = 'banned' WHERE id = $1 AND status <> 'deleted'",
      [userId],
    );
    // Бан отзывает сессии: заблокированный человек не должен остаться
    // внутри под своим прежним входом.
    if (auth?.revokeSessions) await auth.revokeSessions(userId);

    if (audit) {
      await audit.write({
        actorId: byId,
        action: 'user.ban',
        objectType: 'user',
        objectId: userId,
        result: 'ok',
        reason: `hide=${hideMaterials}; ${cause}`,
      });
    }
    return { ok: true };
  }

  /**
   * Снять ограничение: разбан возвращает материалы автора в выдачу.
   *
   * @param {{userId: number, byId: number, reason: string}} input
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function revoke({ userId, byId, reason }) {
    const cause = String(reason ?? '').trim();
    if (!cause) return { ok: false, reason: 'reason' };

    await pool.query(
      `UPDATE e_restriction SET revoked_at = now(), revoked_by = $2
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, byId],
    );
    // Статус возвращается: разбан — это отмена блокировки, а не запрет
    // оставаться в сервисе.
    await pool.query(
      "UPDATE e_user SET status = 'active' WHERE id = $1 AND status = 'banned'",
      [userId],
    );
    if (audit) {
      await audit.write({
        actorId: byId,
        action: 'user.unrestrict',
        objectType: 'user',
        objectId: userId,
        result: 'ok',
        reason: cause,
      });
    }
    return { ok: true };
  }

  return { active, mute, ban, revoke };
}
