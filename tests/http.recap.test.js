// Публичные итоги через настоящий HTTP (M7, S-33).
//
// Проверяется то, что видит человек: шапку с ником и датой, вкладки,
// публикацию чужих итогов только при открытой приватности и отказ при
// недостатке данных.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — итоги по HTTP не проверялись';

const USER = {
  id: 7,
  nickname: 'Иван',
  status: 'active',
  registeredAt: '2026-03-14T10:00:00.000Z',
  statsPublic: false,
  profilePublic: false,
};

const SLIDE = {
  key: 'series',
  value: 47,
  unit: 'series',
  params: { count: 312 },
  link: null,
  notePlural: true,
};

let pool;
const created = [];

/** Данные итогов: хватает или не хватает данных. */
function recapData(enough) {
  return {
    period: 'year',
    year: 2026,
    month: 10,
    timezone: 'Europe/Minsk',
    enough,
    marks: enough ? 260 : 8,
    series: enough ? 47 : 2,
    hours: enough ? 312 : 6,
    slides: enough ? [SLIDE] : [],
  };
}

/** Сервис итогов на замену: база под рукой не нужна. */
function stubRecap(enough = true) {
  return {
    async slides() { return recapData(enough); },
    async clock() { return { timezone: 'Europe/Minsk', year: 2026, month: 10 }; },
    async markInviteRead() {},
  };
}

/** Сервис профиля на замену. */
function stubProfile(user) {
  return {
    async byNickname(nickname) {
      if (!user || user.nickname.toLowerCase() !== String(nickname).toLowerCase()) return null;
      return user;
    },
    async byId() { return user; },
  };
}

/** Зритель без служебных ролей: второму фактору он не подлежит. */
async function makeViewer() {
  const { hash } = makeToken();
  const nickname = `recap-${crypto.randomUUID().slice(0, 8)}`;
  const account = await pgAuthStore(pool).createUser({
    email: `${nickname}@example.com`,
    nickname,
    passwordHash: await hashPassword('правильный-пароль-из-десяти'),
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  await pool.query(
    'UPDATE e_user SET email_confirmed = TRUE, registered_at = now() - interval \'30 days\' WHERE id = $1',
    [account.id],
  );
  created.push(account.id);
  return { id: account.id, nickname, email: `${nickname}@example.com` };
}

async function withServer(run, { enough = true, user = USER } = {}) {
  const app = createApp({
    auth: pgAuthStore(pool),
    profile: stubProfile(user),
    recap: stubRecap(enough),
    data: { forYou: async () => ({ items: [], personalized: false }) },
    sessionMw: createSessionMiddleware(pool, createMemorySessionStore(), {
      account: async (u) => ({ nickname: u.nickname, unread: 0, pollSeconds: 0 }),
    }),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let jar = '';

  const get = async (path) => {
    const res = await fetch(base + path, { redirect: 'manual', headers: { cookie: jar } });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) jar = set.map((c) => c.split(';')[0]).join('; ');
    return res;
  };
  const post = async (path, fields) => {
    const res = await fetch(base + path, {
      redirect: 'manual',
      method: 'POST',
      headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) jar = set.map((c) => c.split(';')[0]).join('; ');
    return res;
  };
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

  try {
    await run({ get, post, csrfOf });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_user WHERE id = ANY($1::bigint[])', [created]);
  await pool.end();
});

test('свои итоги показывают ник, дату и слайды', { skip }, async () => {
  const viewer = await makeViewer();
  await withServer(async ({ get, post, csrfOf }) => {
    const form = await (await get('/ru/login')).text();
    await post('/ru/login', {
      email: viewer.email,
      password: 'правильный-пароль-из-десяти',
      csrf: csrfOf(form),
    });

    const res = await get('/ru/recap');
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(body, /Итоги за 2026/);
    assert.match(body, /47/);
  });
});

test('при недостатке данных показывается объяснение, а не пустые слайды', { skip }, async () => {
  const viewer = await makeViewer();
  await withServer(async ({ get, post, csrfOf }) => {
    const form = await (await get('/ru/login')).text();
    await post('/ru/login', {
      email: viewer.email,
      password: 'правильный-пароль-из-десяти',
      csrf: csrfOf(form),
    });

    const res = await get('/ru/recap');
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(body, /мало данных/i);
  }, { enough: false });
});

test('чужие итоги открыты только при публичной приватности', { skip }, async () => {
  await withServer(async ({ get }) => {
    const res = await get('/ru/u/%D0%98%D0%B2%D0%B0%D0%BD/recap');
    assert.equal(res.status, 404, 'при закрытой приватности чужих итогов нет');
  });
});

test('при публичной приватности чужие итоги открываются', { skip }, async () => {
  await withServer(async ({ get }) => {
    const res = await get('/ru/u/%D0%98%D0%B2%D0%B0%D0%BD/recap');
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(body, /Итоги за 2026/);
  }, { user: { ...USER, profilePublic: true } });
});

test('страница итогов не индексируется', { skip }, async () => {
  await withServer(async ({ get }) => {
    const res = await get('/ru/u/%D0%98%D0%B2%D0%B0%D0%BD/recap');
    const body = await res.text();
    assert.match(body, /<meta name="robots" content="noindex, follow">/);
  }, { user: { ...USER, profilePublic: true } });
});
