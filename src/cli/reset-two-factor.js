// Аварийный сброс двухфакторной проверки (H-60, F-01-05 §4).
//
//   npm run auth:reset-2fa -- --nickname anna --yes
//   npm run auth:reset-2fa -- --id 42 --yes
//
// Случай один: администратор потерял и устройство, и резервные коды, и войти
// больше не может. Через интерфейс свою проверку сбросить нельзя — там
// специально оставлена заглушка с объяснением (F-01-05 §4).
//
// Скрипт выключает проверку, отзывает сессии и пишет строку в журнал
// безопасности. Без `--yes` он ничего не делает: команда, которая снимает
// второй фактор у администратора, не должна выполниться по невнимательности.

import { pathToFileURL } from 'node:url';

import { createPool } from '../db/pool.js';
import { pgAuthStore } from '../services/auth/store.js';
import { createJournal } from '../services/journal.js';

const USAGE = `Использование:
  npm run auth:reset-2fa -- --nickname <ник> --yes
  npm run auth:reset-2fa -- --id <идентификатор> --yes

Без --yes команда ничего не делает.`;

/**
 * Значение флага.
 *
 * @param {string[]} args
 * @param {string} flag
 * @returns {string|null}
 */
function valueOf(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

/**
 * Найти человека по нику или по идентификатору.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {object} deps.auth
 * @param {{nickname: string|null, id: string|null}} input
 * @returns {Promise<{id: number, nickname: string}|null>}
 */
async function findUser({ pool, auth }, { nickname, id }) {
  if (id) {
    const { rows } = await pool.query(
      'SELECT id, nickname FROM e_user WHERE id = $1',
      [Number(id)],
    );
    return rows[0] ?? null;
  }
  if (nickname) {
    const { rows } = await pool.query(
      'SELECT id, nickname FROM e_user WHERE nickname = $1',
      [nickname],
    );
    return rows[0] ?? null;
  }
  return null;
}

/**
 * Сбросить проверку человека.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {object} deps.auth
 * @param {object} deps.journal
 * @param {string[]} args аргументы командной строки
 * @returns {Promise<string|null>} что сделано; null — ничего не сделано
 */
export async function run({ pool, auth, journal }, args) {
  const nickname = valueOf(args, '--nickname');
  const id = valueOf(args, '--id');
  const confirmed = args.includes('--yes');

  if (!nickname && !id) {
    console.log(USAGE);
    return null;
  }
  if (!confirmed) {
    console.log('Ничего не сделано: для сброса нужен ключ --yes.');
    console.log(USAGE);
    return null;
  }

  const user = await findUser({ pool, auth }, { nickname, id });
  if (!user) throw new Error('аккаунт не найден');

  const state = await auth.twoFactor(user.id);
  if (!state) throw new Error('у аккаунта нет двухфакторной проверки: сбрасывать нечего');

  const result = await auth.resetTwoFactor(user.id);
  journal.security({
    event: 'two_factor_reset_by_script',
    requestId: `cli-reset-2fa-${Date.now()}`,
    user_id: user.id,
    sessions_revoked: result.sessions,
  });
  console.log(
    `Проверка сброшена у «${user.nickname}» (${user.id}); сессий отозвано: ${result.sessions}.`,
  );
  console.log('При следующем входе проверку нужно настроить заново.');
  return user.nickname;
}

/**
 * Точка входа: разбор аргументов, подключение и запуск.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const args = process.argv.slice(2);
  if (!process.env.PGHOST && !process.env.DATABASE_URL) {
    throw new Error('не задано подключение к базе: нужны PGHOST/PGUSER/PGDATABASE или DATABASE_URL');
  }

  const pool = createPool();
  try {
    await run({
      pool,
      auth: pgAuthStore(pool),
      journal: createJournal(),
    }, args);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    // Сообщение, а не стек: команду запускают руками с защиты.
    console.error(`\n${error.message}\n`);
    process.exitCode = 1;
  }
}
