// Решение по аномалии оценок по HTTP (F-04-08, ветка админа).
//
// Проверяется на HTTP-уровне то, что видно только через сервер: не-админ
// получает 404, а не 403 (существование служебного маршрута не выдаётся —
// как у S-84), CSRF обязателен, без токена решение не принимается, отказ
// попадает в журнал аудита. Бизнес-правила решения проверены на настоящей
// базе отдельно (tests/rating.anomalies.test.js) — здесь сервис подменён
// регистрирующим двойником.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword } from '../src/services/auth/password.js';
import { generateSecret, totpAt } from '../src/services/auth/totp.js';

const PASSWORD = 'правильный-пароль-из-десяти';

const ACCOUNT = {
  id: 20,
  email: 'anna@example.com',
  password_hash: null,
  nickname: 'anna',
  status: 'active',
  email_confirmed: true,
  locale: 'ru',
  theme: 'dark',
  timezone: 'Europe/Minsk',
  recs_enabled: true,
  profile_public: false,
  stats_public: false,
  quiet_hours: false,
};

/**
 * Стаб аномального сервиса: решает только подстроенные id.
 *
 * @param {any} calls сюда попадают вызовы resolve
 */
function fakeAnomalies(calls) {
  return {
    async resolve(args) {
      calls.push(args);
      if (args.id === 41) return { ok: false, reason: 'missing' };
      if (args.id === 42) return { ok: false, reason: 'not-open' };
      return { ok: true, decision: args.decision, discarded: args.decision === 'discarded' ? 19 : 0 };
    },
  };
}

async function withServer({ roles = [], login = true, run }) {
  const passwordHash = await hashPassword(PASSWORD);
  const user = { ...ACCOUNT, password_hash: passwordHash };
  const roleMap = { [user.id]: roles };
  const auth = stubAuthStore({ [user.email]: user }, roleMap);

  // 2FA: служебная роль требует второй фактора (R-SEC-04) — и здесь тот же
  // путь, что и у F-01-12: код считается от фиксированных часов.
  const needsTotp = roles.includes('admin');
  const secret = generateSecret();
  if (needsTotp) auth.setTwoFactor(user.id, { secret });

  const calls = [];
  const auditEntries = [];

  const app = createApp({
    data: stubData(),
    auth,
    sessionMw: createSessionMiddleware(
      { query: async () => ({ rows: [] }), on: () => {} },
      createMemorySessionStore(),
    ),
    journal: { security: (entry) => void entry },
    mailQueue: { async enqueue() { return 1; }, async listing() { return []; } },
    mailMode: {
      current: async () => 'smtp',
      change: async () => ({ ok: true, previous: 'smtp' }),
    },
    anomalies: fakeAnomalies(calls),
    audit: { async write(entry) { auditEntries.push(entry); } },
  });

  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let jar = '';
  const clock = Date.now();

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
  const post = (path, fields) => get(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  const csrfOf = async (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

  const loginPage = await get('/ru/login');
  if (login) {
    const first = await post('/ru/login', {
      email: user.email, password: PASSWORD, csrf: await csrfOf(await loginPage.text()),
    });
    if (needsTotp && first.headers.get('location')?.endsWith('/2fa')) {
      const form = await (await get('/ru/2fa')).text();
      await post('/ru/2fa', {
        code: totpAt(secret, Math.floor(clock / 1000)),
        csrf: await csrfOf(form),
      });
    }
  }

  try {
    return await run({ get, post, csrfOf, auth, calls, auditEntries });
  } finally {
    await /** @type {Promise<void>} */ (new Promise((r) => server.close(r)));
  }
}

test('гость получает 404, а не разгадку о маршруте', async () => {
  await withServer({
    roles: [],
    login: false,
    run: async ({ post }) => {
      const res = await post('/ru/admin/anomaly/5', { decision: 'accept', csrf: 'x' });
      assert.equal(res.status, 404);
    },
  });
});

test('зритель получает 404, хотя вошёл', async () => {
  await withServer({
    roles: [],
    run: async ({ post }) => {
      const res = await post('/ru/admin/anomaly/5', { decision: 'accept', csrf: 'x' });
      assert.equal(res.status, 404);
    },
  });
});

test('админ принимает аномалию: 303 и решение ушло сервису', async () => {
  await withServer({
    roles: ['admin'],
    run: async ({ get, post, csrfOf, calls }) => {
      // Токен многоразовый в рамках сессии; берём со страницы формы.
      const csrf = await csrfOf(await (await get('/ru/admin/mailbox')).text());
      const res = await post('/ru/admin/anomaly/5', { decision: 'accept', csrf });

      assert.equal(res.status, 303);
      assert.equal(calls.length, 1, 'сервис вызван один раз');
      assert.deepEqual(calls[0], { id: 5, decision: 'accepted', adminId: 20 });
    },
  });
});

test('админ отбрасывает: id сохраняется для разбора', async () => {
  await withServer({
    roles: ['admin'],
    run: async ({ get, post, csrfOf, calls }) => {
      const csrf = await csrfOf(await (await get('/ru/admin/mailbox')).text());
      const res = await post('/ru/admin/anomaly/9', { decision: 'discard', csrf });

      assert.equal(res.status, 303);
      assert.equal(calls[0].decision, 'discarded');
      assert.deepEqual(calls[0], { id: 9, decision: 'discarded', adminId: 20 });
    },
  });
});

test('незнакомое решение отклоняется 400 и до сервиса не доходит', async () => {
  await withServer({
    roles: ['admin'],
    run: async ({ get, post, csrfOf, calls }) => {
      const csrf = await csrfOf(await (await get('/ru/admin/mailbox')).text());
      const res = await post('/ru/admin/anomaly/5', { decision: 'как-нибудь', csrf });

      assert.equal(res.status, 400);
      assert.equal(calls.length, 0, 'сервис не вызывался');
    },
  });
});

test('без CSRF решение не принимается и попадает в журнал как отказ', async () => {
  await withServer({
    roles: ['admin'],
    run: async ({ post, calls, auditEntries }) => {
      const res = await post('/ru/admin/anomaly/5', { decision: 'accept', csrf: 'фейк' });

      assert.equal(res.status, 403);
      assert.equal(calls.length, 0);
      const denied = auditEntries.find((e) => e.result === 'denied');
      assert.ok(denied, 'отказ записан в журнал');
      assert.equal(denied.actorId, 20);
      assert.equal(denied.objectType, 'rating_anomaly');
      assert.equal(denied.objectId, 5);
    },
  });
});

test('уже решённая аномалия отвечает 409', async () => {
  await withServer({
    roles: ['admin'],
    run: async ({ get, post, csrfOf, calls, auditEntries }) => {
      const csrf = await csrfOf(await (await get('/ru/admin/mailbox')).text());
      const res = await post('/ru/admin/anomaly/42', { decision: 'accept', csrf });

      assert.equal(res.status, 409);
      assert.equal(calls.length, 1);
      assert.equal(auditEntries.at(-1).result, 'denied');
      assert.equal(auditEntries.at(-1).objectId, 42);
    },
  });
});

test('несуществующая аномалия отвечает 404 и в журнал не решением', async () => {
  await withServer({
    roles: ['admin'],
    run: async ({ get, post, csrfOf, auditEntries }) => {
      const csrf = await csrfOf(await (await get('/ru/admin/mailbox')).text());
      const res = await post('/ru/admin/anomaly/41', { decision: 'accept', csrf });

      assert.equal(res.status, 404);
      assert.equal(auditEntries.at(-1).result, 'denied');
    },
  });
});
