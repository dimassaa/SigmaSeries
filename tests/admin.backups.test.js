// Резервные копии по HTTP (F-09-04, S-82).
//
// Проверяется то, что видит администратор: расписание, состояние копий и
// ручной запуск. Сам запуск в проверке — заглушка: настоящий снимок поднимает
// дамп базы, и в проверке это неуместно.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { generateSecret, totpAt } from '../src/services/auth/totp.js';
import { pgBackupJobs } from '../src/services/backup/store.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — экран копий не проверялся';

let pool;
let auth;
const created = [];

async function user({ roles = [] } = {}) {
  const { hash } = makeToken();
  const nickname = `backups-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${nickname}@example.com`;
  const passwordHash = await hashPassword('правильный-пароль-из-десяти');
  const account = await pgAuthStore(pool).createUser({
    email,
    nickname,
    passwordHash,
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  await pool.query(
    `UPDATE e_user SET email_confirmed = TRUE, registered_at = now() - interval '30 days' WHERE id = $1`,
    [account.id],
  );
  for (const role of roles) {
    await pool.query(
      `INSERT INTO e_role_assignment (user_id, role, granted_by, note) VALUES ($1, $2, $1, 'тест копий')`,
      [account.id, role],
    );
  }
  const secret = generateSecret();
  if (roles.includes('admin')) await auth.enableTwoFactor(account.id, secret, []);
  created.push(account.id);
  return { id: account.id, email, nickname, passwordHash, roles, secret };
}

async function withServer({ user: viewer = null, run, runBackup = null }) {
  const calls = [];
  const app = createApp({
    data: stubData(),
    auth,
    backups: pgBackupJobs(pool),
    backupSchedule: async () => ({ hour: 3, minute: 30 }),
    backupRunner: runBackup ?? (async () => {
      calls.push('run');
      return { status: 'verified', bytes: 1024 };
    }),
    audit: { write: async (entry) => calls.push(entry) },
    // createApp объявляет middleware сессий функцией, а модуль отдаёт обработчик
    // или их пару — Express принимает и то и другое.
    sessionMw: /** @type {Function} */ (createSessionMiddleware(pool, createMemorySessionStore(), {
      account: async (u) => ({ nickname: u.nickname, unread: 0, pollSeconds: 0 }),
    })),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let jar = '';

  const get = async (path, init = {}) => {
    const res = await fetch(base + path, {
      redirect: 'manual',
      ...init,
      headers: { cookie: jar, ...(init.headers ?? {}) },
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) jar = set.map((c) => c.split(';')[0]).join('; ');
    return res;
  };
  const post = (path, fields, init = {}) => get(path, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(init.headers ?? {}) },
    body: new URLSearchParams(fields),
  });
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

  if (viewer) {
    const form = await (await get('/ru/login')).text();
    const first = await post('/ru/login', {
      email: viewer.email, password: 'правильный-пароль-из-десяти', csrf: csrfOf(form),
    });
    if (first.headers.get('location')?.endsWith('/2fa')) {
      const page = await (await get('/ru/2fa')).text();
      await post('/ru/2fa', {
        code: totpAt(viewer.secret, Math.floor(Date.now() / 1000)),
        csrf: csrfOf(page),
      });
    }
  }

  try {
    await run({ get, post, csrfOf, calls });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
  auth = pgAuthStore(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.query("DELETE FROM e_backup_job WHERE file_path = 'test-backup-copy'");
  await pool.query("DELETE FROM e_role_assignment WHERE note = 'тест копий'");
  await pool.query('DELETE FROM e_user WHERE id = ANY($1::bigint[])', [created]);
  await pool.end();
});

test('расписание и копии видны, ручной запуск работает (F-09-04 §3)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });
  await pgBackupJobs(pool).record({ status: 'verified', sizeBytes: 2048, filePath: 'test-backup-copy' });

  await withServer({
    user: admin,
    run: async ({ get, post, csrfOf, calls }) => {
      const html = await (await get('/ru/admin/backups')).text();
      assert.match(html, /Резервные копии/, 'заголовок экрана');
      assert.match(html, /03:30/, 'расписание показано');
      assert.match(html, /Проверена/, 'состояние копии показано');
      assert.match(html, /2 КБ/, 'размер копии показан');

      const res = await post('/ru/admin/backups/run', { csrf: csrfOf(html) });
      assert.equal(res.status, 303, 'копия заказана, возвращаем на экран');
      assert.ok(calls.includes('run'), 'запуск состоялся');
      const audited = calls.find((one) => one?.action === 'backup.run');
      assert.ok(audited, 'запуск записан в аудит');
      assert.equal(audited.result, 'ok', 'результат запуска в журнале');
    },
  });
});

test('зрителю экран копий не выдаётся (EC-R7)', { skip }, async () => {
  const plain = await user();
  await withServer({
    user: plain,
    run: async ({ get }) => {
      const res = await get('/ru/admin/backups');
      assert.equal(res.status, 404, 'служебный экран не выдаётся');
    },
  });
});
