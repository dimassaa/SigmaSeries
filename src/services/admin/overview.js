// Системный обзор администратора (F-09-05, F-09-06, S-70).
//
// Одно место, откуда видно, что сейчас происходит: сколько людей онлайн,
// что в очередях, что с аномалиями оценок и как идут копии. Этот экран —
// тот самый, на который администратор посмотрит, когда что-то пошло не так.

import { ADMIN } from '../../config/settings.js';

/**
 * Источник данных обзора.
 *
 * @param {import('pg').Pool} pool
 * @param {object} deps
 * @param {object} [deps.backups] журнал резервных копий
 * @returns {object}
 */
export function pgAdminOverview(pool, { backups = null } = {}) {
  /**
   * Люди онлайн: сейчас (окно в минутах) и в среднем (окно в часах).
   *
   * @returns {Promise<{now: number, average: number, windowMin: number, avgHours: number}>}
   */
  async function online() {
    const { rows: [row] } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM e_user
           WHERE status = 'active' AND deleted_at IS NULL
             AND last_active_at > now() - ($1 || ' minutes')::interval) AS now_count,
         (SELECT count(*)::int FROM e_user
           WHERE status = 'active' AND deleted_at IS NULL
             AND last_active_at > now() - ($2 || ' hours')::interval) AS day_count`,
      [String(ADMIN.onlineWindowMin), String(ADMIN.onlineAvgHours)],
    );
    const day = Number(row.day_count);
    return {
      now: Number(row.now_count),
      average: Math.round((day / ADMIN.onlineAvgHours) * 10) / 10,
      windowMin: ADMIN.onlineWindowMin,
      avgHours: ADMIN.onlineAvgHours,
    };
  }

  /**
   * Очереди модерации: сколько ждёт и сколько старых.
   *
   * @returns {Promise<{waiting: number, oldestMinutes: number, growing: boolean}>}
   */
  async function queues() {
    const { rows: [row] } = await pool.query(
      `SELECT count(*)::int AS waiting,
              coalesce(extract(epoch FROM (now() - min(submitted_at))) / 60, 0)::float AS oldest
         FROM e_material
        WHERE state IN ('flagged', 'checking')`,
    );
    const oldestMinutes = Math.round(Number(row.oldest) * 10) / 10;
    return {
      waiting: Number(row.waiting),
      oldestMinutes,
      growing: oldestMinutes >= ADMIN.queueTargetMin,
    };
  }

  /**
   * Открытые аномалии оценок: их администратор и разбирает (F-04-08).
   *
   * @returns {Promise<object[]>}
   */
  async function anomalies() {
    const { rows } = await pool.query(
      `SELECT a.id, a.created_at, a.signal, a.frozen, s.title_ru, s.slug
         FROM e_rating_anomaly a
         JOIN e_series s ON s.id = a.series_id
        WHERE a.state = 'open'
        ORDER BY a.created_at ASC
        LIMIT 20`,
    );
    return rows.map((row) => ({
      id: Number(row.id),
      createdAt: row.created_at,
      seriesTitle: row.title_ru,
      seriesSlug: row.slug,
      signal: row.signal ?? {},
      frozen: row.frozen ?? {},
    }));
  }

  /**
   * Последние резервные копии.
   *
   * @returns {Promise<object[]>}
   */
  async function backupsList() {
    if (!backups) return [];
    const rows = await backups.recent({ limit: 5 });
    return rows.map((row) => ({
      id: Number(row.id),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status,
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      verifiedAt: row.verified_at,
    }));
  }

  /**
   * Всё сразу: один экран — один сбор.
   *
   * @returns {Promise<object>}
   */
  async function overview() {
    const [people, queue, anomaliesList, copies] = await Promise.all([
      online(),
      queues(),
      anomalies(),
      backupsList(),
    ]);
    return { online: people, queues: queue, anomalies: anomaliesList, backups: copies };
  }

  return { online, queues, anomalies, backupsList, overview };
}
