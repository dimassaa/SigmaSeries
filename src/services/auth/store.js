// Доступ к учётным записям.
//
// Отдельный модуль, чтобы маршрут входа не знал SQL и чтобы его можно
// было подменить заглушкой в тестах.

import pg from 'pg';

import { makeToken, verifyPassword } from './password.js';
import { blindIndex, encryptValue, decryptValue } from './crypto.js';
import { sealSecret } from './totp.js';
import { AUTH } from '../../config/settings.js';

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

    /**
     * Сохраняет настройки пользователя (F-01-06 §8).
     *
     * Поля перечислены явно, а не собираются из объекта: иначе в аккаунт
     * записывалось бы всё, что пришло в теле запроса, включая `id`.
     */
    async updatePreferences(userId, values) {
      const columns = {
        theme: 'theme',
        locale: 'locale',
        timezone: 'timezone',
        stats_public: 'stats_public',
        profile_public: 'profile_public',
        recs_enabled: 'recs_enabled',
      };
      const sets = [];
      const params = [userId];
      for (const [key, column] of Object.entries(columns)) {
        if (!(key in values)) continue;
        params.push(values[key]);
        sets.push(`${column} = $${params.length}`);
      }
      if (!sets.length) return;

      await pool.query(
        `UPDATE e_user SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL`,
        params,
      );
    },

    /**
     * Смена ника (F-01-06 §4, §8(в)).
     *
     * Старое имя уходит в историю, а ное пишется в аккаунт: материалы хранят
     * ссылку на пользователя, а не копию имени (§17 фичи), и без истории не
     * объяснить старые ссылки.
     *
     * Обе записи — одна транзакция: имя сменилось, а история не записалась бы
     * при откате, и срок смены стал бы бесконечным.
     */
    async changeNickname(userId, nickname) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: current } = await client.query(
          'SELECT nickname FROM e_user WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
          [userId],
        );
        if (!current.length) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'no_user' };
        }

        const { rows: open } = await client.query(
          'SELECT id FROM e_nickname_history WHERE user_id = $1 AND valid_to IS NULL LIMIT 1',
          [userId],
        );
        if (open.length) {
          await client.query(
            'UPDATE e_nickname_history SET valid_to = now() WHERE id = $1',
            [open[0].id],
          );
        } else {
          // Открытой строки нет — значит это первая смена. Прежний ник
          // записывается **закрытым**: он больше не действует, и открытая
          // строка означала бы, что ник менять можно снова и снова.
          await client.query(
            `INSERT INTO e_nickname_history (user_id, nickname, valid_from, valid_to)
             VALUES ($1, $2, now(), now())`,
            [userId, current[0].nickname],
          );
        }

        await client.query('UPDATE e_user SET nickname = $2 WHERE id = $1', [userId, nickname]);
        await client.query('COMMIT');
        return { ok: true, previous: current[0].nickname };
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },

    /** История ников, свежая первой (F-01-06 §4). */
    async nicknameHistory(userId) {
      const { rows } = await pool.query(
        `SELECT nickname, valid_from, valid_to FROM e_nickname_history
          WHERE user_id = $1 ORDER BY valid_from DESC`,
        [userId],
      );
      return rows;
    },

    /**
     * Устройства аккаунта для S-32 (F-01-03).
     *
     * Берётся `e_session` — список устройств, а не таблица `session`
     * (хранилище сессий connect-pg-simple). Секретов в списке нет: наружу
     * уходят только подпись устройства и даты.
     */
    async devices(userId) {
      const { rows } = await pool.query(
        `SELECT id, device_label, created_at, last_seen_at FROM e_session
          WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY last_seen_at DESC`,
        [userId],
      );
      return rows;
    },

    /**
     * Отзыв одного устройства (F-01-03).
     *
     * Только то, что принадлежит владельцу: идентификатор из тела запроса
     * проверяется условием `user_id`, иначе один запрос выбил бы чужую
     * сессию (R-SEC-10).
     */
    async revokeDevice(userId, sessionId) {
      // Идентификатор приходит из формы, а столбец — bigint. Без проверки
      // «чужое» привело бы к ошибке разбора запроса и 500 там, где человек
      // должен увидеть «устройство не найдено».
      if (!/^\d+$/.test(String(sessionId ?? ''))) return false;

      const { rowCount } = await pool.query(
        'UPDATE e_session SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
        [sessionId, userId],
      );
      return (rowCount ?? 0) > 0;
    },

    async recordLogin(userId, at) {
      await pool.query('UPDATE e_user SET last_active_at = $2 WHERE id = $1', [userId, at]);
    },

    /**
     * Адрес аккаунта для служебного письма.
     *
     * Отдельный метод, а не поле в `byEmail`: поиск идёт по адресу, который у
     * вызывающего уже есть, а письмо о смене пароля адреса не знает — в
     * токене его нет, и там лежит только идентификатор пользователя (F-01-04
     * §4). Расшифровка происходит здесь и нигде больше.
     *
     * @returns {Promise<string|null>} адрес или null, если его не шифровали
     */
    async addressOf(userId) {
      const { rows } = await pool.query(
        'SELECT email_enc FROM e_user WHERE id = $1 AND deleted_at IS NULL',
        [userId],
      );
      return rows[0] ? decryptValue(rows[0].email_enc, 'email') : null;
    },

    // ─── Двухфакторная проверка (F-01-05) ────────────────────────────────────

    /**
     * Состояние 2FA аккаунта.
     *
     * @returns {Promise<{secret:string, lastStep:number|null,
     *   backup:Buffer[]}|null>} null, если 2FA не настроена
     */
    async twoFactor(userId) {
      const { rows } = await pool.query(
        `SELECT t.secret_enc, t.last_accepted_step, c.code_hash
           FROM e_two_factor t
           LEFT JOIN e_two_factor_code c
             ON c.user_id = t.user_id AND c.used_at IS NULL
          WHERE t.user_id = $1`,
        [userId],
      );
      if (!rows.length) return null;

      return {
        secret: decryptValue(rows[0].secret_enc, 'totp'),
        lastStep: rows[0].last_accepted_step === null ? null : Number(rows[0].last_accepted_step),
        backup: rows.filter((r) => r.code_hash).map((r) => r.code_hash),
      };
    },

    /**
     * Включает 2FA и кладёт резервные коды.
     *
     * Запись секрета и кодов — одна транзакция: секрет без кодов оставил бы
     * человека без входа при потере телефона, а коды без секрета были бы
     * единственным способом войти.
     */
    async enableTwoFactor(userId, secret, backupHashes) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO e_two_factor (user_id, secret_enc) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET secret_enc = $2, enabled_at = now(),
                                                   last_accepted_step = NULL`,
          [userId, sealSecret(secret)],
        );
        // Старые коды гасятся: перегенерация делает прежние недействительными
        // (F-01-05 §8).
        await client.query('DELETE FROM e_two_factor_code WHERE user_id = $1', [userId]);
        for (const hash of backupHashes) {
          await client.query(
            'INSERT INTO e_two_factor_code (user_id, code_hash) VALUES ($1, $2)',
            [userId, hash],
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },

    /**
     * Запоминает последний принятый шаг кода.
     *
     * Тот же шаг второй раз не пройдёт (F-01-05 §8). Обновление с условием
     * `>` защищает от гонки: два запроса с одним кодом не должны оба пройти.
     */
    async acceptStep(userId, step) {
      await pool.query(
        `UPDATE e_two_factor SET last_accepted_step = $2
          WHERE user_id = $1
            AND (last_accepted_step IS NULL OR last_accepted_step < $2)`,
        [userId, step],
      );
    },

    /** Гасит резервный код: он одноразовый (F-01-05 §9). */
    async consumeBackupCode(userId, codeHash) {
      const { rowCount } = await pool.query(
        `UPDATE e_two_factor_code SET used_at = now()
          WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
        [userId, codeHash],
      );
      return (rowCount ?? 0) > 0;
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

    /**
     * Занят ли адрес.
     *
     * Тот же слепой индекс, что и у поиска: сравнить сам адрес в базе нельзя,
     * иначе шифрование оказывается бесполезным.
     */
    async emailFree(email) {
      const { rows } = await pool.query(
        `SELECT 1 FROM e_user WHERE email_blind_idx = $1 AND deleted_at IS NULL LIMIT 1`,
        [blindIndex(email, pool)],
      );
      return rows.length === 0;
    },

    /**
     * Занят ли ник.
     *
     * Сравнение нечувствительно к регистру, хотя уникальный индекс в базе
     * чувствителен: иначе «Anna» и «anna» считались бы разными людьми, и
     * проверка формы вводила бы в заблуждение (EC-A5).
     *
     * Исключение по идентификатору — не украшение: свой ник не занят, иначе
     * сохранение профиля без правки имени отвечало бы «занято» (F-01-06 §4).
     */
    async nicknameFree(nickname, exceptUserId = null) {
      const { rows } = await pool.query(
        `SELECT 1 FROM e_user
          WHERE lower(nickname) = lower($1)
            AND id IS DISTINCT FROM $2
            AND deleted_at IS NULL LIMIT 1`,
        [String(nickname ?? '').trim(), exceptUserId],
      );
      return rows.length === 0;
    },

    /**
     * Проверяет текущий пароль: смена пароля, 2FA и смена адреса требуют его
     * (F-01-06 §4).
     *
     * Хеш читается из базы, а не берётся из сессии: сессия хранит
     * идентификатор и роли, а не пароль.
     *
     * @returns {Promise<boolean>}
     */
    async verifyCurrent(userId, password) {
      const { rows } = await pool.query(
        'SELECT password_hash FROM e_user WHERE id = $1 AND deleted_at IS NULL',
        [userId],
      );
      if (!rows.length) return false;
      return verifyPassword(String(password ?? ''), rows[0].password_hash);
    },

    /**
     * Уведомления (F-01-06 §4).
     *
     * Отдельный метод, а не часть `updatePreferences`: переключатели
     * уведомлений относятся к M3, и когда тот появится, у него будут свои
     * категории и свои правила хранения.
     */
    async updateNotifications(userId, values) {
      const columns = {
        notifications_enabled: 'notifications_enabled',
        quiet_hours: 'quiet_hours',
      };
      const sets = [];
      const params = [userId];
      for (const [key, column] of Object.entries(columns)) {
        if (!(key in values)) continue;
        params.push(Boolean(values[key]));
        sets.push(`${column} = $${params.length}`);
      }
      if (!sets.length) return;

      await pool.query(
        `UPDATE e_user SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL`,
        params,
      );
    },

    /**
     * Выключает 2FA (F-01-05 §8, F-01-06 §4).
     *
     * Строка удаляется, а не помечается: «настроена» и «выключена» — одно и
     * то же состояние, третьего нет ни в фиче, ни в схеме. Право выключать
     * проверяет маршрут, а не хранилище: решение о роли принимается там.
     *
     * @returns {Promise<boolean>} было ли что выключать
     */
    async disableTwoFactor(userId) {
      const { rowCount } = await pool.query(
        'DELETE FROM e_two_factor WHERE user_id = $1',
        [userId],
      );
      return (rowCount ?? 0) > 0;
    },

    /**
     * Когда ник меняли последний раз; null, если никогда.
     *
     * @returns {Promise<Date|null>}
     */
    async nicknameChangedAt(userId) {
      const { rows } = await pool.query(
        `SELECT valid_from FROM e_nickname_history
          WHERE user_id = $1 ORDER BY valid_from DESC LIMIT 1`,
        [userId],
      );
      return rows.length ? new Date(rows[0].valid_from) : null;
    },

    /**
     * Создаёт неподтверждённый аккаунт вместе с токеном подтверждения.
     *
     * Обе записи идут одной транзакцией: аккаунт без токена нельзя
     * подтвердить, а токен без аккаунта бессмыслен. При гонке по уникальному
     * индексу откатывается вся транзакция, и маршрут отвечает нейтрально
     * (EC-A1) — вместо того чтобы сообщить, что адрес занят.
     */
    async createUser(fields) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // В email_hash кладётся тот же HMAC, что и в слепой индекс, и это
        // осознанно: обычный sha256 адреса ломается перебором по словарю
        // адресов, а такие списки продаются. Второй столбец тогда избыточен,
        // но он есть в схеме, и дублирование честнее, чем слабый хеш.
        const blind = blindIndex(fields.email);
        const { rows } = await client.query(
          `INSERT INTO e_user (email_hash, email_blind_idx, email_enc, password_hash,
                               nickname, status, email_confirmed, timezone, locale, theme)
           VALUES ($1, $2, $3, $4, $5, 'active', FALSE, $6, $7, $8)
           RETURNING id`,
          [
            blind,
            blind,
            encryptValue(fields.email, 'email'),
            fields.passwordHash,
            fields.nickname,
            fields.timezone,
            fields.locale,
            fields.theme,
          ],
        );
        const user = rows[0];
        await client.query(
          `INSERT INTO e_auth_token (user_id, kind, token_hash, expires_at)
           VALUES ($1, 'email_verify', $2, now() + ($3 || ' minutes')::interval)`,
          [user.id, fields.tokenHash, String(AUTH.tokenTtlMin)],
        );
        // Согласие пишется сразу, а не «когда-нибудь потом»: без записи
        // об условиях обработки нечем подтвердить, что человек их принял.
        await client.query(
          `INSERT INTO e_consent (user_id, category, granted) VALUES ($1, 'necessary', TRUE)`,
          [user.id],
        );
        await client.query('COMMIT');
        return user;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    /**
     * Новый токен подтверждения вместо прежнего.
     *
     * Старые токены этого назначения гасятся: письмо со старой ссылкой уже
     * не должно работать, иначе по ссылке из чужого письма можно войти
     * позже (F-01-02 §5). Возвращает null, если аккаунта нет или он уже
     * подтверждён — письмо в этом случае просто не отправляется.
     */
    async newVerificationToken(email) {
      const user = await this.byEmail(email);
      if (!user || user.email_confirmed) return null;
      const { token, hash } = makeToken();
      await pool.query(
        `UPDATE e_auth_token SET used_at = now()
          WHERE user_id = $1 AND kind = 'email_verify' AND used_at IS NULL`,
        [user.id],
      );
      await pool.query(
        `INSERT INTO e_auth_token (user_id, kind, token_hash, expires_at)
         VALUES ($1, 'email_verify', $2, now() + ($3 || ' minutes')::interval)`,
        [user.id, hash, String(AUTH.tokenTtlMin)],
      );
      return { token, userId: user.id };
    },

    /**
     * Токен по хешу — вместе с владельцем.
     *
     * Возвращает и уже использованные: различать «уже подтверждён» и
     * «ссылка битая» нужно, чтобы показать разные подсказки (F-01-02 §5).
     *
     * Ник, язык и тема идут тем же запросом: маршруту они нужны, чтобы
     * открыть сессию, а взять их больше негде — в строке токена лежит
     * только ссылка на пользователя, а адрес хранится шифром и слепым
     * индексом, то есть по нему человека не найти.
     */
    async tokenByHash(hash) {
      if (!hash) return null;
      const { rows } = await pool.query(
        `SELECT t.id, t.user_id, t.kind, t.token_hash, t.expires_at, t.used_at,
                u.nickname, u.locale, u.theme
           FROM e_auth_token t
           JOIN e_user u ON u.id = t.user_id
          WHERE t.token_hash = $1`,
        [hash],
      );
      return rows[0] ?? null;
    },

    /**
     * Подтверждает адрес и открывает права зрителя.
     *
     * Роли зрителя в базе нет: служебные роли лежат в `e_role_assignment`,
     * а её отсутствие и означает зрителя. Запись «роль viewer» была бы
     * дублированием состояния, которое уже выводится из таблицы ролей.
     */
    async confirmEmail(userId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE e_user SET email_confirmed = TRUE, status = 'active'
            WHERE id = $1 AND deleted_at IS NULL`,
          [userId],
        );
        // Гасятся все прочие токены этого назначения: подтверждение
        // адреса необратимо, второй действующий токен — лишний.
        await client.query(
          `UPDATE e_auth_token SET used_at = now()
            WHERE user_id = $1 AND kind = 'email_verify' AND used_at IS NULL`,
          [userId],
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    /**
     * Заявка на восстановление пароля (F-01-04).
     *
     * Токен выдаётся только подтверждённому действующему аккаунту; иначе
     * возвращается null, и маршрут отвечает одинаково — по разнице ответов
     * адреса перебираются (R-SEC-06).
     *
     * Прежние токены сброса не гасятся: F-01-04 §8 говорит, что токен
     * гасится при успешной смене, а не раньше. Гасит их `resetPassword`.
     *
     * @returns {Promise<{token:string, userId:number}|null>}
     */
    async newResetToken(email) {
      const user = await this.byEmail(email);
      if (!user || !user.email_confirmed || user.status !== 'active') return null;
      const { token, hash } = makeToken();
      await pool.query(
        `INSERT INTO e_auth_token (user_id, kind, token_hash, expires_at)
         VALUES ($1, 'password_reset', $2, now() + ($3 || ' minutes')::interval)`,
        [user.id, hash, String(AUTH.tokenTtlMin)],
      );
      return { token, userId: user.id };
    },

    /**
     * Меняет пароль и гасит все токены сброса (F-01-04 §8).
     *
     * Одноразовость обеспечивается здесь, а не при открытии формы: ссылку
     * открывает и почтовый сканер, и тогда она умерла бы до человека.
     */
    async resetPassword(userId, passwordHash) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE e_user SET password_hash = $2 WHERE id = $1 AND deleted_at IS NULL',
          [userId, passwordHash],
        );
        await client.query(
          `UPDATE e_auth_token SET used_at = now()
            WHERE user_id = $1 AND kind = 'password_reset' AND used_at IS NULL`,
          [userId],
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    /**
     * Отзывает все сессии пользователя (R-SEC-02, EC-A9).
     *
     * Сессии лежат в таблице connect-pg-simple, а не в `e_session`: там
     * хранилище, а `e_session` — список устройств для S-32. У хранилища нет
     * ни перечисления, ни поиска по владельцу, поэтому удаление идёт по
     * идентификатору внутри JSON. Записи без владельца (гостевые формы)
     * не трогаются: `->>` для них даёт NULL, а NULL не равен ничему.
     *
     * @returns {Promise<number>} сколько сессий отозвано
     */
    async revokeSessions(userId) {
      const { rowCount } = await pool.query(
        `DELETE FROM session WHERE (sess -> 'user' ->> 'id')::bigint = $1`,
        [userId],
      );
      return rowCount ?? 0;
    },
  };
}

/**
 * Заглушка для тестов и для запуска без базы.
 *
 * Возвращает пользователя по переданной карте. Пароль хранится уже готовым
 * хешем — проверка идёт настоящей функцией, а не заглушкой. Регистрация
 * работает по-настоящему: без неё HTTP-тесты проверяли бы страницу,
 * которой никто не может воспользоваться.
 *
 * @param {Record<string, object>} users по email в нижнем регистре
 * @param {Record<number, string[]>} roles роли по id пользователя
 */
export function stubAuthStore(users = {}, roles = {}) {
  /** @type {Map<string, object>} токены по хешу, как в настоящей таблице */
  const tokens = new Map();
  let nextId = 1;

  /** История ников: пользователь → строки `e_nickname_history`. */
  const nicknameHistory = [];
  /** Устройства: пользователь → строки `e_session`. */
  const devices = new Map();
  /**
   * Журнал вызовов для утверждений тестов.
   *
   * Собирается здесь, а не в обёртках теста: обёртка проверяла бы, что
   * позвали функцию, а не что отозвали именно то устройство.
   */
  const calls = { revokeSessions: [], revokeDevice: [] };

  return {
    async byEmail(email) {
      const key = String(email).toLowerCase();
      return key in users ? users[key] : null;
    },
    /**
     * Адрес аккаунта. У заглушки он и есть в готовом виде: хранится он
     * здесь же, объектом, а не шифротекстом. Возвращается то же, что вернула
     * бы настоящая база после расшифровки.
     */
    async addressOf(userId) {
      const found = Object.values(users).find((u) => u.id === userId);
      return found ? String(found.email) : null;
    },
    async recordLogin() {},
    async roles(userId) {
      return roles[userId] ?? [];
    },
    async sessions() {
      return [];
    },

    async emailFree(email) {
      return !(String(email).toLowerCase() in users);
    },

    async createUser(fields) {
      // Уникальный индекс воспроизводится в памяти: без этого гонка двух
      // одинаковых регистраций (EC-A1) на тестах не воспроизводится.
      if (!this.emailFree || !(await this.emailFree(fields.email))) {
        throw new Error('duplicate email');
      }
      if (!(await this.nicknameFree(fields.nickname))) {
        throw new Error('duplicate nickname');
      }
      const id = nextId++;
      users[String(fields.email).toLowerCase()] = {
        id,
        // Шифротекст, а не открытый адрес: заглушка обязана вести себя как
        // база, иначе тесты на заглушке проверяли бы то, чего нет в бою.
        email_enc: encryptValue(fields.email, 'email'),
        password_hash: fields.passwordHash,
        nickname: fields.nickname,
        status: 'active',
        email_confirmed: fields.confirmed ?? false,
        locale: fields.locale,
        theme: fields.theme,
      };
      if (fields.tokenHash) {
        tokens.set(fields.tokenHash.toString('base64url'), {
          id: id,
          user_id: id,
          kind: 'email_verify',
          token_hash: fields.tokenHash,
          expires_at: new Date(Date.now() + AUTH.tokenTtlMin * 60_000),
          used_at: null,
        });
      }
      return { id };
    },

    async newVerificationToken(email) {
      const user = await this.byEmail(email);
      if (!user || user.email_confirmed) return null;
      for (const [key, row] of tokens) {
        if (row.user_id === user.id) tokens.set(key, { ...row, used_at: new Date() });
      }
      const { token, hash } = makeToken();
      tokens.set(hash.toString('base64url'), {
        id: user.id,
        user_id: user.id,
        kind: 'email_verify',
        token_hash: hash,
        expires_at: new Date(Date.now() + AUTH.tokenTtlMin * 60_000),
        used_at: null,
      });
      return { token, userId: user.id };
    },

    async tokenByHash(hash) {
      if (!hash) return null;
      const row = tokens.get(Buffer.from(hash).toString('base64url'));
      if (!row) return null;
      // Владелец приписывается так же, как его отдаёт настоящий запрос
      // соединением: иначе маршрут открыл бы сессию с пустым ником.
      const owner = Object.values(users).find((u) => u.id === row.user_id) ?? {};
      return { ...row, nickname: owner.nickname, locale: owner.locale, theme: owner.theme };
    },

    async confirmEmail(userId) {
      const user = Object.values(users).find((u) => u.id === userId);
      if (user) user.email_confirmed = true;
      for (const [key, row] of tokens) {
        if (row.user_id === userId) tokens.set(key, { ...row, used_at: new Date() });
      }
    },

    async newResetToken(email) {
      const user = await this.byEmail(email);
      if (!user || !user.email_confirmed || user.status !== 'active') return null;
      const { token, hash } = makeToken();
      tokens.set(hash.toString('base64url'), {
        id: user.id,
        user_id: user.id,
        kind: 'password_reset',
        token_hash: hash,
        expires_at: new Date(Date.now() + AUTH.tokenTtlMin * 60_000),
        used_at: null,
      });
      return { token, userId: user.id };
    },

    async resetPassword(userId, passwordHash) {
      const user = Object.values(users).find((u) => u.id === userId);
      if (!user) throw new Error('нет такого пользователя');
      user.password_hash = passwordHash;
      for (const [key, row] of tokens) {
        if (row.user_id === userId && row.kind === 'password_reset') {
          tokens.set(key, { ...row, used_at: new Date() });
        }
      }
    },

    /**
     * Заглушка не дотягивается до хранилища сессий: оно живёт отдельно от
     * учётных записей. Настоящее удаление проверяется против живой базы
     * (`tests/auth.store.test.js`); здесь важно, что метод есть и вызывается.
     */
    async revokeSessions(userId) {
      calls.revokeSessions.push([userId]);
      return 0;
    },

    // ─── Двухфакторная проверка (F-01-05) ────────────────────────────────────

    /**
     * Состояние 2FA из карты аккаунтов.
     *
     * Форма ответа повторяет то, что отдаёт база: секрет строкой, последний
     * шаг числом или null, хеши кодов — **массивом**. `Set` выглядел бы
     * естественнее, но база отдаёт результат запроса, и расхождение формы
     * ломает маршрут в тот момент, когда человек вводит резервный код.
     */
    async twoFactor(userId) {
      const found = Object.values(users).find((u) => u.id === userId);
      const state = found?.twoFactor;
      if (!state) return null;
      return {
        secret: state.secret,
        lastStep: state.lastStep ?? null,
        backup: [...(state.backup ?? [])],
      };
    },

    /**
     * Заглушка позволяет задать состояние напрямую — так задаёт и тест.
     *
     * `Set` приводится к массиву сразу: маршрут работает с массивом (его
     * отдаёт база), и оставить здесь другую форму значило бы, что проверки
     * HTTP идут по структуре, которой в бою не будет.
     */
    setTwoFactor(userId, state) {
      const found = Object.values(users).find((u) => u.id === userId);
      if (!found) return;
      found.twoFactor = {
        lastStep: null,
        ...state,
        backup: [...(state.backup ?? [])],
      };
    },

    /** Кладёт секрет и коды; старые коды заменяются, как и в базе. */
    async enableTwoFactor(userId, secret, backupHashes) {
      const found = Object.values(users).find((u) => u.id === userId);
      if (!found) return;
      found.twoFactor = { secret, lastStep: null, backup: [...backupHashes] };
    },

    /**
     * Шаг запоминается с проверкой «больше прежнего»: заглушка повторяет
     * защиту от гонки, иначе тесты на HTTP держали бы зелёными поведение,
     * которого нет в базе.
     */
    async acceptStep(userId, step) {
      const found = Object.values(users).find((u) => u.id === userId);
      if (!found?.twoFactor) return;
      const current = found.twoFactor.lastStep;
      if (current === null || current === undefined || current < step) {
        found.twoFactor.lastStep = step;
      }
    },

    /**
     * Заглушка: выключение 2FA — это удаление состояния.
     */
    async disableTwoFactor(userId) {
      const found = Object.values(users).find((u) => u.id === userId);
      if (!found?.twoFactor) return false;
      delete found.twoFactor;
      return true;
    },

    /** Гасит код: ищется по хешу, как в базе. */
    async consumeBackupCode(userId, codeHash) {
      const found = Object.values(users).find((u) => u.id === userId);
      const codes = found?.twoFactor?.backup;
      if (!codes) return false;
      const index = codes.findIndex((h) => h.equals(codeHash));
      if (index < 0) return false;
      codes.splice(index, 1);
      return true;
    },

    /**
     * Смена ника (F-01-06 §4).
     *
     * Старое имя не затирается, а уходит в историю: материалы хранят ссылку
     * на пользователя, а не копию имени (§8(в) фичи), и без истории ни срока
     * смены не проверить, ни старые ссылки не объяснить.
     *
     * Время берётся настоящее, а не из внедрённых часов: заглушка не знает
     * про `now`, и подмена рассинхронизировала бы её с маршрутом.
     */
    async changeNickname(userId, nickname) {
      const found = Object.values(users).find((u) => u.id === userId);
      if (!found) return { ok: false, reason: 'no_user' };
      const previous = found.nickname;
      const at = Date.now();

      nicknameHistory.push({
        user_id: userId, nickname: previous, valid_from: found.nickSince ?? at, valid_to: at,
      });
      found.nickname = nickname;
      found.nickSince = at;
      return { ok: true, previous };
    },

    /**
     * История ников аккаунта, свежая первой.
     *
     * @returns {Promise<Array<{nickname:string, valid_from:number, valid_to:number|null}>>}
     */
    async nicknameHistory(userId) {
      return nicknameHistory
        .filter((row) => row.user_id === userId)
        .sort((a, b) => b.valid_from - a.valid_from);
    },

    /** Когда ник меняли последний раз; null, если никогда. */
    async nicknameChangedAt(userId) {
      const history = await this.nicknameHistory(userId);
      return history.length ? history[0].valid_from : null;
    },

    /** Проверяет текущий пароль: смена пароля и 2FA требуют его (F-01-06 §4). */
    async verifyCurrent(userId, password) {
      const found = Object.values(users).find((u) => u.id === userId);
      if (!found) return false;
      return verifyPassword(password, found.password_hash);
    },

    /** Устройства аккаунта для раздела «Безопасность». */
    async devices(userId) {
      return devices.get(userId) ?? [];
    },

    /**
     * Отзыв одного устройства.
     *
     * Отзывается только то, что принадлежит владельцу: идентификатор из тела
     * запроса проверяется по списку, иначе один запрос выбил бы чужую сессию
     * (R-SEC-10).
     */
    async revokeDevice(userId, sessionId) {
      const mine = devices.get(userId) ?? [];
      // Проверка членства вместо разбора: чужой или выдуманный идентификатор
      // просто не найдётся, и ошибки разбора не будет (у настоящей базы
      // столбец bigint, и «чужое» уронило бы запрос).
      if (!mine.some((d) => String(d.id) === String(sessionId))) return false;

      calls.revokeDevice.push([userId, sessionId]);
      devices.set(userId, mine.filter((d) => d.id !== sessionId));
      return true;
    },

    /**
     * Уведомления (F-01-06 §4).
     *
     * Отдельный метод, а не часть `updatePreferences`: переключатели
     * уведомлений относятся к M3, и когда тот появится, у него будут свои
     * категории и свои правила хранения.
     */
    async updateNotifications(userId, values) {
      const found = Object.values(users).find((u) => u.id === userId);
      if (!found) return;
      const allowed = ['notifications_enabled', 'quiet_hours'];
      for (const [key, value] of Object.entries(values)) {
        if (allowed.includes(key)) found[key] = value;
      }
    },

    /** Тестовые заглушки для списка устройств и журнала вызовов. */
    setSessions(userId, list) {
      devices.set(userId, list);
    },

    /**
     * Проверка занятости ника (F-01-06 §4).
     *
     * Свой ник не занят: человек меняет имя на то же самое и должен получить
     * «сохранено», а не «занято».
     */
    async nicknameFree(nickname, exceptUserId = null) {
      const taken = String(nickname).toLowerCase();
      return !Object.values(users).some((u) => (
        String(u.nickname).toLowerCase() === taken && u.id !== exceptUserId
      ));
    },

    /** Заглушка: значения остаются в объекте аккаунта.
     *
     * Фильтруются только те поля, которые на самом деле принадлежат
     * настройкам. Пропуск фильтра означал бы, что в аккаунт можно записать
     * что угодно — по одному POST.
     */
    async updatePreferences(userId, values) {
      const found = Object.values(users).find((u) => u.id === userId);
      if (!found) return;
      const allowed = ['theme', 'locale', 'timezone', 'stats_public', 'profile_public', 'recs_enabled'];
      for (const [key, value] of Object.entries(values)) {
        if (allowed.includes(key)) found[key] = value;
      }
    },

    /** Доступ к внутренностям для утверждений в тестах. */
    _tokens: tokens,
    /** Журнал вызовов: отзывов сессий и устройств. */
    calls,
  };
}
