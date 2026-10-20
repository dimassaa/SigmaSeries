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
 * @returns {object}
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

  return { submissionsInMinute, cautiousState, refresh, queuePressure };
}

/** Сбросить состояние режима: им пользуются проверки и перезапуск. */
export function resetCautiousMode() {
  cautiousMode = false;
}
