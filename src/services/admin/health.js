// Ряд «онлайн» и здоровье системы (F-09-05, F-09-06).
//
// «Онлайн» — это активность за последние 15 минут, а не открытые сессии:
// сессия живёт месяц, и считать её было бы враньём. Раз в час система
// записывает, сколько было зарегистрированных и сколько гостей, и держит
// 96 точек на четверо суток.
//
// Пропущенный час — разрыв, а не ноль: ноль означал бы «никого не было», а
// на деле приложение в этот час просто лежало (F-09-05 §5).

import fs from 'node:fs/promises';

import { ADMIN } from '../settings.js';
import { activityCount } from '../activity.js';

/** Сколько часов хранится ряд. */
const KEEP_HOURS = 96;

/**
 * Пороги здоровья. В таблице настроек этих чисел нет — это находка, а не
 * повод придумать их молча. Значения взяты из PERFORMANCE.md: TTFB/p95
 * страниц до 300 мс, дальше — предупреждение; >1000 мс — проблема. Остальные
 * числа помечены в IMPROVEMENTS.md как гипотезы.
 */
export const HEALTH_THRESHOLDS = {
  responseWarningMs: 300,
  responseProblemMs: 1000,
  diskWarningPercent: 20,
  diskProblemPercent: 10,
  eventLoopWarningMs: 50,
  eventLoopProblemMs: 200,
  backupWarningHours: 24,
  backupProblemHours: 48,
};

/**
 * Источник данных «онлайна» и здоровья системы.
 *
 * @param {import('pg').Pool} pool
 * @param {object} [deps]
 * @param {any} [deps.metrics] сборщик запросов (F-09-06)
 * @param {any} [deps.tasks] реестр задач по расписанию
 * @param {any} [deps.budget] бюджеты модерации (F-05-03)
 * @param {any} [deps.backups] журнал резервных копий (F-09-04)
 * @param {string} [deps.diskPath] какой диск показывать
 * @param {() => Date} [deps.now] часы, для тестов
 * @returns {any}
 */
export function pgSystemHealth(pool, {
  metrics = null,
  tasks = null,
  budget = null,
  backups = null,
  diskPath = process.cwd(),
  now = () => new Date(),
} = {}) {
  /**
   * Записать текущее число людей в сети.
   *
   * @param {Date} [at] момент замера
   * @returns {Promise<{hour: Date, registered: number, guests: number}>}
   */
  async function sample(at = now()) {
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
    const snapshot = metrics?.snapshot?.() ?? null;
    return {
      databaseBytes: Number(db.size),
      failedBackups: Number(failed.n),
      queueWaiting: Number(queue.waiting),
      // Сборщик живёт в памяти процесса. После перезапуска снимок пуст, и
      // это «нет данных», а не ноль (EC-B13).
      errorsPerHour: snapshot ? snapshot.errors.count : null,
      responseP95: snapshot ? snapshot.response.p95 : null,
    };
  }

  /**
   * Свободное место на диске, где работает приложение.
   *
   * @returns {Promise<{totalBytes: number|null, freeBytes: number|null,
   *   freePercent: number|null}>}
   */
  async function diskSpace() {
    try {
      const stat = await fs.statfs(diskPath);
      const blockSize = Number(stat.bsize);
      const totalBytes = Number(stat.blocks) * blockSize;
      const freeBytes = Number(stat.bavail) * blockSize;
      return {
        totalBytes,
        freeBytes,
        freePercent: totalBytes > 0
          ? Math.round((freeBytes / totalBytes) * 1000) / 10
          : null,
      };
    } catch {
      return { totalBytes: null, freeBytes: null, freePercent: null };
    }
  }

  /**
   * Последняя копия и возраст последней проверенной.
   *
   * @returns {Promise<{last: any|null, verifiedAgeHours: number|null,
   *   unavailable?: boolean}>}
   */
  async function backupState() {
    if (!backups) return { last: null, verifiedAgeHours: null, unavailable: true };
    const rows = await backups.recent({ limit: 20 });
    const last = rows[0] ?? null;
    const verified = rows.find((row) => row.status === 'verified' && row.verified_at) ?? null;
    const age = verified?.verified_at
      ? Math.max(0, (now().getTime() - new Date(verified.verified_at).getTime()) / 3_600_000)
      : null;
    return { last, verifiedAgeHours: age };
  }

  /**
   * Очередь модерации и её режим. Состояние режима читается, а не
   * пересчитывается: экран наблюдает и не должен менять решение работника.
   *
   * @returns {Promise<any>}
   */
  async function moderationState() {
    if (!budget) return { available: false };
    const [state, pressure] = await Promise.all([
      budget.cautiousState(),
      budget.queuePressure({ at: now() }),
    ]);
    return { available: true, cautious: Boolean(state.cautious), ...pressure };
  }

  /**
   * Снимок для S-82. Каждая часть читается отдельно: недоступная метрика не
   * должна ронять весь экран — она становится «нет данных».
   *
   * @returns {Promise<any>}
   */
  async function screen() {
    const fallbackOnline = {
      points: [], now: 0, average: 0, dataPoints: 0, peak: 0, guestsNow: 0,
    };
    const [online, core, moderation, disk, backup] = await Promise.all([
      series().catch(() => fallbackOnline),
      health().catch(() => null),
      moderationState().catch(() => ({ available: false })),
      diskSpace(),
      backupState().catch(() => ({ last: null, verifiedAgeHours: null, unavailable: true })),
    ]);

    const snapshot = metrics?.snapshot?.() ?? null;
    const data = {
      // Для здоровья важен факт замера, а не его значение: ряд из настоящих
      // нулей — это «никого не было», а не «сбора нет».
      online: { ...online, dataPoints: online.points.length },
      errors: snapshot?.errors ?? { count: null, series: [] },
      response: snapshot?.response ?? { p95: null, routes: [], series: [] },
      eventLoop: snapshot?.eventLoop ?? { delayMs: null },
      moderation,
      tasks: tasks?.snapshot?.() ?? { items: [], failed: 0, unknown: 0 },
      disk,
      backup,
      health: core,
    };
    return { ...data, metrics: classifyHealth(data) };
  }

  return { sample, series, health, screen };
}

/** Порядок важности: сначала сломанное, потом то, что может сломаться. */
const SEVERITY_ORDER = { problem: 0, warning: 1, unknown: 2, ok: 3 };

/**
 * Разложить сырые метрики в строки экрана.
 *
 * Функция чистая: её проверяют числами, а не живой базой. Это важно для
 * EC-B13 — «нет данных» должно остаться отдельным состоянием, а не стать
 * нулём по дороге.
 *
 * @param {any} data
 * @returns {any[]}
 */
export function classifyHealth(data = {}) {
  const rows = [];

  const moderation = data.moderation ?? {};
  if (moderation.available === false) {
    rows.push({
      key: 'moderation', severity: 'unknown', state: 'noData',
      textKey: 'admin.health.text.moderation.noData', value: null, unit: 'count',
      link: '/mod',
    });
  } else if (moderation.growing || moderation.cautious) {
    const growing = Boolean(moderation.growing);
    rows.push({
      key: 'moderation',
      severity: 'problem',
      state: growing ? 'growing' : 'cautious',
      textKey: growing
        ? 'admin.health.text.moderation.growing'
        : 'admin.health.text.moderation.cautious',
      textParams: growing
        ? { minutes: moderation.oldestMinutes ?? 0 }
        : { waiting: moderation.waiting ?? 0 },
      value: moderation.waiting ?? 0,
      unit: 'count',
      link: '/mod',
    });
  } else {
    rows.push({
      key: 'moderation',
      severity: 'ok',
      state: 'ok',
      textKey: 'admin.health.text.moderation.ok',
      value: moderation.waiting ?? 0,
      unit: 'count',
      link: '/mod',
    });
  }

  const backup = data.backup ?? {};
  if (backup.unavailable) {
    rows.push({
      key: 'backup', severity: 'unknown', state: 'noData',
      textKey: 'admin.health.text.backup.noData', value: null, unit: 'text',
      link: '/admin/backups',
    });
  } else if (!backup.last) {
    rows.push({
      key: 'backup', severity: 'problem', state: 'missing',
      textKey: 'admin.health.text.backup.missing', value: null, unit: 'text',
      link: '/admin/backups',
    });
  } else if (backup.last.status === 'error') {
    rows.push({
      key: 'backup', severity: 'problem', state: 'error',
      textKey: 'admin.health.text.backup.error', value: null, unit: 'text',
      link: '/admin/backups',
    });
  } else if (backup.verifiedAgeHours === null || backup.verifiedAgeHours === undefined) {
    rows.push({
      key: 'backup', severity: 'warning', state: 'unverified',
      textKey: 'admin.health.text.backup.unverified', value: null, unit: 'text',
      link: '/admin/backups',
    });
  } else if (backup.verifiedAgeHours > HEALTH_THRESHOLDS.backupProblemHours) {
    rows.push({
      key: 'backup', severity: 'problem', state: 'stale',
      textKey: 'admin.health.text.backup.stale',
      textParams: { days: Math.floor(backup.verifiedAgeHours / 24) },
      value: Math.round(backup.verifiedAgeHours), unit: 'hours',
      link: '/admin/backups',
    });
  } else if (backup.verifiedAgeHours > HEALTH_THRESHOLDS.backupWarningHours) {
    rows.push({
      key: 'backup', severity: 'warning', state: 'due',
      textKey: 'admin.health.text.backup.due',
      textParams: { hours: Math.round(backup.verifiedAgeHours) },
      value: Math.round(backup.verifiedAgeHours), unit: 'hours',
      link: '/admin/backups',
    });
  } else {
    rows.push({
      key: 'backup', severity: 'ok', state: 'ok',
      textKey: 'admin.health.text.backup.ok', value: null, unit: 'text',
      link: '/admin/backups',
    });
  }

  const errors = data.errors ?? {};
  if (errors.count === null || errors.count === undefined) {
    rows.push({
      key: 'errors', severity: 'unknown', state: 'noData',
      textKey: 'admin.health.text.errors.noData', value: null, unit: 'count',
      link: '/admin',
    });
  } else if (errors.count > 0) {
    rows.push({
      key: 'errors', severity: 'problem', state: 'problem',
      textKey: 'admin.health.text.errors.problem',
      textParams: { count: errors.count }, value: errors.count, unit: 'count',
      link: '/admin',
    });
  } else {
    rows.push({
      key: 'errors', severity: 'ok', state: 'ok',
      textKey: 'admin.health.text.errors.ok', value: 0, unit: 'count',
      link: '/admin',
    });
  }

  const response = data.response ?? {};
  if (response.p95 === null || response.p95 === undefined) {
    rows.push({
      key: 'response', severity: 'unknown', state: 'noData',
      textKey: 'admin.health.text.response.noData', value: null, unit: 'ms',
      link: '/admin',
    });
  } else if (response.p95 > HEALTH_THRESHOLDS.responseProblemMs) {
    rows.push({
      key: 'response', severity: 'problem', state: 'slow',
      textKey: 'admin.health.text.response.slow',
      textParams: { ms: response.p95 }, value: response.p95, unit: 'ms',
      link: '/admin',
    });
  } else if (response.p95 > HEALTH_THRESHOLDS.responseWarningMs) {
    rows.push({
      key: 'response', severity: 'warning', state: 'warning',
      textKey: 'admin.health.text.response.warning',
      textParams: { ms: response.p95 }, value: response.p95, unit: 'ms',
      link: '/admin',
    });
  } else {
    rows.push({
      key: 'response', severity: 'ok', state: 'ok',
      textKey: 'admin.health.text.response.ok',
      textParams: { ms: response.p95 }, value: response.p95, unit: 'ms',
      link: '/admin',
    });
  }

  const tasks = data.tasks ?? {};
  const taskItems = tasks.items ?? [];
  if (!taskItems.length) {
    rows.push({
      key: 'tasks', severity: 'unknown', state: 'noData',
      textKey: 'admin.health.text.tasks.noData', value: null, unit: 'text',
      link: '/admin/health#h-health-tasks',
    });
  } else if ((tasks.failed ?? 0) > 0) {
    rows.push({
      key: 'tasks', severity: 'problem', state: 'failed',
      textKey: 'admin.health.text.tasks.failed',
      textParams: { count: tasks.failed }, value: tasks.failed, unit: 'count',
      link: '/admin/health#h-health-tasks',
    });
  } else if ((tasks.unknown ?? 0) > 0) {
    // «Ещё не запускалась» — нормальное состояние до первого такта, а не
    // повод красить весь экран. Ошибка задачи остаётся проблемой выше.
    rows.push({
      key: 'tasks', severity: 'ok', state: 'unknown',
      textKey: 'admin.health.text.tasks.unknown',
      textParams: { count: tasks.unknown }, value: tasks.unknown, unit: 'count',
      link: '/admin/health#h-health-tasks',
    });
  } else {
    rows.push({
      key: 'tasks', severity: 'ok', state: 'ok',
      textKey: 'admin.health.text.tasks.ok',
      value: taskItems.length, unit: 'count',
      link: '/admin/health#h-health-tasks',
    });
  }

  const disk = data.disk ?? {};
  if (disk.freePercent === null || disk.freePercent === undefined) {
    rows.push({
      key: 'disk', severity: 'unknown', state: 'noData',
      textKey: 'admin.health.text.disk.noData', value: null, unit: 'percent',
      link: null,
    });
  } else if (disk.freePercent < HEALTH_THRESHOLDS.diskProblemPercent) {
    rows.push({
      key: 'disk', severity: 'problem', state: 'low',
      textKey: 'admin.health.text.disk.low', value: disk.freePercent, unit: 'percent',
      link: null,
    });
  } else if (disk.freePercent < HEALTH_THRESHOLDS.diskWarningPercent) {
    rows.push({
      key: 'disk', severity: 'warning', state: 'tight',
      textKey: 'admin.health.text.disk.tight', value: disk.freePercent, unit: 'percent',
      link: null,
    });
  } else {
    rows.push({
      key: 'disk', severity: 'ok', state: 'ok',
      textKey: 'admin.health.text.disk.ok', value: disk.freePercent, unit: 'percent',
      link: null,
    });
  }

  const loop = data.eventLoop ?? {};
  if (loop.delayMs === null || loop.delayMs === undefined) {
    rows.push({
      key: 'eventLoop', severity: 'unknown', state: 'noData',
      textKey: 'admin.health.text.eventLoop.noData', value: null, unit: 'ms',
      link: null,
    });
  } else if (loop.delayMs > HEALTH_THRESHOLDS.eventLoopProblemMs) {
    rows.push({
      key: 'eventLoop', severity: 'problem', state: 'lagging',
      textKey: 'admin.health.text.eventLoop.lagging', value: loop.delayMs, unit: 'ms',
      link: null,
    });
  } else if (loop.delayMs > HEALTH_THRESHOLDS.eventLoopWarningMs) {
    rows.push({
      key: 'eventLoop', severity: 'warning', state: 'warning',
      textKey: 'admin.health.text.eventLoop.warning', value: loop.delayMs, unit: 'ms',
      link: null,
    });
  } else {
    rows.push({
      key: 'eventLoop', severity: 'ok', state: 'ok',
      textKey: 'admin.health.text.eventLoop.ok', value: loop.delayMs, unit: 'ms',
      link: null,
    });
  }

  const online = data.online ?? {};
  if (!online.dataPoints) {
    rows.push({
      key: 'online', severity: 'unknown', state: 'noData',
      textKey: 'admin.health.text.online.noData', value: null, unit: 'count',
      link: '/admin',
    });
  } else {
    rows.push({
      key: 'online', severity: 'ok', state: 'ok',
      textKey: 'admin.health.text.online.ok',
      textParams: { average: online.average ?? 0, peak: online.peak ?? 0 },
      value: online.now ?? 0, unit: 'count', link: '/admin',
    });
  }

  return rows.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
}
