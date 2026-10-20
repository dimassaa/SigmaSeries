// Доступ к учётным записям.
//
// Отдельный модуль, чтобы маршрут входа не знал SQL и чтобы его можно
// было подменить заглушкой в тестах.

import pg from 'pg';

import { makeToken, hashToken, verifyPassword } from './password.js';
import { blindIndex, encryptValue, decryptValue } from './crypto.js';
import { sessionHash } from './device.js';
import { sealSecret } from './totp.js';
import { AUTH, STAFF_ROLES } from '../../config/settings.js';

const { Pool } = pg;

/**
 * Поиск по email идёт через слепой индекс: сам адрес хранится зашифрованным
 * и сравнить его в базе нельзя (M1 §0, `DATABASE.md` §2).
 */
/** Время в виде `ЧЧ:ММ` — единственное, что принимают тихие часы (F-03-10 §9). */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Сколько аккаунтов обезличивает один проход по неподтверждённым.
 *
 * Обезличивание идёт транзакцией на аккаунт и трогает около десятка таблиц,
 * поэтому порция ограничена: без неё всплеск давно неподтверждённых
 * аккаунтов превратил бы ежечасный проход в очередь на полчаса.
 */
const UNVERIFIED_BATCH = 100;

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
     * Тема человека из профиля.
     *
     * Читается из базы, а не из сессии: сессия хранит снимок на момент входа,
     * и выбор темы, сделанный позже, в ней остался бы старым — а страница
     * берёт тему отсюда на каждом экране.
     *
     * @param {number} userId
     * @returns {Promise<string|null>} тема или null, если человека нет
     */
    async themeOf(userId) {
      const { rows } = await pool.query('SELECT theme FROM e_user WHERE id = $1', [userId]);
      return rows[0]?.theme ?? null;
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
     * уходят подпись устройства, усечённый адрес и даты.
     *
     * Текущее устройство отмечается сравнением хешей: сам идентификатор
     * сессии в списке не хранится, поэтому сравнивать больше нечего.
     *
     * @param {number} userId
     * @param {string|null} [currentHash] хеш идентификатора текущей сессии
     * @returns {Promise<object[]>}
     */
    async devices(userId, currentHash = null) {
      const { rows } = await pool.query(
        `SELECT id, device_label, sid_hash, ip_prefix, created_at, last_seen_at
           FROM e_session
          WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY last_seen_at DESC`,
        [userId],
      );
      return rows.map((row) => ({
        ...row,
        current: row.sid_hash !== null && row.sid_hash === currentHash,
      }));
    },

    /**
     * Отзыв одного устройства (F-01-03).
     *
     * Только то, что принадлежит владельцу: идентификатор из тела запроса
     * проверяется условием `user_id`, иначе один запрос выбил бы чужую
     * сессию (R-SEC-10).
     *
     * Отзыв должен закончить саму сессию, а не только убрать строку из
     * списка: иначе «Выйти на этом» оставлял бы человека залогиненным на
     * устройстве, которое он только что закрыл. Связь строится по хешу
     * идентификатора: живая сессия находится перебором сессий аккаунта и
     * сравнением хешей, а сам идентификатор в базе не хранится.
     */
    async revokeDevice(userId, sessionId) {
      // Идентификатор приходит из формы, а столбец — bigint. Без проверки
      // «чужое» привело бы к ошибке разбора запроса и 500 там, где человек
      // должен увидеть «устройство не найдено».
      if (!/^\d+$/.test(String(sessionId ?? ''))) return false;

      const { rows } = await pool.query(
        `UPDATE e_session SET revoked_at = now()
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
          RETURNING sid_hash`,
        [sessionId, userId],
      );
      if (!rows.length) return false;

      const hash = rows[0].sid_hash;
      if (!hash) return true;

      const { rows: live } = await pool.query(
        "SELECT sid FROM session WHERE (sess -> 'user' ->> 'id') = $1::text",
        [userId],
      );
      const doomed = live.map((row) => row.sid).find((sid) => sessionHash(sid) === hash);
      if (doomed) await pool.query('DELETE FROM session WHERE sid = $1', [doomed]);
      return true;
    },

    /**
     * Заявка на смену адреса (F-01-06 §4).
     *
     * Заявка на пользователя одна: новая отменяет предыдущую, иначе две
     * одновременные смены означали бы, что подтверждение старой применяет
     * адрес, который человек уже передумал.
     *
     * Возвращает токен для письма на **новый** адрес: пока владение им не
     * доказано, аккаунт остаётся на старом.
     *
     * @returns {Promise<{token:string}|null>} null, если адрес занят или свой
     */
    async requestEmailChange(userId, email, token, expiresAt) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const blind = blindIndex(email);
        // Занятость проверяется по слепому индексу: сравнить открытый адрес в
        // базе нельзя, там шифр.
        const { rows: taken } = await client.query(
          `SELECT 1 FROM e_user
            WHERE email_blind_idx = $1 AND id <> $2 AND deleted_at IS NULL LIMIT 1`,
          [blind, userId],
        );
        if (taken.length) {
          await client.query('ROLLBACK');
          return null;
        }

        await client.query(
          `INSERT INTO e_email_change (user_id, email_enc, token_hash, expires_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id) DO UPDATE
             SET email_enc = $2, token_hash = $3, expires_at = $4, created_at = now()`,
          [userId, encryptValue(email, 'email'), token, expiresAt],
        );
        await client.query('COMMIT');
        return { token };
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },

    /** Заявка на смену адреса по хешу токена, вместе с новым адресом. */
    async emailChangeByToken(tokenHash) {
      const { rows } = await pool.query(
        'SELECT id, user_id, email_enc, expires_at FROM e_email_change WHERE token_hash = $1',
        [tokenHash],
      );
      if (!rows.length) return null;
      return {
        id: rows[0].id,
        user_id: rows[0].user_id,
        email: decryptValue(rows[0].email_enc, 'email'),
        expiresAt: rows[0].expires_at,
      };
    },

    /**
     * Применяет смену адреса (F-01-06 §4).
     *
     * Заявка удаляется той же транзакцией: применённая заявка, оставшаяся в
     * таблице, разрешила бы применить адрес повторно тем же токеном.
     */
    async applyEmailChange(changeId, userId, email) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const blind = blindIndex(email);
        await client.query(
          `UPDATE e_user
              SET email_hash = $2, email_blind_idx = $2, email_enc = $3
            WHERE id = $1 AND deleted_at IS NULL`,
          [userId, blind, encryptValue(email, 'email')],
        );
        await client.query('DELETE FROM e_email_change WHERE id = $1', [changeId]);
        await client.query('COMMIT');
        return true;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },

    /**
     * Заявка на смену адреса в заглушке.
     *
     * Повторяет поведение базы, а не её простоту: занятый адрес возвращает
     * null, заявка на пользователя одна, применение удаляет заявку. Иначе
     * тесты HTTP шли бы по структуре, которой в бою нет.
     */
    async recordLogin(userId, at) {
      await pool.query('UPDATE e_user SET last_active_at = $2 WHERE id = $1', [userId, at]);
    },


// ─── Выгрузка данных (F-01-10 §4) ─────────────────────────────────────────

    /**
     * Заказ выгрузки (EC-A21).
     *
     * Пауза в 24 часа проверяется здесь, а не в маршруте: решение «пора или
     * рано» принимает база, и два одновременных запроса не обойдут её чтением
     * из памяти.
     *
     * @param {Date} at текущее время; берётся у вызывающего, как и в
     *   `requestDeletion`, чтобы проверка шла по одним часам
     * @returns {Promise<{ok:true}|{ok:false, retryAt:Date}>}
     */
    async requestExport(userId, locale, at) {
      const { rows } = await pool.query(
        'SELECT max(requested_at) AS at FROM e_export_job WHERE user_id = $1',
        [userId],
      );
      const previous = rows[0]?.at;
      if (previous) {
        const retryAt = new Date(
          new Date(previous).getTime() + AUTH.exportCooldownHours * 3_600_000,
        );
        if (retryAt > at) return { ok: false, retryAt };
      }

      await pool.query('INSERT INTO e_export_job (user_id, locale) VALUES ($1, $2)', [userId, locale]);
      return { ok: true };
    },

    /** Заказы, ждущие сборки (F-01-10 §6). */
    async dueExports() {
      const { rows } = await pool.query(
        `SELECT id, user_id, locale FROM e_export_job
          WHERE status = 'queued' ORDER BY requested_at LIMIT 10`,
      );
      return rows.map((row) => ({ id: row.id, user_id: row.user_id, locale: row.locale }));
    },

    /**
     * Данные пользователя для выгрузки (F-01-10 §4).
     *
     * Собираются здесь, а не в маршруте: состав выгрузки — решение продукта,
     * и оно не должно размазываться по слоям.
     */
    async exportData(userId) {
      const { rows } = await pool.query(
        `SELECT nickname, locale, theme, timezone, email_confirmed, registered_at,
                last_active_at, recs_enabled, profile_public, stats_public,
                quiet_hours, quiet_hours_from, quiet_hours_to
           FROM e_user WHERE id = $1`,
        [userId],
      );
      if (!rows.length) return {};
      const u = rows[0];
      const q = async (sql) => (await pool.query(sql, [userId])).rows;

      return {
        profile: {
          nickname: u.nickname,
          locale: u.locale,
          theme: u.theme,
          timezone: u.timezone,
          emailConfirmed: u.email_confirmed,
          registeredAt: u.registered_at,
          lastActiveAt: u.last_active_at,
          recsEnabled: u.recs_enabled,
          profilePublic: u.profile_public,
          statsPublic: u.stats_public,
          quietHours: u.quiet_hours,
          quietFrom: u.quiet_hours_from,
          quietTo: u.quiet_hours_to,
        },
        watchStatus: await q(
          `SELECT s.title_original AS series, w.status, w.changed_at AS "changedAt"
             FROM e_watch_status w JOIN e_series s ON s.id = w.series_id
            WHERE w.user_id = $1`,
        ),
        watchMarks: await q(
          `SELECT e.number, e.season_id AS "seasonId", m.episode_id AS "episodeId",
                  m.marked_at AS "markedAt", m.precision
             FROM e_watch_mark m JOIN e_episode e ON e.id = m.episode_id
            WHERE m.user_id = $1`,
        ),
        ratings: await q(
          `SELECT object_type AS object, series_id AS "seriesId", episode_id AS "episodeId",
                  value, created_at AS "createdAt"
             FROM e_rating WHERE user_id = $1`,
        ),
        materials: await q(
          `SELECT kind, body, state, created_at AS "createdAt"
             FROM e_material WHERE author_id = $1`,
        ),
        notifications: await q(
          `SELECT kind, category, params, created_at AS "createdAt"
             FROM e_notification WHERE user_id = $1 ORDER BY created_at DESC`,
        ),
        // Идентификатора сессии в выгрузке нет: он секрет, по нему входят.
        devices: await q(
          `SELECT device_label AS label, created_at AS "createdAt",
                  last_seen_at AS "lastSeenAt", revoked_at AS "revokedAt"
             FROM e_session WHERE user_id = $1`,
        ),
      };
    },

    /** Помечает файл готовым и записывает хеш токена ссылки. */
    async markExportReady(jobId, payload, sha256, size, expiresAt, token) {
      await pool.query(
        `UPDATE e_export_job
            SET status = 'ready', payload = $2, sha256 = $3, size_bytes = $4,
                expires_at = $5, ready_at = now(), token_hash = $6
          WHERE id = $1`,
        [jobId, payload, sha256, size, expiresAt, hashToken(token)],
      );
    },

    /** Помечает заказ неудачным: превышен размер или сборка сорвалась. */
    async markExportFailed(jobId, at) {
      await pool.query(
        `UPDATE e_export_job SET status = 'failed', failed_at = $2 WHERE id = $1`,
        [jobId, at],
      );
    },

    /**
     * Файл по токену ссылки.
     *
     * Ссылка из письма приходит без сессии: всё её право — этот токен и срок.
     *
     * @returns {Promise<{payload:string, expiresAt:Date}|null>}
     */
    async exportByToken(token, at) {
      const { rows } = await pool.query(
        `SELECT payload, expires_at FROM e_export_job
          WHERE token_hash = $1 AND status = 'ready'`,
        [hashToken(token)],
      );
      if (!rows.length || !rows[0].expires_at) return null;
      if (new Date(rows[0].expires_at) < at) return null;
      return { payload: rows[0].payload, expiresAt: rows[0].expires_at };
    },

    /** Последний заказ выгрузки — для состояния в разделе «Данные». */
    async lastExport(userId) {
      const { rows } = await pool.query(
        `SELECT status, expires_at, size_bytes FROM e_export_job
          WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 1`,
        [userId],
      );
      return rows[0] ?? null;
    },

    /**
     * Удаление аккаунта (F-01-10 §4).
     *
     * Срок приходит готовой датой, а не числом дней: дата названа человеку в
     * письме, и пересчёт при следующем чтении изменил бы обещанное.
     *
     * Отметка «удалить материалы» запоминается здесь же — через 14 дней её уже
     * не спросишь, а решение человека обязано пережить срок.
     *
     * @param {number} userId
     * @param {{deleteMaterials:boolean, requestedAt:Date, anonymizeAfter:Date}} request
     * @returns {Promise<boolean>} false, если аккаунт уже удаляется или обезличен
     */
    async requestDeletion(userId, request) {
      const { rows } = await pool.query(
        `UPDATE e_user
            SET status = 'deleting',
                delete_requested_at = $2,
                anonymize_after = $3,
                delete_materials = $4
          WHERE id = $1
            AND deleted_at IS NULL
            AND status IN ('active', 'muted')
        RETURNING id`,
        [userId, request.requestedAt, request.anonymizeAfter, Boolean(request.deleteMaterials)],
      );
      return rows.length > 0;
    },

    /**
     * Отмена удаления до истечения срока (EC-A11).
     *
     * Только из состояния «Удаляется»: отменить обезличенное нельзя, а
     * повторный запрос из «Активен» стёр бы дату первого и продлил ожидание
     * без спроса.
     */
    async cancelDeletion(userId) {
      const { rows } = await pool.query(
        `UPDATE e_user
            SET status = 'active',
                delete_requested_at = NULL,
                anonymize_after = NULL,
                delete_materials = FALSE
          WHERE id = $1 AND status = 'deleting' AND deleted_at IS NULL
        RETURNING id`,
        [userId],
      );
      return rows.length > 0;
    },

    /**
     * Кому пора обезличивать по истечении срока (EC-A17).
     *
     * Задача спрашивает, а не ведёт своё расписание: сервер мог быть выключен,
     * и пропущенное догоняется при ближайшем проходе.
     *
     * @returns {Promise<Array<{id:number, delete_materials:boolean}>>}
     */
    async dueDeletions(at) {
      const { rows } = await pool.query(
        `SELECT id, delete_materials FROM e_user
          WHERE status = 'deleting' AND anonymize_after IS NOT NULL AND anonymize_after <= $1
          ORDER BY anonymize_after
          LIMIT 100`,
        [at],
      );
      return rows.map((row) => ({ id: row.id, delete_materials: row.delete_materials }));
    },

    /**
     * Кому пора обезличивать по сроку неподтверждённого (F-01-01 §8(г)).
     *
     * Подтверждённые и уже обезличенные не попадают в список: первый живёт
     * настоящим аккаунтом, второй не имеет ни адреса, ни ника. Порция
     * ограничена так же, как у удалений: обезличивание идёт транзакцией на
     * аккаунт, и тысяча таких за один проход — это тысяча транзакций подряд.
     *
     * @param {Date} cutoff момент, до которого аккаунт считается старым
     * @returns {Promise<number[]>}
     */
    async dueUnverified(cutoff) {
      const { rows } = await pool.query(
        `SELECT id FROM e_user
          WHERE NOT email_confirmed
            AND status <> 'deleted'
            AND deleted_at IS NULL
            AND registered_at <= $1
          ORDER BY registered_at
          LIMIT $2`,
        [cutoff, UNVERIFIED_BATCH],
      );
      return rows.map((row) => row.id);
    },

    /**
     * Обезличивание аккаунта (F-01-10 §4, OP-16).
     *
     * Запись остаётся: на неё ссылаются материалы и оценки, а `R-SQL-02`
     * запрещает `DELETE` из `e_user` вовсе. Обнуляются личные данные и
     * связанные строки; оценки остаются — без них счётчики пересчитывать было
     * бы незачем (§17).
     *
     * Всё одной транзакцией: половина обезличенного аккаунта хуже, чем никакой,
     * и повторный запуск не должен требовать разбирательства, что уже стёрто.
     */
    async anonymizeUser(userId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Решения редакторов ссылаются на материал (ON DELETE RESTRICT), идут
        // первыми — иначе удалить материал не даст.
        await client.query(
          `DELETE FROM e_editor_decision
            WHERE material_id IN (SELECT id FROM e_material WHERE author_id = $1)`,
          [userId],
        );

        const { rows: doomed } = await client.query(
          'SELECT delete_materials FROM e_user WHERE id = $1 FOR UPDATE',
          [userId],
        );
        if (doomed.length && doomed[0].delete_materials) {
          await client.query(
            `DELETE FROM e_material m
              WHERE m.author_id = $1
                AND NOT EXISTS (SELECT 1 FROM e_material r WHERE r.parent_id = m.id)`,
            [userId],
          );
          // Оболочки тем с чужими ответами: тела больше нет, но сама строка
          // нужна, чтобы чужие ответы не остались без темы.
          await client.query(
            `UPDATE e_material SET body = '', state = 'deleted', decided_at = now()
              WHERE author_id = $1`,
            [userId],
          );
        }

        // Личные ряды: то, что принадлежит только человеку.
        for (const table of [
          'e_watch_status', 'e_watch_mark', 'e_subscription',
          'e_notification', 'e_session', 'e_auth_token', 'e_two_factor',
          'e_email_change', 'e_nickname_history',
        ]) {
          // eslint-disable-next-line no-await-in-loop
          await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
        }

        // Сессии express-session лежат в таблице `session`, а идентификатор
        // пользователя лежит внутри JSON — искать надо по нему.
        await client.query(`DELETE FROM session WHERE sess->'user'->>'id' = $1::text`, [userId]);

        // Хеш пароля обнуляется, а не заменяется: пустая строка не проходит
        // argon2 и не совпадает ни с одним настоящим хешем.
        //
        // Язык и тема не обнуляются — колонки `NOT NULL` со списком значений,
        // и обнуление сломало бы схему. Возвращаются стартовые значения:
        // это не «оставлено human'у», а сброшено к умолчанию.
        await client.query(
          `UPDATE e_user
              SET email_hash = NULL, email_blind_idx = NULL, email_enc = NULL,
                  password_hash = '', nickname = 'удалённый-' || id,
                  avatar_image_id = NULL, status = 'deleted',
                  deleted_at = now(), anonymized_at = now(),
                  last_active_at = NULL, timezone = 'UTC',
                  locale = 'ru', theme = 'system',
                  recs_enabled = FALSE, profile_public = FALSE, stats_public = FALSE,
                  quiet_hours = FALSE,
                  delete_requested_at = NULL, anonymize_after = NULL
            WHERE id = $1`,
          [userId],
        );

        await client.query('COMMIT');
        return true;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
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

    /**
     * Выдать служебную роль.
     *
     * Выдать роль — действие администратора, поэтому оно требует и роли
     * `admin` у выдающего, и причины: без причины в журнале не останется
     * ничего, кроме факта, что у кого-то вдруг появился доступ. Истечение
     * срока обязательно для `analyst` и `editor` — иначе временная роль
     * становится вечной молча.
     *
     * @param {object} args
     * @param {number} args.userId кому
     * @param {string} args.role `editor | analyst | admin`
     * @param {number|null} [args.grantedBy] кто выдаёт; без него роль выдаётся
     *   только с командной строки и остаётся в журнале без актора
     * @param {Date|null} [args.expiresAt]
     * @param {string} [args.reason] обязательна: попадёт в журнал аудита
     * @returns {Promise<{ok: boolean, reason?: string}>}
     */
    async assignRole({ userId, role, grantedBy = null, expiresAt = null, reason }) {
      if (!STAFF_ROLES.includes(role)) return { ok: false, reason: 'unknown-role' };
      if (!String(reason ?? '').trim()) return { ok: false, reason: 'no-reason' };
      if (role !== 'admin' && !expiresAt) return { ok: false, reason: 'no-expiry' };

      if (grantedBy) {
        const { rows } = await pool.query(
          `SELECT 1 FROM e_role_assignment
            WHERE user_id = $1 AND role = 'admin'
              AND (expires_at IS NULL OR expires_at > now())`,
          [grantedBy],
        );
        if (!rows.length) return { ok: false, reason: 'not-admin' };
      }

      const { rowCount } = await pool.query(
        `INSERT INTO e_role_assignment (user_id, role, granted_by, expires_at, note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, role) WHERE expires_at IS NULL
         DO UPDATE SET granted_by = EXCLUDED.granted_by, expires_at = EXCLUDED.expires_at,
                       note = EXCLUDED.note, granted_at = now()`,
        [userId, role, grantedBy, expiresAt, String(reason).trim()],
      );
      return { ok: rowCount > 0 };
    },

    /**
     * Снять роль.
     *
     * @param {object} args
     * @param {number} args.userId
     * @param {string} args.role
     * @returns {Promise<{ok: boolean, removed: number}>}
     */
    async revokeRole({ userId, role }) {
      if (!STAFF_ROLES.includes(role)) return { ok: false, removed: 0 };

      const { rowCount } = await pool.query(
        `DELETE FROM e_role_assignment
          WHERE user_id = $1 AND role = $2
            AND (expires_at IS NULL OR expires_at > now())`,
        [userId, role],
      );
      return { ok: true, removed: rowCount };
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
      // Ключи — те, что приходят из формы (`quietHours`), значения — колонки.
      const columns = { quietHours: 'quiet_hours' };
      const sets = [];
      const params = [userId];
      for (const [key, column] of Object.entries(columns)) {
        if (!(key in values)) continue;
        params.push(Boolean(values[key]));
        sets.push(`${column} = $${params.length}`);
      }

      // Границы времени принимаются только в виде `ЧЧ:ММ`. Значение из формы,
      // которое не время, молча превратило бы тихие часы в пустое окно, а
      // человек узнал бы об этом из пропущенного письма.
      for (const [key, column] of [['quietFrom', 'quiet_hours_from'], ['quietTo', 'quiet_hours_to']]) {
        if (!(key in values)) continue;
        const value = String(values[key] ?? '');
        if (!TIME_OF_DAY.test(value)) continue;
        params.push(value);
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
     * Сбросить двухфакторную проверку и отозвать сессии человека.
     *
     * Обе операции — в одной транзакции: сброшенная проверка при живых
     * сессиях обходила бы второй фактор (решение автора, 21.10).
     *
     * @param {number} userId
     * @returns {Promise<{reset: boolean, sessions: number}>}
     */
    async resetTwoFactor(userId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rowCount } = await client.query(
          'DELETE FROM e_two_factor WHERE user_id = $1',
          [userId],
        );
        const sessions = await client.query(
          `DELETE FROM session WHERE (sess -> 'user' ->> 'id')::bigint = $1`,
          [userId],
        );
        await client.query('COMMIT');
        return { reset: (rowCount ?? 0) > 0, sessions: sessions.rowCount ?? 0 };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
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
     * Записывает устройство входа (F-01-03 §4, список S-32).
     *
     * Строка появляется на каждом полноценном входе, поэтому список со временем
     * накапливает старые входы: закрытые убирает человек («Выйти на этом») или
     * лимит `auth.sessions_max`, который снимает и строку, и саму сессию.
     *
     * @param {number} userId
     * @param {{label: string, sidHash: string|null, ipPrefix: string|null}} device
     */
    async noteDevice(userId, device) {
      await pool.query(
        `INSERT INTO e_session (user_id, device_label, sid_hash, ip_prefix)
         VALUES ($1, $2, $3, $4)`,
        [userId, device.label, device.sidHash, device.ipPrefix],
      );
    },

    /**
     * Закрывает сессии сверх лимита: самая старая уходит первой (F-01-03 §5).
     *
     * Сессии лежат в таблице connect-pg-simple, а не в `e_session`, поэтому
     * отбор идёт по владельцу внутри JSON, а порядок — по `expire`: у скользящей
     * сессии это время последней активности, то есть «самая старая» здесь и
     * означает самый давно не открытый вход.
     *
     * Идентификатор текущей сессии исключён: человек только что вошёл, и
     * закрывать ему тот вход, ради которого он вошёл, нельзя.
     *
     * @param {number|string} userId
     * @param {string} keepSid идентификатор текущей сессии
     * @param {number} max сколько сессий аккаунта держим
     * @returns {Promise<number>} сколько сессий закрыто
     */
    async pruneSessions(userId, keepSid, max = AUTH.sessionsMax) {
      const { rowCount } = await pool.query(
        `DELETE FROM session
          WHERE sid IN (
            SELECT sid FROM session
             WHERE (sess -> 'user' ->> 'id') = $1::text AND sid <> $2
             ORDER BY expire DESC
             OFFSET $3)`,
        [userId, keepSid, Math.max(0, max - 1)],
      );
      return rowCount ?? 0;
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
  /** Заявки на смену адреса: пользователь → {token, email}. */
  const emailChanges = new Map();
  /** Материалы: пользователь → строки `e_material`. Посев для тестов. */
  const materials = new Map();
  /** Оценки: пользователь → строки `e_rating`. Посев для тестов. */
  const ratings = new Map();
  /** Выгрузки: пользователь → строки `e_export_job`. */
  const exports = new Map();
  /** Статусы и отметки просмотра: пользователь → строки. Посев для тестов. */
  const watchStatus = new Map();
  const watchMarks = new Map();
  const notifications = new Map();
  let nextExportId = 1;

  const findExport = (jobId) => [...exports.values()].flat().find((job) => job.id === jobId);
  /**
   * Журнал вызовов для утверждений тестов.
   *
   * Собирается здесь, а не в обёртках теста: обёртка проверяла бы, что
   * позвали функцию, а не что отозвали именно то устройство.
   */
  const calls = { revokeSessions: [], revokeDevice: [], noteDevice: [], pruneSessions: [] };

  return {
    async byEmail(email) {
      const key = String(email).toLowerCase();
      return key in users ? users[key] : null;
    },

    /**
     * Аккаунт по идентификатору.
     *
     * Ищется по всем значениям, а не по ключу карты: после обезличивания у
     * записи нет адреса, и по ключу её уже не найти — а запись обязана
     * оставаться.
     */
    async byId(userId) {
      return Object.values(users).find((u) => u.id === userId) ?? null;
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

    // Роли выдаются настоящим хранилищем: заглушка держит список, чтобы тесты
    // маршрутов могли выдать роль и увидеть короткую сессию служебного входа
    // (R-SEC-03), но никто из маршрутов роли не выдаёт.
    async assignRole({ userId, role, expiresAt = null }) {
      roles[userId] = [...new Set([...(roles[userId] ?? []), role])];
      return { ok: true, expiresAt };
    },

    async revokeRole({ userId, role }) {
      const before = roles[userId] ?? [];
      roles[userId] = before.filter((one) => one !== role);
      return { ok: true, removed: before.length - roles[userId].length };
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
        // Дата регистрации: по ней задача решает, что неподтверждённый
        // аккаунт досидел свой срок (F-01-01 §8(г)). В базе это `registered_at`
        // со значением по умолчанию, в заглушке — то же самое.
        registered_at: fields.registeredAt ?? new Date(),
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

    /**
     * Заглушка: сброс проверки вместе с отзывом сессий.
     */
    async resetTwoFactor(userId) {
      const found = Object.values(users).find((u) => u.id === userId);
      const reset = Boolean(found?.twoFactor);
      if (found) delete found.twoFactor;
      calls.revokeSessions.push([userId]);
      return { reset, sessions: 1 };
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
    async devices(userId, currentHash = null) {
      return (devices.get(userId) ?? []).map((row) => ({
        ...row,
        current: row.sid_hash !== null && row.sid_hash === currentHash,
      }));
    },

    /** Запись устройства при входе: в базе — INSERT в `e_session`. */
    async noteDevice(userId, device) {
      calls.noteDevice.push([userId, device]);
      const mine = devices.get(userId) ?? [];
      const at = new Date();
      devices.set(userId, [...mine, {
        id: at.getTime(),
        device_label: device.label,
        sid_hash: device.sidHash,
        ip_prefix: device.ipPrefix,
        created_at: at,
        last_seen_at: at,
      }]);
    },

    /** Подрезка сессий сверх лимита: в базе — DELETE по `expire`. */
    async pruneSessions(userId, keepSid, max = AUTH.sessionsMax) {
      calls.pruneSessions.push([userId, keepSid, max]);
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
      const allowed = ['quietHours', 'quietFrom', 'quietTo'];
      for (const [key, value] of Object.entries(values)) {
        if (allowed.includes(key)) found[key] = value;
      }
    },

    /** Тестовые заглушки для списка устройств и журнала вызовов. */
    setSessions(userId, list) {
      devices.set(userId, list);
    },

    /** Посев материалов для тестов обезличивания (в базе — INSERT). */
    addMaterials(userId, list) {
      materials.set(userId, list);
    },
    /** Посев оценок для тестов обезличивания (в базе — INSERT). */
    addRating(userId, value) {
      ratings.set(userId, [...(ratings.get(userId) ?? []), value]);
    },
    /** Отметка «удалить материалы» (в базе — UPDATE e_user). */
    setDeleteMaterials(userId, flag) {
      const found = Object.values(users).find((u) => u.id === userId);
      if (found) found.delete_materials = flag;
    },
    /** Материалы пользователя после обезличивания. */
    materials(userId) {
      return materials.get(userId) ?? [];
    },
    /** Оценки пользователя после обезличивания. */
    ratings(userId) {
      return ratings.get(userId) ?? [];
    },

    /**
     * Заказ выгрузки (EC-A21).
     *
     * Пауза считается по последней заявке, а не по готовому файлу: два запроса
     * подряд, пока первый собирается, иначе обошли бы паузу.
     */
    async requestExport(userId, locale, at) {
      const mine = exports.get(userId) ?? [];
      const previous = mine[mine.length - 1];
      if (previous) {
        const retryAt = new Date(
          previous.requestedAt.getTime() + AUTH.exportCooldownHours * 3_600_000,
        );
        if (retryAt > at) return { ok: false, retryAt };
      }
      const job = {
        id: nextExportId++, userId, locale, status: 'queued', payload: null, requestedAt: new Date(),
      };
      mine.push(job);
      exports.set(userId, mine);
      return { ok: true };
    },

    /** Заказы, ждущие сборки. */
    async dueExports() {
      return [...exports.values()].flat()
        .filter((job) => job.status === 'queued')
        .map((job) => ({ id: job.id, user_id: job.userId, locale: job.locale }));
    },

    /**
     * Данные для выгрузки (F-01-10 §4).
     *
     * Форма повторяет базу: те же имена полей и те же списки. Заметок
     * модерации в выгрузке нет, и здесь их тоже не берётся — отсеивает сама
     * сборка.
     */
    async exportData(userId) {
      const found = Object.values(users).find((u) => u.id === userId);
      if (!found) return {};
      return {
        profile: {
          nickname: found.nickname,
          locale: found.locale,
          theme: found.theme,
          timezone: found.timezone,
          emailConfirmed: found.email_confirmed,
          registeredAt: found.registered_at ?? null,
          lastActiveAt: found.last_active_at ?? null,
          recsEnabled: found.recs_enabled,
          profilePublic: found.profile_public,
          statsPublic: found.stats_public,
          quietHours: found.quiet_hours,
          quietFrom: found.quietFrom ?? '23:00',
          quietTo: found.quietTo ?? '08:00',
        },
        watchStatus: watchStatus.get(userId) ?? [],
        watchMarks: watchMarks.get(userId) ?? [],
        ratings: ratings.get(userId) ?? [],
        materials: materials.get(userId) ?? [],
        notifications: notifications.get(userId) ?? [],
        devices: (devices.get(userId) ?? []).map(({ label, device_label, created_at, last_seen_at }) => ({
          label: label ?? device_label ?? null, createdAt: created_at, lastSeenAt: last_seen_at,
        })),
      };
    },

    /** Файл готов: payload кладётся рядом, открытый токен — только его хеш. */
    async markExportReady(jobId, payload, sha256, size, expiresAt, token) {
      const job = findExport(jobId);
      if (!job) return;
      Object.assign(job, {
        status: 'ready', payload, sha256, size, expiresAt, tokenHash: hashToken(token),
      });
    },

    async markExportFailed(jobId) {
      const job = findExport(jobId);
      if (job) Object.assign(job, { status: 'failed', failedAt: new Date() });
    },

    /** Ссылка работает до срока и только по своему токену. */
    async exportByToken(token, at) {
      const wanted = hashToken(token).toString('base64url');
      for (const job of [...exports.values()].flat()) {
        if (job.status !== 'ready') continue;
        if (job.tokenHash?.toString('base64url') !== wanted) continue;
        if (!job.expiresAt || new Date(job.expiresAt) < at) return null;
        return { payload: job.payload, expiresAt: job.expiresAt };
      }
      return null;
    },

    /** Последний заказ — для состояния карточки в разделе «Данные». */
    async lastExport(userId) {
      const mine = exports.get(userId) ?? [];
      const job = mine[mine.length - 1];
      return job ? { status: job.status, expires_at: job.expiresAt, size_bytes: job.size } : null;
    },

    /**
     * Удаление аккаунта (F-01-10 §4).
     *
     * Повторяет форму базы: состояние принимается только из «Активен» и
     * «Замьючен», а повторный запрос возвращает false — иначе тесты шли бы по
     * пути, которого в бою нет.
     */
    async requestDeletion(userId, request) {
      const found = Object.values(users).find((u) => u.id === userId);
      if (!found || !['active', 'muted'].includes(found.status)) return false;

      found.status = 'deleting';
      found.delete_requested_at = request.requestedAt;
      found.anonymize_after = request.anonymizeAfter;
      found.delete_materials = Boolean(request.deleteMaterials);
      return true;
    },

    /** Отмена удаления (EC-A11). */
    async cancelDeletion(userId) {
      const found = Object.values(users).find((u) => u.id === userId);
      if (!found || found.status !== 'deleting') return false;

      found.status = 'active';
      found.delete_requested_at = null;
      found.anonymize_after = null;
      found.delete_materials = false;
      return true;
    },

    /** Кому пора обезличивать (EC-A17). */
    async dueDeletions(at) {
      return Object.values(users)
        .filter((u) => u.status === 'deleting' && u.anonymize_after && u.anonymize_after <= at)
        .map((u) => ({ id: u.id, delete_materials: u.delete_materials }));
    },

    /**
     * Кому пора обезличивать по сроку неподтверждённого (F-01-01 §8(г)).
     *
     * Подтверждённые и уже обезличенные не попадают в список: первый живёт
     * настоящим аккаунтом, второй не имеет ни адреса, ни ника.
     *
     * @param {Date} cutoff момент, до которого аккаунт считается старым
     * @returns {Promise<number[]>}
     */
    async dueUnverified(cutoff) {
      return Object.values(users)
        .filter((u) => !u.email_confirmed && u.status !== 'deleted'
          // Аккаунт без даты регистрации (тестовая заглушка) сроком не
          // считается: иначе «нет даты» читалось бы как «зарегистрирован
          // вчера» и такой аккаунт обезличился бы первым же проходом.
          && u.registered_at && new Date(u.registered_at) <= cutoff)
        .slice(0, UNVERIFIED_BATCH)
        .map((u) => u.id);
    },

    /**
     * Обезличивание (F-01-10 §4, OP-16).
     *
     * Форма повторяет базу: запись остаётся под тем же идентификатором, но без
     * адреса, поэтому её больше нет среди ключей карты — иначе следующий
     * запрос по старому адресу что-то нашёл бы.
     */
    async anonymizeUser(userId) {
      const found = Object.values(users).find((u) => u.id === userId);
      if (!found) return false;

      if (found.delete_materials) {
        // Темы с чужими ответами остаются оболочками: тело пустое, но строка
        // нужна, чтобы чужие ответы не остались без темы.
        const keep = [];
        for (const item of materials.get(userId) ?? []) {
          if (item.replies) keep.push({ ...item, body: '', state: 'deleted' });
        }
        materials.set(userId, keep);
      }

      const previousKey = Object.keys(users).find((k) => users[k].id === userId);
      delete users[previousKey];

      Object.assign(found, {
        email: null,
        password_hash: '',
        nickname: `удалённый-${userId}`,
        avatar_image_id: null,
        status: 'deleted',
        deleted_at: new Date(),
        anonymized_at: new Date(),
        last_active_at: null,
        timezone: 'UTC',
        locale: 'ru',
        theme: 'system',
        recs_enabled: false,
        profile_public: false,
        stats_public: false,
        quiet_hours: false,
        quiet_hours: false,
        delete_requested_at: null,
        anonymize_after: null,
      });
      // Запись возвращается в карту под ником: `byId` находит её по значению,
      // а `byEmail` по ключу — уже ничего.
      users[`удалённый-${userId}`] = found;
      return true;
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
    async themeOf(userId) {
      const found = Object.values(users).find((u) => u.id === userId);
      return found?.theme ?? null;
    },

    async updatePreferences(userId, values) {
      const found = Object.values(users).find((u) => u.id === userId);
      if (!found) return;
      const allowed = ['theme', 'locale', 'timezone', 'stats_public', 'profile_public', 'recs_enabled'];
      for (const [key, value] of Object.entries(values)) {
        if (allowed.includes(key)) found[key] = value;
      }
    },

    /**
     * Заявка на смену адреса в заглушке.
     *
     * Повторяет поведение базы, а не её простоту: занятый адрес возвращает
     * null, заявка на пользователя одна, применение удаляет заявку. Иначе
     * тесты HTTP шли бы по структуре, которой в бою нет.
     */
    async requestEmailChange(userId, email, token) {
      const found = Object.values(users).find((u) => u.id === userId);
      if (!found) return null;
      const blind = blindIndex(email);
      if (Object.values(users).some((u) => u.id !== userId && blindIndex(u.email).equals(blind))) {
        return null;
      }

      emailChanges.set(userId, { token, email });
      return { token };
    },

    async emailChangeByToken(tokenHash) {
      for (const [userId, change] of emailChanges) {
        if (change.token.toString('base64url') !== tokenHash.toString('base64url')) continue;
        return { user_id: userId, email: change.email, expiresAt: Date.now() + 3_600_000 };
      }
      return null;
    },

    async applyEmailChange(changeId, userId, email) {
      const found = Object.values(users).find((u) => u.id === userId);
      if (!found) return false;

      // Ключ карты — адрес, он же индекс поиска: смена адреса меняет и ключ,
      // иначе следующий запрос по старому адресу что-то нашёл бы.
      const previousKey = Object.keys(users).find((k) => users[k].id === userId);
      delete users[previousKey];
      found.email = email;
      users[email.toLowerCase()] = found;
      emailChanges.delete(userId);
      return true;
    },

    /** Доступ к внутренностям для утверждений в тестах. */
    _tokens: tokens,
    /** Журнал вызовов: отзывов сессий и устройств. */
    calls,
  };
}
