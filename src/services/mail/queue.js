// Очередь служебных писем.
//
// Письмо ставится в очередь из обработчика запроса, а отправляется
// отдельно. Причина не в красоте архитектуры, а в двух требованиях сразу:
//
//   • F-01-04 §8: время ответа на заявку не должно зависеть от того, что
//     нашлось по адресу. Пока отправка идёт в обработчике, подтверждённый
//     аккаунт отвечает дольше несуществующего — по времени адреса и
//     перебираются (R-SEC-06);
//   • F-01-12 §5: провайдер недоступен — письмо остаётся в очереди и
//     повторяется, а не теряется вместе с запросом.
//
// Работник запускается по таймеру (см. `server.js`) и забирает неотправленные
// письма, время которых наступило.

import crypto from 'node:crypto';

import { encryptValue, decryptValue } from '../auth/crypto.js';
import { mailText } from '../../i18n/mails.js';
import { linkFromBody } from './devbox.js';
import { MAIL_SETTINGS } from '../../config/settings.js';

/**
 * Хеш отметки браузера (H-51).
 *
 * В базе лежит хеш, а не сама отметка: cookie подписана и живёт час, а база
 * живёт дольше, и по её значению письма искались бы сторонним запросом.
 */
const browserMark = (value) => crypto
  .createHash('sha256')
  .update(String(value), 'utf8')
  .digest();

/** Сколько писем забирает работник за раз. */
const BATCH = 10;

/**
 * На сколько минут письмо считается занятым после взятия в обработку.
 *
 * Больше рабочего интервала (`MAIL_SETTINGS.tickMs`) и больше времени отправки
 * обычного письма. Если процесс упал, письмо вернётся в очередь через этот
 * срок — медленно, но без вечной потери.
 */
const LEASE_MIN = 5;

/**
 * Очередь писем.
 *
 * @param {object} deps
 * @param {object} deps.pool подключение к базе
 * @param {(job: {to:string, subject:string, body:string, kind:string}) => Promise<void>} deps.deliver
 *   отправка одного письма; бросок означает «попытка не удалась»
 * @param {number} [deps.maxQueued] предел длины очереди (F-01-12 §9)
 * @returns {{enqueue: Function, processDue: Function}}
 */
export function createMailQueue({ pool, deliver, maxQueued = MAIL_SETTINGS.maxQueued }) {
  return {
    /**
     * Ставит письмо в очередь.
     *
     * Ошибка отправки сюда не доходит: письмо ещё не отправлялось. Здесь
     * падает только то, что письмо нельзя поставить — переполнение очереди,
     * неизвестный вид или язык (см. `i18n/mails.js`).
     *
     * @param {{kind:string, to:string, locale?:string, token?:string, link?:string}} job
     * @returns {Promise<number>} идентификатор письма в очереди
     */
    async enqueue(job) {
      const locale = job.locale ?? 'ru';
      const text = mailText(job.kind, locale, { link: job.link ?? '' });

      // Предел размера (F-01-12 §9). Считается тело и тема вместе: письмо
      // уходит именно в таком виде, и большой получатель упирается в лимит
      // провайдера, а не в наш.
      const sizeKb = (Buffer.byteLength(text.subject, 'utf8')
        + Buffer.byteLength(text.body, 'utf8')) / 1024;
      if (sizeKb > MAIL_SETTINGS.maxSizeKb) {
        throw new Error(
          `Письмо «${job.kind}» велико: ${sizeKb.toFixed(1)} КБ из ${MAIL_SETTINGS.maxSizeKb}`,
        );
      }

      // Предел длины очереди проверяется до вставки и по числу неотправленных:
      // он защищает базу от переполнения, когда провайдер лежит (F-01-12 §9).
      const { rows } = await pool.query(
        `SELECT count(*)::int AS pending
           FROM e_mail WHERE status IN ('queued','sending')`,
      );
      if (rows[0].pending >= maxQueued) {
        throw new Error(
          `Очередь писем переполнена (${rows[0].pending} из ${maxQueued}): новое письмо не поставлено`,
        );
      }

      const { rows: inserted } = await pool.query(
        `INSERT INTO e_mail (kind, recipient_enc, locale, subject, body, browser_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          job.kind,
          encryptValue(job.to, 'mail'),
          locale,
          text.subject,
          text.body,
          // Отметка браузера — хеш, а не сама cookie (H-51).
          job.browserId ? browserMark(job.browserId) : null,
        ],
      );
      return inserted[0].id;
    },

    /**
     * Отправляет письма, время которых наступило.
     *
     * Ошибка отправки не бросается наружу: она уже записана в письмо, и
     * бросок здесь остановил бы весь работник целиком из-за одного адреса.
     *
     * @param {{now?: Date, limit?: number}} [at]
     * @returns {Promise<number>} сколько писем отправлено (попытки тоже считаются)
     */
    async processDue({ now = new Date(), limit = BATCH } = {}) {
      const { rows: due } = await pool.query(
        `SELECT id, kind, recipient_enc, locale, subject, body, attempts
           FROM e_mail
          WHERE status IN ('queued','sending')
            AND next_attempt_at <= $1
          ORDER BY next_attempt_at
          LIMIT $2`,
        [now, limit],
      );

      let processed = 0;
      for (const row of due) {
        processed += 1;
        // Письмо не просто помечается занятым, а арендуется: время следующей
        // попытки сдвигается вперёд. Без этого два работника (или два прохода
        // по очереди, если отправка идёт дольше интервала) взяли бы одно
        // письмо и человек получил бы его дважды. Упавший посреди отправки
        // процесс оставит письмо занятым, и через срок аренды оно вернётся
        // в очередь само.
        await pool.query(
          `UPDATE e_mail
              SET status = 'sending',
                  next_attempt_at = now() + ($2 || ' minutes')::interval
            WHERE id = $1`,
          [row.id, String(LEASE_MIN)],
        );

        try {
          await deliver({
            to: decryptValue(row.recipient_enc, 'mail'),
            subject: row.subject,
            body: row.body,
            kind: row.kind,
          });
          await pool.query(
            `UPDATE e_mail SET status = 'sent', sent_at = now(), attempts = attempts + 1,
                               last_error = NULL
              WHERE id = $1`,
            [row.id],
          );
        } catch (e) {
          await this.fail(row.id, row.attempts + 1, e.message);
        }
      }
      return processed;
    },

    /**
     * Удаляет письма старше срока хранения (F-01-12 §8(в)).
     *
     * Токены подтверждения лежат внутри тела письма, и «удалить через семь
     * дней» — это требование о жизни токенов, а не только о базе.
     *
     * @returns {Promise<number>} сколько удалено
     */
    async purge({ now = new Date() } = {}) {
      const { rowCount } = await pool.query(
        `DELETE FROM e_mail
          WHERE created_at < now() - ($1 || ' days')::interval
            AND status <> 'queued'`,
        [String(MAIL_SETTINGS.keepDays)],
      );
      return rowCount ?? 0;
    },

    /**
     * Письма этого браузера для демо-помощника (H-51).
     *
     * @returns {Promise<Array<{id:number, kind:string, body:string, createdAt:string}>>}
     */
    async forBrowser(browserId, { limit = 5 } = {}) {
      if (!browserId) return [];
      const { rows } = await pool.query(
        `SELECT id, kind, body, created_at FROM e_mail
          WHERE browser_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [browserMark(browserId), limit],
      );
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        body: row.body,
        browserId,
        createdAt: row.created_at,
      }));
    },

    /**
     * Письма для почтового ящика админа (S-84).
     *
     * Получатель расшифровывается уже здесь: в списке он не нужен открытым,
     * и держать его открытым в разметке незачем.
     *
     * @returns {Promise<Array<object>>}
     */
    async listing({ limit = 50 } = {}) {
      const { rows } = await pool.query(
        `SELECT id, kind, locale, subject, body, status, attempts, created_at, sent_at
           FROM e_mail ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return rows.map((row) => ({ ...row, link: linkFromBody(row.body) }));
    },

    /**
     * Записывает неудачную попытку: пока tries < MAX_ATTEMPTS, письмо ждёт
     * следующей попытки, иначе помечается неудачным (F-01-12 §5).
     */
    async fail(id, attempts, error) {
      const exhausted = attempts >= MAIL_SETTINGS.maxAttempts;
      // $3 идёт и в attempts, и в арифметику интервала: без явной приведения
      // PostgreSQL выводит для него два разных типа и отказывается выполнять
      // запрос. Приводится здесь, один раз, а не в каждом месте.
      const tries = Number(attempts);
      await pool.query(
        `UPDATE e_mail
            SET status = $2,
                attempts = $3::int,
                last_error = $4,
                -- Пауза растёт вдвое: 1, 2, 4, 8, 16 минут (F-01-12 §5).
                -- Долбить провайдер, который и так не отвечает, нельзя, а
                -- потолок нужен, чтобы седьмая попытка не уехала на сутки.
                next_attempt_at = now()
                  + (LEAST(2 ^ LEAST($3::int - 1, 4), 16) * interval '1 minute')
          WHERE id = $1`,
        [id, exhausted ? 'failed' : 'queued', tries, String(error).slice(0, 300)],
      );
    },
  };
}