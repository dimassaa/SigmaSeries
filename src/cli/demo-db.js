// Демонстрационная база: копия без мусора от прогонов тестов.
//
//   npm run demo:db                      # взять последнюю копию из backups/
//   npm run demo:db -- --dump backups/x.dump --db serial_tracker_demo
//   npm run demo:db -- --force           # пересоздать, если база уже есть
//
// Зачем это. Рабочая база — общая для разработки и прогонов: к защиче в ней
// накапливаются тысячи тестовых аккаунтов и сериалов, и «в системе 8921
// пользователя» — это мусор, а не показатель. Решения, почему не чистить
// рабочую базу на месте: проверки идут параллельно, удаление оборвёт чужой
// прогон, а правило «это тестовые строки» пришлось бы поддерживать вручную.
// Копия снимает вопрос: в ней ничего не жалко.
//
// Что внутри: каталог как есть, а аккаунты — ровно два, зритель и
// администратор, с паролями, которые печатаются один раз. Данные зрителя
// заполняются вручную через интерфейс: выдуманные закладки и отметки выглядели
// бы правдоподобнее настоящих, но были бы выдуманными.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

import { createPool } from '../db/pool.js';
import { createSnapshotBackup } from '../services/backup/snapshot.js';
import { pgBackupJobs } from '../services/backup/store.js';
import { pgAuthStore } from '../services/auth/store.js';
import { hashPassword } from '../services/auth/password.js';

const exec = promisify(execFile);

/** Пароль, который невозможно подобрать и невозможно забыть увидеть: печатается один раз. */
const makePassword = () => crypto.randomBytes(12).toString('base64url');

const valueOf = (args, flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
};

/** Последняя копия в `backups/`, если она есть. */
async function newestDump(dir = 'backups') {
  const names = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.dump'));
  if (!names.length) return null;
  names.sort();
  return path.resolve(dir, names[names.length - 1]);
}

async function main() {
  const args = process.argv.slice(2);
  if (!process.env.PGHOST && !process.env.DATABASE_URL) {
    throw new Error('не задано подключение к базе: нужны PGHOST/PGUSER/PGDATABASE или DATABASE_URL');
  }

  const target = valueOf(args, '--db', 'serial_tracker_demo');
  const force = args.includes('--force');
  const host = process.env.PGHOST ?? '';
  const user = process.env.PGUSER ?? '';
  const env = { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? '' };

  let dump = valueOf(args, '--dump', null);
  if (!dump) dump = await newestDump();
  if (!dump) {
    console.log('Копии нет — делаю её сейчас (проверка восстановлением входит в стоимость)…');
    const result = await createSnapshotBackup({ pool: createPool() });
    if (result.status !== 'verified') throw new Error(`копия не удалась: ${result.error}`);
    dump = result.file;
    console.log(`  готово: ${dump}`);
  }

  const exists = await exec('psql', ['-h', host, '-U', user, '-d', 'postgres', '-tAc',
    `SELECT 1 FROM pg_database WHERE datname = '${target}'`], { env })
    .then((r) => r.stdout.trim() === '1');
  if (exists && !force) {
    throw new Error(`база ${target} уже есть; пересоздать — с --force (она будет стёрта)`);
  }
  if (exists) {
    console.log(`Удаляю ${target}…`);
    await exec('dropdb', ['-h', host, '-U', user, target], { env });
  }

  console.log(`Разворачиваю ${dump} в ${target}…`);
  await exec('createdb', ['-h', host, '-U', user, target], { env });
  await exec('pg_restore', ['-h', host, '-U', user, '-d', target, dump], { env });

  const pool = createPool({ database: target });
  try {
    await purgeTestData(pool);

    const viewer = await createAccount(pool, {
      nickname: 'зритель',
      role: null,
    });
    const admin = await createAccount(pool, {
      nickname: 'администратор',
      role: 'admin',
    });

    const jobs = await pgBackupJobs(pool).recent({ limit: 1 });
    console.log('\nГотово.');
    console.log(`  база: ${target}`);
    console.log(`  зритель:        ${viewer.email}  пароль ${viewer.password}`);
    console.log(`  администратор:  ${admin.email}  пароль ${admin.password}`);
    if (jobs[0]) console.log(`  копия, из которой собрана: ${jobs[0].file_path ?? dump}`);
    console.log('\nПодключение к демо-базе:');
    console.log(`  PGDATABASE=${target} npm start`);
    console.log('\nВход в служебный раздел — по второму фактору (R-SEC-04): включи его');
    console.log('в разделе настроек аккаунта до защиты, иначе на экране будет стена отказа.');
  } finally {
    await pool.end();
  }
}

/**
 * Выкинуть из копии то, что наследили прогоны тестов.
 *
 * Пользователи очищаются `TRUNCATE`, а не `DELETE`: в базе стоит правило
 * `no_delete_user` (R-SQL-02 — персональные данные не удаляются молча), и
 * `DELETE FROM e_user` не выдаёт ошибку, а тихо не удаляет ничего. Проверено:
 * команда возвращает `DELETE 0`. Правило каскада не касается, поэтому
 * вместе с пользователями уходят все таблицы, которые на него ссылаются.
 */
async function purgeTestData(pool) {
  const { rows: [{ count: users }] } = await pool.query('SELECT count(*)::int AS count FROM e_user');
  await pool.query('TRUNCATE e_user CASCADE');

  // Сериалы тестов уходили в каталог опубликованными: на защите они выглядели
  // бы как настоящие, но с путями `test-series-…`.
  const { rowCount: series } = await pool.query(
    `DELETE FROM e_series
      WHERE slug LIKE 'test-series-%' OR slug ~ '^(nt|mv|hs|pg|sb|pr|ui-mk|cal|dbg|adm)[0-9%-]'`,
  );

  // Журнал прогонов импорта к защите бесполезен: он показывает прогоны
  // тестов, а не историю каталога. Резервные копии остаются — они и есть
  // объяснение, откуда взялась база.
  await pool.query('DELETE FROM e_import_item_result');
  await pool.query('DELETE FROM e_import_run');

  console.log(`Вычищено: аккаунтов ${users}, сериалов ${series}, прогоны импорта`);
}

/**
 * Создать аккаунт для показа.
 *
 * @param {any} pool
 * @param {{nickname: string, role: string|null}} args
 * @returns {Promise<{email: string, password: string}>}
 */
async function createAccount(pool, { nickname, role }) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const email = `${role === 'admin' ? 'admin' : 'viewer'}-${suffix}@example.com`;
  const password = makePassword();
  const user = await pgAuthStore(pool).createUser({
    email,
    nickname: `${nickname} ${suffix}`,
    passwordHash: await hashPassword(password),
    tokenHash: crypto.randomBytes(24).toString('base64url'),
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
  });
  await pool.query('UPDATE e_user SET email_confirmed = TRUE WHERE id = $1', [user.id]);

  if (role) {
    await pool.query(
      `INSERT INTO e_role_assignment (user_id, role, note)
       VALUES ($1, $2, 'аккаунт для показа на защите')`,
      [user.id, role],
    );
  }
  return { email, password };
}

try {
  await main();
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exitCode = 1;
}