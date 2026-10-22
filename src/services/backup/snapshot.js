// Снимок для защиты: копия с проверкой восстановления (F-12-10 §3, OP-17).
//
// Почему это отдельный сервис, а не пара функций в команде: «заморозка без
// копии» — самая опасная поломка этого режима, и она невозможна, только если
// копию создаёт тот же код, который проверяет её результат. Когда создание
// копии живёт в команде, а проверка — в заглушке теста, тест зелёный, а
// защита проходит без страховки.
//
// Проверка настоящая: копия разворачивается во временную базу и число строк
// сверяется с рабочей. Снимок, который записался, но не восстановился, копией
// не считается (OP-17) — иначе «проверено» означало бы «процесс не упал».

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * Копия с проверкой восстановления.
 *
 * Внешние эффекты внедряются: без этого модуль нечем покрыть тестом, а
 * настоящий `pg_dump` базы на 450 МБ не должен выполняться на каждом прогоне.
 *
 * @param {object} deps
 * @param {any} deps.pool живое подключение — только чтобы пересчитать строки
 * @param {(file:string, args:string[], options?:object) => Promise<{stdout:string}>} [deps.exec]
 * @param {() => string|Promise<string>} [deps.tmpDir] временный каталог; тест подменяет
 * @param {() => string|Promise<string>} [deps.keepDir] каталог для годного дампа; по умолчанию `backups/`
 * @param {boolean} [deps.keepFile] `false` — только проверка, дамп удаляется
 * @returns {Promise<{status:'verified'|'error', bytes:number, file?:string, error?:string}>}
 */
export async function createSnapshotBackup({
  pool,
  exec = promisify(execFile),
  tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'defence-')),
  keepDir = () => path.resolve('backups'),
  keepFile = true,
}) {
  const db = process.env.PGDATABASE ?? 'serial_tracker';
  const user = process.env.PGUSER ?? '';
  const host = process.env.PGHOST ?? '';
  const env = { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? '' };

  let dir = null;
  try {
    dir = await tmpDir();
    const dumpFile = path.join(dir, 'snapshot.dump');
    await exec('pg_dump', ['-h', host, '-U', user, '-d', db, '-Fc', '-f', dumpFile], { env });
    const dump = await fs.stat(dumpFile);

    // Восстановление идёт в отдельную базу: проверка в рабочей ничего не
    // доказывала бы — она бы просто переписала то же самое, откуда снято.
    const temp = `defence_check_${process.pid}_${Date.now()}`;
    await exec('createdb', ['-h', host, '-U', user, temp], { env });
    try {
      await exec('pg_restore', ['-h', host, '-U', user, '-d', temp, dumpFile], { env });
      const expected = await countSeries(pool);
      const restored = await exec('psql', ['-h', host, '-U', user, '-d', temp, '-tAc',
        'SELECT count(*) FROM e_series'], { env });
      const actual = Number(String(restored.stdout).trim());
      if (Number.isNaN(actual)) {
        return { status: 'error', bytes: dump.size, error: 'восстановленная база не ответила' };
      }
      if (expected > 0 && actual !== expected) {
        return { status: 'error', bytes: dump.size, error: `в копии ${actual} сериалов против ${expected}` };
      }
      return { status: 'verified', bytes: dump.size, file: keepFile ? await keepDump(dumpFile, await keepDir()) : undefined };
    } finally {
      // Временная база удаляется всегда: полгигабайта в pg_tablespace,
      // оставленные после каждой заморозки, кончатся диском на второй раз.
      await exec('dropdb', ['-h', host, '-U', user, '--if-exists', temp], { env }).catch(() => {});
    }
  } catch (error) {
    return { status: 'error', bytes: 0, error: String(error?.message ?? error) };
  } finally {
    // Временная папка удаляется всегда, а сам дамп к этому моменту либо
    // переехал в каталог копий, либо не проверен и удаляется вместе с папкой:
    // негодная копия в каталоге копий была бы враньём, а в мусоре — пустым
    // местом на диске.
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Перенести проверенный дамп в каталог копий.
 *
 * Имя — по времени: два запуска в одну минуту не должны затирать друг друга,
 * и по дате видно, сколько копий уже накопилось.
 *
 * @param {string} dumpFile
 * @param {string} keepDir
 * @returns {Promise<string>} путь к копии
 */
async function keepDump(dumpFile, keepDir) {
  await fs.mkdir(keepDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(keepDir, `serial_tracker-${stamp}.dump`);
  // Копирование, а не переименование: временный каталог системный (`/tmp`), а
  // каталог копий — внутри проекта, и на части систем это разные файловые
  // системы. `rename` между ними падает с EXDEV, то есть копия просто не
  // сохранилась бы — а заморозка об этом сообщила бы как об ошибке копии.
  await fs.copyFile(dumpFile, target);
  await fs.rm(dumpFile, { force: true });
  return target;
}

/**
 * Сколько сериалов в живой базе: с этим числом сверяется восстановленная.
 *
 * @param {any} pool
 * @returns {Promise<number>}
 */
async function countSeries(pool) {
  if (!pool) return 0;
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM e_series');
  return rows[0].n;
}
