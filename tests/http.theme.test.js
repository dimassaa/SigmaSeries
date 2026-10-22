// Тема: сервер — источник правды (F-01-06 §8, §18).
//
// Проверяется то, что человек видит и что остаётся после перезахода: тема
// из профиля действует на каждой странице, переключатель в шапке её
// сохраняет, а чужой запрос — нет.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';
const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — тема не проверялась';

let pool;

/** Вошедший человек с темой в профиле. */
async function viewer(theme = 'dark') {
  const { hash } = makeToken();
  const nickname = `theme-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${nickname}@example.com`;
  const passwordHash = await hashPassword(PASSWORD);
  const created = await pgAuthStore(pool).createUser({
    email,
    nickname,
    passwordHash,
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme,
    confirmed: true,
  });
  await pool.query(
    `UPDATE e_user SET email_confirmed = TRUE, registered_at = now() - interval '30 days' WHERE id = $1`,
    [created.id],
  );
  return {
    id: created.id,
    email,
    nickname,
    email_enc: null,
    password_hash: passwordHash,
    status: 'active',
    email_confirmed: true,
    locale: 'ru',
    theme,
    timezone: 'Europe/Minsk',
  };
}

async function withServer({ user = null, run }) {
  const app = createApp({
    data: stubData(),
    // Настоящий сервис: тема сохраняется в профиле, и проверка смотрит
    // именно туда — заглушка держит учётную запись в памяти.
    auth: pgAuthStore(pool),
    sessionMw: createSessionMiddleware(pool, createMemorySessionStore(), {
      // Тема едет с аккаунтом, как в `server.js`: страница знает выбор
      // человека ещё до отрисовки.
      account: async (u) => ({
        nickname: u.nickname,
        // Тема — из профиля, как в `server.js`: сессия хранит снимок на
        // момент входа.
        theme: await pgAuthStore(pool).themeOf(u.id),
        unread: 0,
        pollSeconds: 0,
      }),
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

  if (user) {
    const form = await (await get('/ru/login')).text();
    await post('/ru/login', { email: user.email, password: PASSWORD, csrf: csrfOf(form) });
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
});

test.after(async () => {
  if (pool) await pool.end();
});

test('тема из профиля действует на странице, а не заменяется браузерной', { skip }, async () => {
  // Проверка появилась после находки в браузере: ранний скрипт брал тему из
  // localStorage и подставлял поверх серверной, и выбор из профиля не действовал
  // ни на одной странице — настройка писала «Сохранено», а тема не менялась.
  const user = await viewer('light');
  await withServer({
    user,
    run: async ({ get }) => {
      const html = await (await get('/ru/')).text();
      assert.match(html, /data-theme="light"/, 'страница отдаёт тему человека из профиля');
    },
  });
});

test('тема, сменённая после входа, видна сразу', { skip }, async () => {
  // Сессия хранит снимок на момент входа: если читать тему из неё, смена
  // видна только после нового входа — а человек ждёт её сразу.
  const user = await viewer('light');
  await withServer({
    user,
    run: async ({ get }) => {
      await pool.query('UPDATE e_user SET theme = \'dark\' WHERE id = $1', [user.id]);
      const html = await (await get('/ru/')).text();
      assert.match(html, /data-theme="dark"/, 'страница показывает тему из профиля');
    },
  });
});

test('переключатель в шапке сохраняет выбор в профиль', { skip }, async () => {
  const user = await viewer('light');
  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/')).text();
      const token = page.match(/data-theme-csrf="([^"]+)"/)?.[1];
      assert.ok(token, 'у кнопки темы есть токен: выбор уходит на сервер');

      const res = await post('/ru/theme', { csrf: token, theme: 'dark' });
      assert.equal(res.status, 204, 'выбор принят');

      const { rows: [row] } = await pool.query('SELECT theme FROM e_user WHERE id = $1', [user.id]);
      assert.equal(row.theme, 'dark', 'тема сохранена в профиле');
    },
  });
});

test('чужая просьба сменить тему не проходит (R-SEC-23)', { skip }, async () => {
  const user = await viewer('light');
  await withServer({
    user,
    run: async ({ post }) => {
      const res = await post('/ru/theme', { csrf: 'чужой токен', theme: 'dark' });
      assert.equal(res.status, 403, 'без верного токена тема не меняется');

      const { rows: [row] } = await pool.query('SELECT theme FROM e_user WHERE id = $1', [user.id]);
      assert.equal(row.theme, 'light', 'тема осталась прежней');
    },
  });
});

test('темы такой нет — просьба отвергнута, а не записана', { skip }, async () => {
  const user = await viewer('light');
  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/')).text();
      const token = page.match(/data-theme-csrf="([^"]+)"/)?.[1];
      const res = await post('/ru/theme', { csrf: token, theme: 'неон' });
      assert.equal(res.status, 400, 'чужая тема не принимается');

      const { rows: [row] } = await pool.query('SELECT theme FROM e_user WHERE id = $1', [user.id]);
      assert.equal(row.theme, 'light', 'тема осталась прежней');
    },
  });
});
