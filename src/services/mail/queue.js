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

import { encryptValue, decryptValue } from '../auth/crypto.js';
import { mailText } from '../../i18n/mails.js';
import { MAIL_SETTINGS } from '../../config/settings.js';

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
        `INSERT INTO e_mail (kind, recipient_enc, locale, subject, body)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          job.kind,
          encryptValue(job.to, 'mail'),
          locale,
          text.subject,
          text.body,
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
                -- Пауза растёт: долбить провайдер, который и так не отвечает,
                -- нельзя (F-01-12 §5 — 1, 2, 4, 8, 16 минут).
                next_attempt_at = now() + (LEAST($3::int, 5) * interval '1 minute')
          WHERE id = $1`,
        [id, exhausted ? 'failed' : 'queued', tries, String(error).slice(0, 300)],
      );
    },
  };
}