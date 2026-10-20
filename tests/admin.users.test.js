// Раздел администрирования: список пользователей и карточка человека
// (F-09-01, F-09-02, S-71, S-72).
//
// Проверяется то, что видит администратор: фильтры, частично закрытый адрес,
// числа у пользователя и его ограничения. И то, что раздел не выдаётся
// никому, кроме администратора.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { generateSecret, totpAt } from '../src/services/auth/totp.js';
import { pgAdminUsers, maskAddress } from '../src/services/admin/users.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — раздел администрирования не проверялся';

let pool;
let auth;
const created = [];

async function user({ roles = [], nickname = null } = {}) {
  const { hash } = makeToken();
  const name = nickname ?? `admin-user-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${name}@example.com`;
  const passwordHash = await hashPassword('правильный-пароль-из-десяти');
  const account = await pgAuthStore(pool).createUser({
    email,
    nickname: name,
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
      `INSERT INTO e_role_assignment (user_id, role, granted_by, note) VALUES ($1, $2, $1, 'тест админа')`,
      [account.id, role],
    );
  }
  const secret = generateSecret();
  if (roles.includes('admin')) await auth.enableTwoFactor(account.id, secret, []);
  created.push(account.id);
  return { id: account.id, email, nickname: name, passwordHash, roles, secret };
}

async function withServer({ user: viewer = null, run }) {
  const app = createApp({
    data: stubData(),
    auth,
    adminUsers: pgAdminUsers(pool),
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
  await pool.query('DELETE FROM e_role_assignment WHERE note = \'тест админа\'');
  await pool.query('DELETE FROM e_user WHERE id = ANY($1::bigint[])', [created]);
  await pool.end();
});

test('адрес в списке показан частично (F-09-01 §8б)', { skip }, async () => {
  assert.equal(maskAddress('reader@example.com'), 'r****r@example.com');
  assert.equal(maskAddress('a@example.com'), 'a*@example.com');
});

test('список отдаёт администратору и прячет остальным (EC-R7)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });
  const plain = await user();

  await withServer({
    user: admin,
    run: async ({ get }) => {
      const res = await get('/ru/admin/users');
      assert.equal(res.status, 200, 'администратор видит список');
      const html = await res.text();
      assert.match(html, /Пользователи/, 'заголовок раздела');
    },
  });

  await withServer({
    user: plain,
    run: async ({ get }) => {
      const res = await get('/ru/admin/users');
      assert.equal(res.status, 404, 'зрителю раздел не выдаётся');
    },
  });
});

test('фильтр по нику находит человека, а числа у него считаются (F-09-01 §4)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });
  const target = await user({ nickname: `искомый-${crypto.randomUUID().slice(0, 6)}` });
  const seriesId = (await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Подсчёт', 'Count fixture', $2, 'published', 'airing', 2024) RETURNING id`,
    [`admin-count-${crypto.randomUUID().slice(0, 8)}`, 986_000_000 + Math.floor(Math.random() * 900)],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO e_rating (user_id, object_type, series_id, value, counted)
     VALUES ($1, 'series', $2, 8, TRUE)`,
    [target.id, seriesId],
  );

  await withServer({
    user: admin,
    run: async ({ get }) => {
      const html = await (await get(`/ru/admin/users?nickname=${encodeURIComponent(target.nickname)}`)).text();
      assert.match(html, new RegExp(target.nickname), 'человек найден');
      assert.match(html, /1<\/td>/, 'число его оценок показано');
    },
  });

  // Фикстуры убираем: общая база — и оставленный сериал с названием
  // «Подсчёт» попадал в выборку тестов, берущих любой сериал.
  await pool.query('DELETE FROM e_rating WHERE user_id = $1', [target.id]);
  await pool.query('DELETE FROM e_series WHERE id = $1', [seriesId]);
});

test('карточка человека показывает роли, ограничения и материалы (F-09-02 §4)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });
  const target = await user({ roles: ['editor'] });
  await pool.query(
    `INSERT INTO e_restriction (user_id, kind, reason, set_by, expires_at)
     VALUES ($1, 'mute', 'слишком часто пишет', $2, now() + interval '24 hours')`,
    [target.id, admin.id],
  );

  await withServer({
    user: admin,
    run: async ({ get }) => {
      const html = await (await get(`/ru/admin/users/${target.id}`)).text();
      assert.match(html, new RegExp(target.nickname), 'имя человека');
      assert.match(html, /Редактор/, 'выданная роль');
      assert.match(html, /слишком часто пишет/, 'причина ограничения');
    },
  });
});
