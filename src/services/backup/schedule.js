// Ночная резервная копия по расписанию (F-09-04 §3, `backup.schedule`).
//
// Три решения, из-за которых модуль такой, какой есть:
//
//  1. Время копии локальное, а не UTC. В настройке написано «03:30», и человек
//     ожидает 03:30 у себя; сдвиг на зону отступает от обещания.
//  2. Задача спрашивает базу, а не помнит своё расписание: сервер мог быть
//     выключен в назначенный час. Пропущенный день догоняется — но копия за
//     него всё равно создаётся, потому что пропущенная копия хуже поздней.
//  3. Копия снимается той же функцией, что и при заморозке каталога, и пишется
//     в тот же журнал. Своя копия «по расписанию» без записи в `e_backup_job`
//     была бы страховкой, о которой никто не знает, — ровно та ошибка, из-за
//     которой журнал и появился.

import { createSnapshotBackup } from './snapshot.js';

/** `backup.schedule` (M9 §0): ежедневно 03:30 локального времени. */
export const DEFAULT_SCHEDULE = '03:30';

/** Как часто задата смотрит часы. Числа в M9 §0 нет — взят шаг обезличивания. */
export const TICK_MS = 15 * 60_000;

/**
 * Разбирает `backup.schedule` в час и минуту.
 *
 * Мусор в настройке не должен останавливать копирование: лучше копия в
 * неожиданное время, чем её отсутствие, поэтому битое значение заменяется
 * значением из модуля, а исключение не бросается.
 *
 * @param {string|null|undefined} value
 * @returns {{hour: number, minute: number}}
 */
export function parseSchedule(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(text);
  if (match && Number(match[1]) <= 23) {
    return { hour: Number(match[1]), minute: Number(match[2]) };
  }
  return parseSchedule(DEFAULT_SCHEDULE);
}

/** Читает расписание из настроек в базе. */
export async function readSchedule(pool) {
  const { rows } = await pool.query(
    "SELECT value FROM e_system_setting WHERE key = 'backup.schedule'",
  );
  return parseSchedule(rows[0]?.value);
}

/** Час и минута локального времени. */
function minutesOf(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Задача ночной копии.
 *
 * @param {object} deps
 * @param {import('pg').Pool|null} deps.pool для чтения расписания и журнала
 * @param {object} deps.backups журнал копий (`pgBackupJobs`)
 * @param {Function} [deps.snapshot] снятие копии; по умолчанию `createSnapshotBackup`
 * @param {() => Date} [deps.now] часы, для тестов
 * @param {Function} [deps.lastBackupAt] когда была последняя копия; по умолчанию
 *   читается из журнала
 * @param {(line: string) => void} [deps.log]
 */
export function createBackupTask({
  pool,
  backups,
  snapshot = createSnapshotBackup,
  now = () => new Date(),
  lastBackupAt = null,
  log = () => {},
}) {
  /** Когда копия была в последний раз; из журнала, если он есть. */
  const lastCopy = lastBackupAt ?? (async () => {
    const [row] = await backups.recent({ limit: 1 });
    if (!row) return null;
    return new Date(row.started_at ?? row.finished_at);
  });

  /**
   * Пора ли снимать копию.
   *
   * Два условия: назначенный час прошёл и копии за сегодня ещё не было.
   * Порядок важен — при незакрытой двери в полночь задача создала бы копию до
   * расписания, и человек получил бы две копии за сутки вместо одной.
   *
   * @returns {Promise<boolean>}
   */
  async function due() {
    const schedule = pool ? await readSchedule(pool) : parseSchedule(DEFAULT_SCHEDULE);
    const at = now();
    if (minutesOf(at) < schedule.hour * 60 + schedule.minute) return false;

    const previous = await lastCopy();
    if (!previous) return true;
    return !(previous.getFullYear() === at.getFullYear()
      && previous.getMonth() === at.getMonth()
      && previous.getDate() === at.getDate()
      && minutesOf(previous) >= schedule.hour * 60 + schedule.minute);
  }

  /**
   * Один проход: копия, запись в журнал, ротация.
   *
   * Вызывается по таймеру, но «пора ли» решает вызывающий: иначе задача сама
   * решит, что пора, и таймер останется единственной точкой, где это видно.
   *
   * @returns {Promise<{status: string, bytes: number, file?: string}>}
   */
  async function run() {
    const result = await snapshot({ pool });
    await backups.record({
      status: result.status,
      sizeBytes: result.bytes,
      filePath: result.file ?? null,
    });
    await backups.prune({ keepLast: await backups.keepLast() });
    log(`[копия] ${result.status}${result.file ? `, файл ${result.file}` : ''}`);
    return result;
  }

  return { due, run };
}