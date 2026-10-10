// Доступ к учётным записям.
//
// Отдельный модуль, чтобы маршрут входа не знал SQL и чтобы его можно
// было подменить заглушкой в тестах.

import crypto from 'node:crypto';

import pg from 'pg';

const { Pool } = pg;

/**
 * Поиск по email идёт через слепой индекс: сам адрес хранится зашифрованным
 * и сравнить его в базе нельзя (M1 §0, `DATABASE.md` §2).
 */
export function pgAuthStore(pool) {
  return {
    /** @returns {object|null} строка пользователя или null */
    async byEmail(email) {
      const { rows } = await pool.query(
        `SELECT id, email_enc, password_hash, nickname, status, email_confirmed,
                locale, theme
           FROM e_user
          WHERE email_blind_idx = $1 AND deleted_at IS NULL`,
        [blindIndex(email, pool)],
      );
      return rows[0] ?? null;
    },

    async recordLogin(userId, at) {
      await pool.query('UPDATE e_user SET last_active_at = $2 WHERE id = $1', [userId, at]);
    },

    /** Роли аккаунта — от них зависит длительность сессии (R-SEC-03). */
    async roles(userId) {
      const { rows } = await pool.query(
        `SELECT role FROM e_role_assignment
          WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
        [userId],
      );
      return rows.map((r) => r.role);
    },

    /** Устройства пользователя для списка S-32 (F-01-03). */
    async sessions(userId) {
      const { rows } = await pool.query(
        `SELECT id, device_label, created_at, last_seen_at
           FROM e_session WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY last_seen_at DESC`,
        [userId],
      );
      return rows;
    },
  };
}

/**
 * Заглушка для тестов и для запуска без базы.
 *
 * Возвращает пользователя по переданной карте. Пароль хранится уже готовым
 * хешем — проверка идёт настоящей функцией, а не заглушкой.
 */
export function stubAuthStore(users = {}, roles = {}) {
  return {
    async byEmail(email) {
      const key = String(email).toLowerCase();
      return key in users ? users[key] : null;
    },
    async recordLogin() {},
    async roles(userId) {
      return roles[userId] ?? [];
    },
    async sessions() {
      return [];
    },
  };
}

/**
 * Слепой индекс email.
 *
 * HMAC с секретом приложения: обычный хеш ломается перебором по словарю
 * адресов, а такие списки продаются. Секрет задаётся окружением; без него
 * поиск работать не должен, а не работать «как-то».
 */
function blindIndex(email, pool) {
  const secret = process.env.SESSION_SECRET ?? process.env.BLIND_INDEX_SECRET;
  if (!secret) {
    throw new Error('Не задан SESSION_SECRET: без него слепой индекс вычислить нельзя');
  }
  return crypto.createHmac('sha256', secret)
    .update(String(email).toLowerCase(), 'utf8')
    .digest();
}
