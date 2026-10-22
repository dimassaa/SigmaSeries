// Ряд «онлайн» и здоровье системы (F-09-05, F-09-06).
//
// «Онлайн» — это активность за последние 15 минут, а не открытые сессии:
// сессия живёт месяц, и считать её было бы враньём. Раз в час система
// записывает, сколько было зарегистрированных и сколько гостей, и держит
// 96 точек на четверо суток.
//
// Пропущенный час — разрыв, а не ноль: ноль означал бы «никого не было», а
// на деле приложение в этот час просто лежало (F-09-05 §5).

import { ADMIN } from '../settings.js';
import { activityCount } from '../activity.js';

/** Сколько часов хранится ряд. */
const KEEP_HOURS = 96;

/**
 * Источник данных «онлайна» и здоровья системы.
 *
 * @param {import('pg').Pool} pool
 * @returns {any}
 */
export function pgSystemHealth(pool) {
  /**
   * Записать текущее число людей в сети.
   *
   * @param {Date} [at] момент замера
   * @returns {Promise<{hour: Date, registered: number, guests: number}>}
   */
  async function sample(at = new Date()) {
    const hour = new Date(at);
    hour.setMinutes(0, 0, 0);

    // Отметки активности живут в памяти процесса: сырые следы не хранятся
    // (F-09-05 §7), а в базу пишется число раз в час.
    const { registered, guests: guestCount } = activityCount(ADMIN.onlineWindowMin);
    await pool.query(
      `INSERT INTO e_online_sample (hour, registered, guests) VALUES ($1, $2, $3)
         ON CONFLICT (hour) DO UPDATE SET registered = EXCLUDED.registered, guests = EXCLUDED.guests`,
      [hour, registered, guestCount],
    );
    return { hour, registered, guests: guestCount };
  }

  /**
   * Ряд: точки за последние дни и среднее.
   *
   * @returns {Promise<{points: any[], now: number, average: number,
   *   dataPoints: number, peak: number, guestsNow: number}>}
   */
  async function series() {
    const { rows } = await pool.query(
      `SELECT hour, registered, guests FROM e_online_sample
        WHERE hour > now() - ($1 || ' hours')::interval
        ORDER BY hour ASC`,
      [String(KEEP_HOURS)],
    );
    const points = rows.map((row) => ({
      hour: row.hour,
      registered: Number(row.registered),
      guests: Number(row.guests),
    }));
    const last = points[points.length - 1] ?? null;
    const withData = points.filter((point) => point.registered > 0 || point.guests > 0);
    const average = withData.length
      ? Math.round((withData.reduce((sum, point) => sum + point.registered, 0) / withData.length) * 10) / 10
      : 0;
    return {
      points,
      now: last ? last.registered : 0,
      guestsNow: last ? last.guests : 0,
      average,
      dataPoints: withData.length,
      peak: points.reduce((max, point) => Math.max(max, point.registered), 0),
    };
  }

  /**
   * Здоровье системы: что видно без счётчиков.
   *
   * Метрики, которых нет (5xx за час, отклик p95), показываются как «нет
   * данных», а не ноль: ноль был бы ложью (F-09-06 §4).
   *
   * @returns {Promise<any>}
   */
  async function health() {
    const { rows: [db] } = await pool.query(
      'SELECT pg_database_size(current_database())::bigint AS size',
    );
    const { rows: [failed] } = await pool.query(
      "SELECT count(*)::int AS n FROM e_backup_job WHERE status = 'error'",
    );
    const { rows: [queue] } = await pool.query(
      `SELECT count(*)::int AS waiting FROM e_material WHERE state IN ('flagged', 'checking')`,
    );
    return {
      databaseBytes: Number(db.size),
      failedBackups: Number(failed.n),
      queueWaiting: Number(queue.waiting),
      // Счётчиков ошибок и отклика в проекте нет: честнее «нет данных».
      errorsPerHour: null,
      responseP95: null,
    };
  }

  return { sample, series, health };
}
