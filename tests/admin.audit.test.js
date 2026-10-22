// Журнал аудита по HTTP (F-09-03, S-81).
//
// Проверяется то, что читает администратор: записи видны, фильтры работают,
// и раздел не выдаётся никому, кроме администратора.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { generateSecret, totpAt } from '../src/services/auth/totp.js';
import { pgAuditLog } from '../src/services/audit/log.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — журнал аудита не проверялся';

let pool;
let auth;
const created = [];

async function user({ roles = [] } = {}) {
  const { hash } = makeToken();
  const nickname = `audit-${crypto.randomUUID().slice(0, 8)}`;
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
      `INSERT INTO e_role_assignment (user_id, role, granted_by, note) VALUES ($1, $2, $1, 'тест журнала')`,
      [account.id, role],
    );
  }
  const secret = generateSecret();
  if (roles.includes('admin')) await auth.enableTwoFactor(account.id, secret, []);
  created.push(account.id);
  return { id: account.id, email, nickname, passwordHash, roles, secret };
}

async function withServer({ user: viewer = null, run }) {
  const app = createApp({
    data: stubData(),
    auth,
    audit: pgAuditLog(pool),
    sessionMw: createSessionMiddleware(pool, createMemorySessionStore(), {
      account: async (u) => ({ nickname: u.nickname, unread: 0, pollSeconds: 0 }),
    }),
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
    await run({ get, post, csrfOf });
  } finally {
    await /** @type {Promise<void>} */ (new Promise((r) => server.close(r)));
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
  await pool.query("DELETE FROM e_audit_log WHERE action LIKE 'test.audit%'");
  await pool.query("DELETE FROM e_role_assignment WHERE note = 'тест журнала'");
  await pool.query('DELETE FROM e_user WHERE id = ANY($1::bigint[])', [created]);
  await pool.end();
});

test('администратор видит записи, фильтр по действию работает (F-09-03 §4)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });
  const audit = pgAuditLog(pool);
  await audit.write({
    actorId: admin.id,
    action: 'test.audit.probe',
    objectType: 'user',
    objectId: admin.id,
    result: 'ok',
    reason: 'проверка журнала',
  });

  await withServer({
    user: admin,
    run: async ({ get }) => {
      const html = await (await get('/ru/admin/audit')).text();
      assert.match(html, /Журнал аудита/, 'заголовок журнала');
      assert.match(html, /test\.audit\.probe/, 'запись видна');
      assert.match(html, /проверка журнала/, 'причина видна');

      const filtered = await (await get('/ru/admin/audit?action=test.audit.probe')).text();
      assert.match(filtered, /test\.audit\.probe/, 'фильтр по действию находит запись');
    },
  });
});

test('зрителю журнал не выдаётся (EC-R7)', { skip }, async () => {
  const plain = await user();
  await withServer({
    user: plain,
    run: async ({ get }) => {
      const res = await get('/ru/admin/audit');
      assert.equal(res.status, 404, 'служебный журнал не выдаётся');
    },
  });
});
