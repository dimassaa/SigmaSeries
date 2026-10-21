// Приём событий (M8, F-08-01).
//
// Событие приходит пачкой и проверяется по правилам: имя из закрытого
// списка, размер, частота и одноразовый токен сессии. Невалидное
// отбрасывается целиком и считается — молча отброшенное событие не чинится
// (F-08-01 §4).
//
// Отбрасывается, а не очищается: очищенное событие вводит в заблуждение при
// анализе — выглядит как будто человек поставил оценку, а свойство просто
// потерялось (EC-N1).

import crypto from 'node:crypto';

import pg from 'pg';

import { ANALYTICS } from '../../config/settings.js';
import { isKnownEvent, propsAllowed } from './taxonomy.js';

/** Похоже на адрес: такие значения в событиях не допускаются (R-AN-04). */
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Похоже на телефон: то же самое, адрес в событие попасть не должен. */
const PHONE_LIKE = /^[+\d][\d\s()+-]{7,}$/;

/**
 * Псевдоним человека.
 *
 * Настоящего идентификатора в аналитике быть не может (R-AN-17): аналитик
 * видит устойчивый псевдоним, который склеивает события одного человека.
 * HMAC с отдельным назначением: из псевдонима обратный адрес не получить.
 *
 * @param {number|string|null} userId
 * @returns {string|null}
 */
export function userPseudoId(userId) {
  if (!userId) return null;
  const secret = process.env.BLIND_INDEX_SECRET;
  if (!secret) return null;
  return crypto.createHmac('sha256', secret)
    .update(`pseudo:${userId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * Приём и хранение событий.
 *
 * @param {pg.Pool} pool
 */
export function pgAnalytics(pool) {
  /** Окно частоты: адрес источника → время первого события в окне. */
  const rate = new Map();

  /**
   * Отмечает отказ: имя события, причина и день.
   *
   * @param {string} name
   * @param {string} reason
   * @returns {Promise<void>}
   */
  async function countReject(name, reason) {
    await pool.query(
      `INSERT INTO e_event_reject (name, reason, day, count)
       VALUES ($1, $2, current_date, 1)
       ON CONFLICT (name, reason, day) DO UPDATE SET count = e_event_reject.count + 1`,
      [String(name ?? '').slice(0, 64), String(reason ?? '').slice(0, 32)],
    );
  }

  /**
   * Проверка частоты: не больше `ingest_rate_per_min` событий в минуту с
   * одного источника (F-08-01 §9).
   *
   * @param {string} source
   * @returns {boolean} можно ли принять
   */
  function withinRate(source) {
    const key = String(source ?? 'unknown');
    const now = Date.now();
    const window = rate.get(key);
    if (!window || now - window.since > 60_000) {
      rate.set(key, { since: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= ANALYTICS.ingestRatePerMin;
  }

  return {
    /**
     * Одноразовый токен приёма: без него нельзя подделать пачку событий
     * (R-AN-12).
     *
     * @returns {string}
     */
    issueToken() {
      return crypto.randomBytes(16).toString('base64url');
    },

    /**
     * Принимает пачку событий.
     *
     * @param {object} args
     * @param {object[]} args.events события клиента
     * @param {string|null} args.token присланный токен
     * @param {string|null} args.expectedToken токен, выданный сервером
     * @param {object} args.context общие свойства (R-AN-02)
     * @returns {Promise<{accepted: number, rejected: number, reasons: object}>}
     */
    async intake({ events = [], token = null, expectedToken = null, context = {} }) {
      const reasons = {};
      const note = (name, reason) => {
        reasons[reason] = (reasons[reason] ?? 0) + 1;
        return countReject(name, reason);
      };

      if (!token || !expectedToken || token !== expectedToken) {
        await note('batch', 'token');
        return { accepted: 0, rejected: events.length || 1, reasons: { token: events.length || 1 } };
      }

      const list = Array.isArray(events) ? events : [];
      if (list.length > ANALYTICS.ingestRatePerMin) {
        await note('batch', 'too_many');
        return { accepted: 0, rejected: list.length, reasons: { too_many: list.length } };
      }

      const accepted = [];
      for (const event of list) {
        const name = String(event?.name ?? '');
        if (!isKnownEvent(name)) {
          await note(name || 'unknown', 'unknown_name');
          continue;
        }
        const props = event?.props && typeof event.props === 'object' ? event.props : {};
        const keys = Object.keys(props);
        if (!propsAllowed(name, keys)) {
          await note(name, 'props');
          continue;
        }
        const size = Buffer.byteLength(JSON.stringify(event), 'utf8');
        if (size > ANALYTICS.eventMaxBytes) {
          await note(name, 'size');
          continue;
        }
        const pii = keys.some((key) => {
          const value = props[key];
          if (typeof value !== 'string') return false;
          return EMAIL_LIKE.test(value) || PHONE_LIKE.test(value);
        });
        if (pii) {
          await note(name, 'pii');
          continue;
        }
        if (!withinRate(context.source ?? 'unknown')) {
          await note(name, 'rate');
          continue;
        }
        accepted.push({ name, props, eventId: event.event_id ?? null, tsClient: event.ts_client ?? null });
      }

      if (accepted.length) {
        const values = [];
        const params = [];
        for (const event of accepted) {
          const base = params.length;
          values.push(
            `($${base + 1}::uuid, $${base + 2}, $${base + 3}::timestamptz, $${base + 4}, $${base + 5}, $${base + 6}::jsonb)`,
          );
          params.push(
            event.eventId ?? crypto.randomUUID(),
            event.name,
            event.tsClient ?? null,
            context.anonId ?? null,
            context.userPseudoId ?? null,
            // Общие свойства (R-AN-02) добавляет сервер: клиент их не
            // присылает, и подделать их нельзя.
            JSON.stringify({
              ...event.props,
              locale: context.locale ?? null,
              theme: context.theme ?? null,
              device_class: context.deviceClass ?? null,
              session_id: context.sessionId ?? null,
              // Тип страницы есть и у события, и в общих свойствах: своё
              // значение события не затирается путём.
              page_type: context.pageType ?? event.props.page_type ?? null,
            }),
          );
        }
        await pool.query(
          `INSERT INTO e_event (event_id, name, ts_client, anon_id, user_pseudo_id, props)
           VALUES ${values.join(', ')}
           ON CONFLICT (event_id) DO NOTHING`,
          params,
        );
      }

      const rejected = list.length - accepted.length;
      return { accepted: accepted.length, rejected, reasons };
    },

    /**
     * Счётчики отказов за день: по ним видна доля отбракованных.
     *
     * @param {{days?: number}} [options]
     * @returns {Promise<object[]>}
     */
    async rejects({ days = 7 } = {}) {
      const { rows } = await pool.query(
        `SELECT name, reason, day, count
           FROM e_event_reject
          WHERE day > current_date - $1::int
          ORDER BY day DESC, count DESC`,
        [days],
      );
      return rows.map((row) => ({
        name: row.name,
        reason: row.reason,
        day: row.day,
        count: Number(row.count),
      }));
    },
  };
}
