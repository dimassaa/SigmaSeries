// Системный обзор по HTTP (F-09-05, S-70).
//
// Проверяется то, что администратор видит на входе: числа онлайна, состояние
// очереди и открытые аномалии оценок с решением.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { generateSecret, totpAt } from '../src/services/auth/totp.js';
import { pgAdminOverview } from '../src/services/admin/overview.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — обзор не проверялся';

let pool;
let auth;
const created = [];

async function user({ roles = [] } = {}) {
  const { hash } = makeToken();
  const nickname = `overview-${crypto.randomUUID().slice(0, 8)}`;
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
      `INSERT INTO e_role_assignment (user_id, role, granted_by, note) VALUES ($1, $2, $1, 'тест обзора')`,
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
    adminOverview: pgAdminOverview(pool),
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
  await pool.query("DELETE FROM e_role_assignment WHERE note = 'тест обзора'");
  await pool.query('DELETE FROM e_user WHERE id = ANY($1::bigint[])', [created]);
  await pool.end();
});

test('обзор отдаёт числа и открытые аномалии (F-09-05, S-70)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Сериал аномалии', 'Overview fixture', $2, 'published', 'airing', 2024) RETURNING id`,
    [`overview-${crypto.randomUUID().slice(0, 8)}`, 982_000_000 + Math.floor(Math.random() * 900)],
  );
  const { rows: [anomaly] } = await pool.query(
    `INSERT INTO e_rating_anomaly (series_id, signal, frozen)
     VALUES ($1, '{"count_window": 25, "extreme_share": 100}', '{"summary": {}}') RETURNING id`,
    [series.id],
  );

  try {
    await withServer({
      user: admin,
      run: async ({ get }) => {
        const html = await (await get('/ru/admin')).text();
        assert.match(html, /Системный обзор/, 'заголовок обзора');
        assert.match(html, /Сейчас онлайн/, 'число онлайна');
        assert.match(html, /В очереди модерации/, 'размер очереди');
        assert.match(html, /Сериал аномалии/, 'открытая аномалия видна');
        assert.match(html, new RegExp(`/ru/admin/anomaly/${anomaly.id}`),
          'у аномалии есть форма решения');
        assert.match(html, /Принять оценки/, 'есть действие «принять»');
      },
    });
  } finally {
    await pool.query('DELETE FROM e_rating_anomaly WHERE id = $1', [anomaly.id]);
    await pool.query('DELETE FROM e_series WHERE id = $1', [series.id]);
  }
});

test('зрителю обзор не выдаётся (EC-R7)', { skip }, async () => {
  const plain = await user();
  await withServer({
    user: plain,
    run: async ({ get }) => {
      const res = await get('/ru/admin');
      assert.equal(res.status, 404, 'служебный обзор не выдаётся');
    },
  });
});
