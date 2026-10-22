// Бюджеты модерации: сколько один автор может подать за минуту, когда
// система переходит в «осторожный» режим и как очередь растёт (F-05-03,
// R-MOD-10).
//
// Три величины, которые должен видеть и автор, и редактор:
//
//   · лимит частоты — автор подал шестой материал за минуту: отказ;
//   · «осторожный» режим — помеченных среди поданных больше доли
//     `mod.auto_block_share`: новые материалы ждут решения редактора,
//     автоматической публикации нет;
//   · давление очереди — самый старый материал ждёт дольше
//     `mod.queue_target_min` минут: очередь растёт быстрее, чем её разбирают.

import { MODERATION } from '../settings.js';

/** Окно, за которое считается доля помеченных. */
const SHARE_WINDOW_H = MODERATION.clusterWindowH;

/**
 * Правило «осторожного» режима: помеченных больше доли — режим включён.
 *
 * Вынесено отдельно от запроса: доля считается по всей базе, и проверять
 * её на живых данных бессмысленно — в общей базе рядом лежат материалы
 * чужих проверок. Правило проверяется числами, а запрос — тем, что он
 * приносит числа.
 *
 * @param {{flagged: number, total: number, threshold?: number}} input
 * @returns {{cautious: boolean, share: number, threshold: number}}
 */
export function cautiousFrom({ flagged, total, threshold = MODERATION.autoBlockShare }) {
  const share = total > 0 ? flagged / total : 0;
  return { cautious: share > threshold, share, threshold };
}

/**
 * Бюджет помеченных попыток (R-MOD-08).
 *
 * Пять помеченных материалов за час — автоматический мьют на час; повтор —
 * на сутки. Числа взяты из правила, а не придуманы: порог и сроки заданы
 * стандартом.
 */
export const FLAGGED_BUDGET = {
  limit: 5,
  firstHours: 1,
  repeatHours: 24,
};

/**
 * Что делать с автором, у которого помеченных попыток больше бюджета.
 *
 * Правило вынесено отдельно от запроса: считать надо на живых данных, а
 * решать — по числам, и проверка решения не должна зависеть от наполнения
 * общей базы.
 *
 * `hits` — сколько раз бюджет уже превышен: каждый превышенный бюджет — это
 * ещё пять помеченных материалов. Первый превышенный бюджет даёт мьют на
 * час, повтор — на сутки, третий — сутки и флаг администратору (R-MOD-08).
 *
 * @param {{flaggedInHour: number, hits?: number}} input
 * @returns {{mute: boolean, hours: number|null, reason: string|null, hits: number, notify: boolean}}
 */
export function flaggedBudgetFrom({ flaggedInHour, hits = 1 }) {
  if (flaggedInHour < FLAGGED_BUDGET.limit) {
    return { mute: false, hours: null, reason: null, hits: 0, notify: false };
  }
  const repeat = hits >= 2;
  return {
    mute: true,
    hours: repeat ? FLAGGED_BUDGET.repeatHours : FLAGGED_BUDGET.firstHours,
    reason: repeat
      ? 'превышен бюджет помеченных материалов, повтор'
      : 'превышен бюджет помеченных материалов',
    hits,
    notify: hits >= 3,
  };
}

/**
 * Потолок очереди ожидающих (R-MOD-11).
 *
 * Две тысячи — число из правила, а не оценка: очередь такой величины
 * редактор уже не разбирает.
 */
export const QUEUE_CEILING = 2000;

/**
 * Что делать с новым помеченным материалом при переполнении очереди.
 *
 * «Низкое доверие» — история модерации автора: система уже помечала его
 * материалы. Решение автора от 21.10: доверяем тому, кого система ещё не
 * ловила, а переполнение касается именно тех, кого ловила.
 *
 * @param {{waiting: number, lowTrust: boolean, ceiling?: number}} input
 * @returns {{full: boolean, lowTrust: boolean, refuse: boolean}}
 */
export function queueOverflowFrom({ waiting, lowTrust, ceiling = QUEUE_CEILING }) {
  const full = waiting >= ceiling;
  return { full, lowTrust, refuse: full && lowTrust };
}

/**
 * Состояние «осторожного» режима сервиса.
 *
 * Живёт в процессе, а не в базе: решение о режиме принимает система, и оно
 * должно одинаково видеть и отправка материала, и редактор, и администратор —
 * все они в одном процессе (ADR-004). В базе такая запись была бы видна ещё
 * и проверкам, которые идут по общей базе параллельно: включённый режим
 * переключил бы чужие проверки на «материал ждёт решения».
 */
let cautiousMode = false;

/**
 * Источник данных бюджетов модерации.
 *
 * @param {import('pg').Pool} pool
 * @returns {any}
 */
export function pgModerationBudget(pool) {
  /**
   * Сколько материалов автор подал за последнюю минуту.
   *
   * @param {number} userId
   * @param {Date} [at]
   * @returns {Promise<number>}
   */
  async function submissionsInMinute(userId, at = new Date()) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM e_material
        WHERE author_id = $1 AND submitted_at > $2`,
      [userId, new Date(at.getTime() - 60_000)],
    );
    return Number(rows[0].n);
  }

  /**
   * Текущее состояние «осторожного» режима.
   *
   * Режим — состояние, а не результат подсчёта на лету: доля помеченных
   * считается по всей базе, и подсчёт при каждой отправке означал бы, что
   * решение о режиме принимает сама отправка. Состояние считает работник и
   * кладёт в настройки системы, а отправка его читает.
   *
   * @returns {Promise<{cautious: boolean}>}
   */
  async function cautiousState() {
    return { cautious: cautiousMode };
  }

  /**
   * Пересчитать «осторожный» режим и давление очереди.
   *
   * @param {{windowHours?: number, at?: Date}} [input]
   * @returns {Promise<{cautious: boolean, share: number, threshold: number,
   *   flagged: number, total: number, waiting: number, oldestMinutes: number,
   *   growing: boolean}>}
   */
  async function refresh({ windowHours = SHARE_WINDOW_H, at = new Date() } = {}) {
    const { rows } = await pool.query(
      `SELECT count(*) FILTER (WHERE state IN ('flagged', 'checking'))::int AS flagged,
              count(*)::int AS total
         FROM e_material
        WHERE submitted_at > $1`,
      [new Date(at.getTime() - windowHours * 3600_000)],
    );
    const flagged = Number(rows[0].flagged);
    const total = Number(rows[0].total);
    const { cautious, share, threshold } = cautiousFrom({ flagged, total });

    const pressure = await queuePressure({ at });
    cautiousMode = cautious;

    return {
      cautious,
      share,
      threshold,
      flagged,
      total,
      ...pressure,
    };
  }

  /**
   * Давление очереди: сколько ждёт и сколько минут ждёт самый старый.
   *
   * @param {{at?: Date}} [input]
   * @returns {Promise<{waiting: number, oldestMinutes: number, growing: boolean}>}
   */
  async function queuePressure({ at = new Date() } = {}) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS waiting,
              coalesce(extract(epoch FROM ($1::timestamptz - min(submitted_at))) / 60, 0)::float AS oldest
         FROM e_material
        WHERE state IN ('flagged', 'checking')`,
      [at],
    );
    const oldestMinutes = Math.round(Number(rows[0].oldest) * 10) / 10;
    return {
      waiting: Number(rows[0].waiting),
      oldestMinutes,
      growing: oldestMinutes >= MODERATION.queueTargetMin,
    };
  }

  /**
   * Бюджет помеченных попыток автора (R-MOD-08).
   *
   * Считаются материалы в состоянии ожидания решения: именно они «помечены».
   * Прежний автомьют виден по тому, что у него нет автора: мьют редактора
   * всегда чей-то, а автоматический — ничей.
   *
   * @param {number} userId
   * @param {Date} [at]
   * @returns {Promise<{flaggedInHour: number, mute: boolean, hours: number|null, reason: string|null}>}
   */
  async function flaggedBudget(userId, at = new Date()) {
    const { rows } = await pool.query(
      `SELECT count(*) FILTER (WHERE submitted_at > $2)::int AS hour,
              count(*)::int AS day
         FROM e_material
        WHERE author_id = $1 AND state IN ('flagged', 'checking')`,
      [userId, new Date(at.getTime() - 3600_000)],
    );
    const flaggedInHour = Number(rows[0].hour);
    // Превышений было столько, сколько раз набрался бюджет: пять помеченных
    // материалов — одно превышение.
    const hits = Math.floor(Number(rows[0].day) / FLAGGED_BUDGET.limit);
    const decision = flaggedBudgetFrom({ flaggedInHour, hits: Math.max(hits, 1) });
    return { flaggedInHour, ...decision };
  }

  /**
   * Переполнение очереди и «низкое доверие» автора (R-MOD-11).
   *
   * Низкое доверие — помеченные материалы автора: их наличие и есть история
   * модерации. Считается до текущей подачи: проверка идёт до записи.
   *
   * @param {number} userId
   * @param {Date} [at]
   * @returns {Promise<{waiting: number, full: boolean, lowTrust: boolean, refuse: boolean}>}
   */
  async function queueOverflow(userId, at = new Date()) {
    const { rows: pressure } = await pool.query(
      `SELECT count(*)::int AS n FROM e_material
        WHERE state IN ('flagged', 'checking')`,
    );
    const { rows: history } = await pool.query(
      `SELECT count(*)::int AS n FROM e_material
        WHERE author_id = $1 AND state = 'flagged'`,
      [userId],
    );
    const waiting = Number(pressure[0].n);
    const lowTrust = Number(history[0].n) > 0;
    return { waiting, ...queueOverflowFrom({ waiting, lowTrust }) };
  }

  return {
    submissionsInMinute, cautiousState, refresh, queuePressure, flaggedBudget, queueOverflow,
  };
}

/** Сбросить состояние режима: им пользуются проверки и перезапуск. */
export function resetCautiousMode() {
  cautiousMode = false;
}
