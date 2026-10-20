// Аварийный сброс 2FA администратора (H-60, F-01-05 §4).
//
// Проверяется то, ради чего команда существует: без подтверждения она не
// делает ничего, а с подтверждением выключает проверку и отзывает сессии.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { createJournal } from '../src/services/journal.js';
import { run } from '../src/cli/reset-two-factor.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — аварийный сброс не проверялся';

let pool;
let auth;
const created = [];

async function userWithTwoFactor() {
  const { hashPassword, makeToken } = await import('../src/services/auth/password.js');
  const { generateSecret } = await import('../src/services/auth/totp.js');
  const { hash } = makeToken();
  const name = `аварийный-${crypto.randomUUID().slice(0, 8)}`;
  const account = await auth.createUser({
    email: `${name}@example.com`,
    nickname: name,
    passwordHash: await hashPassword('правильный-пароль-из-десяти'),
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  await auth.enableTwoFactor(account.id, generateSecret(), []);
  created.push(account.id);
  return { ...account, nickname: name };
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  auth = pgAuthStore(pool);
});

test.after(async () => {
  if (!pool) return;
  if (created.length) {
    await pool.query('DELETE FROM e_user WHERE id = ANY($1::bigint[])', [created]);
  }
  await pool.end();
});

test('без --yes команда ничего не делает (H-60)', { skip }, async () => {
  const account = await userWithTwoFactor();

  const result = await run({ pool, auth, journal: createJournal({ sink: () => {} }) },
    ['--nickname', account.nickname]);

  assert.equal(result, null, 'сброс не выполнен');
  assert.ok(await auth.twoFactor(account.id), 'проверка на месте');
});

test('с --yes проверка выключена, сессии отозваны (F-01-05 §4)', { skip }, async () => {
  const account = await userWithTwoFactor();
  const sid = `test-cli-2fa-${crypto.randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO session (sid, sess, expire)
     VALUES ($1, json_build_object('cookie', json_build_object('path','/'),
                                   'user', json_build_object('id', $2::text))::json,
             now() + interval '1 day')`,
    [sid, account.id],
  );
  const lines = [];

  const nickname = await run({
    pool, auth, journal: createJournal({ sink: (line) => lines.push(line) }),
  }, ['--id', String(account.id), '--yes']);

  assert.equal(nickname, account.nickname, 'скрипт отработал');
  assert.equal(await auth.twoFactor(account.id), null, 'проверки больше нет');
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM session WHERE sid = $1', [sid],
  );
  assert.equal(rows[0].n, 0, 'сессия отозвана');
  assert.ok(lines.some((line) => line.includes('two_factor_reset_by_script')),
    'в журнале безопасности есть запись о сбросе');
  await pool.query('DELETE FROM session WHERE sid = $1', [sid]);
});
