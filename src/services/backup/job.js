// OP-17 — резервная копия с проверкой восстановления.
// Спецификация: docs/01-product/features/M9-admin.md F-09-04.
//
// Почему проверка обязательна и почему она не «запись в лог»:
// DUMP, завершившийся без ошибки, доказывает лишь, что процесс не упал.
// Он не доказывает, что файл читается и база из него поднимается. Единственный
// способ узнать — восстановить во временную базу и проверить. Поэтому копия
// получает состояние «проверена» только после реального восстановления.
//
// Побочное следствие, которое стоит дороже всего остального: ротация
// никогда не удаляет непроверенную копию. Если удалять, то после серии
// неудачных проверок не останется ни одной годной.

/** @typedef {'running'|'created'|'verified'|'error'} BackupStatus */

export const SIZES = {
  /** Меньше — копия считается ошибкой, а не копией. **[ГИПОТЕЗА]** */
  minRatio: 0.1,
  /** Сколько последних проверенных копий держим (RETENTION §1). */
  keep: 7,
};

/**
 * Создаёт копию и проверяет её восстановлением.
 *
 * Внешние эффекты внедряются, а не импортируются: без этого модуль нельзя
 * покрыть тестом, а тест с настоящим pg_dump занимает минуты и требует
 * дискового пространства на каждом прогоне.
 *
 * @param {object} deps
 * @param {string} [deps.id]
 * @param {() => Promise<{bytes:number, checksum:string}>} deps.dump создать дамп
 * @param {(backupId:string) => Promise<boolean>} deps.restore развернуть во временную базу
 * @param {() => Promise<{dbBytes:number}>} deps.dbSize размер базы для проверки минимума
 * @param {(job:object) => Promise<void>} deps.onEvent уведомить администратора
 * @returns {Promise<{id:string, status:BackupStatus, bytes:number, checksum:string, error:string|null}>}
 */
export async function createVerifiedBackup({ dump, restore, dbSize, onEvent, id }) {
  const jobId = id ?? `job_${Date.now()}`;
  /** @type {{id: string, status: BackupStatus, bytes: number, checksum: string, error: string|null}} */
  const job = { id: jobId, status: 'running', bytes: 0, checksum: '', error: null };

  let made;
  try {
    made = await dump();
  } catch (e) {
    // Дамп не создался — предыдущие копии не трогаем. Это отдельный случай,
    // а не «копия с ошибкой»: файла нет, ротировать нечего.
    await onEvent({ type: 'backup.dump_failed', id: jobId, error: String(e?.message ?? e) });
    return { ...job, status: 'error', error: `dump: ${e?.message ?? e}` };
  }

  job.bytes = made.bytes;
  job.checksum = made.checksum;
  job.status = 'created';

  // Копия неожиданно мала — верный признак, что дамп получился пустым или
  // обрезанным. Проверять её бессмысленно: восстановится нечто неполное.
  const { dbBytes } = await dbSize();
  if (dbBytes > 0 && made.bytes < dbBytes * SIZES.minRatio) {
    job.status = 'error';
    job.error = `size ${made.bytes} < ${Math.round(dbBytes * SIZES.minRatio)}`;
    await onEvent({ type: 'backup.too_small', id: jobId, bytes: made.bytes });
    return job;
  }

  let restored = false;
  try {
    restored = await restore(jobId);
  } catch (e) {
    job.error = `restore: ${e?.message ?? e}`;
  }

  if (!restored) {
    job.status = 'error';
    job.error ??= 'restore returned false';
    await onEvent({ type: 'backup.restore_failed', id: jobId });
    return job;
  }

  job.status = 'verified';
  await onEvent({ type: 'backup.verified', id: jobId, bytes: made.bytes });
  return job;
}

/**
 * Какие копии можно удалить.
 *
 * @param {{id:string, status:string}[]} jobs существующие копии, свежие первыми
 * @param {number} [keep]
 * @returns {string[]} идентификаторы к удалению
 */
export function rotatable(jobs, keep = SIZES.keep) {
  const verified = jobs.filter((j) => j.status === 'verified');
  return verified.slice(keep).map((j) => j.id);
}

/**
 * Копия считается устаревшей, если её давно не проверяли.
 *
 * Отдельное состояние, а не «ошибка»: файл может быть в порядке, мы просто
 * не знаем. На экране это должно читаться как «нет данных», а не как ноль.
 *
 * @param {{status:BackupStatus, verifiedAt?:number}} job
 * @param {number} now
 * @param {number} [maxAgeHours]
 */
export function isStale(job, now, maxAgeHours = 24) {
  if (job.status !== 'verified') return job.status === 'error';
  if (!job.verifiedAt) return true;
  return now - job.verifiedAt > maxAgeHours * 3600 * 1000;
}

/**
 * Нужно ли догонять пропущенную копию.
 *
 * Планировщик живёт в процессе (ADR-004) и не переживает перезапуск. Если
 * приложение выключили в момент расписания, копия создаётся при следующем
 * старте — иначе в архиве будет дыра размером с простой.
 *
 * @param {{finishedAt?:number, status:BackupStatus}|null} last
 * @param {number} now
 * @param {number} [maxGapHours]
 */
export function shouldCatchUp(last, now, maxGapHours = 36) {
  if (!last || !last.finishedAt) return true;
  if (last.status === 'error') return true;
  return now - last.finishedAt > maxGapHours * 3600 * 1000;
}