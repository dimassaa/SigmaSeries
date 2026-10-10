// S-19 через настоящий HTTP: вход, выход, отказы.
// Спецификация: docs/01-product/features/M1-identity.md F-01-03.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore, csrfToken, csrfValid } from '../src/services/auth/session.js';
import { hashPassword } from '../src/services/auth/password.js';
import * as limits from '../src/services/auth/limits.js';
import { AUTH } from '../src/config/settings.js';

const PASSWORD = 'правильный-пароль-из-десяти';

/** Приложение с сессиями в памяти: развёрнутая база здесь не проверяется. */
function makeApp(users = {}, roles = {}) {
  const pool = { query: async () => ({ rows: [] }), on: () => {} };
  const sessionMw = createSessionMiddleware(pool, createMemorySessionStore());
  const app = createApp({
    data: stubData(),
    auth: stubAuthStore(users, roles),
    sessionMw,
  });
  return { app, sessionMw };
}

async function withServer(users, roles, run) {
  const { app } = makeApp(users, roles);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let jar = '';
  const get = async (path, init = {}) => {
    const res = await fetch(base + path, { redirect: 'manual', ...init });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) jar = set.map((c) => c.split(';')[0]).join('; ');
    return res;
  };
  const post = (path, fields, init = {}) => get(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar, ...init.headers },
    body: new URLSearchParams(fields),
    ...init,
  });
  /**
   * Достаёт CSRF из формы — так его видит и человек, и робот.
   * Синхронная: если сделать её async, в форму уедет «[object Promise]»
   * и проверка не будет проходить никогда.
   */
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];
  try {
    await run({ get, post, csrfOf });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const activeUser = async (over = {}) => ({
  id: 1, email_enc: null, password_hash: await hashPassword(PASSWORD),
  nickname: 'anna', status: 'active', email_confirmed: true,
  locale: 'ru', theme: 'dark', ...over,
});

test.beforeEach(() => limits._reset());

// ─── Форма ────────────────────────────────────────────────────────────────────

test('форма входа отдаётся и не индексируется', async () => {
  await withServer({}, {}, async ({ get }) => {
    const res = await get('/ru/login');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, follow');
    const html = await res.text();
    assert.match(html, /<input[^>]+name="csrf"/, 'в форме есть CSRF-токен');
    assert.match(html, /<label[^>]+for="email"/, 'у поля есть подпись');
    assert.match(html, /<label[^>]+for="password"/);
    assert.match(html, /autocomplete="email"/);
    assert.match(html, /autocomplete="current-password"/);
  });
});

test('у формы есть ровно один h1 и роль status для ошибки', async () => {
  await withServer({}, {}, async ({ get }) => {
    const html = await (await get('/ru/login')).text();
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
    assert.match(html, /role="alert"/);
    assert.match(html, /aria-live="assertive"/);
  });
});

// ─── Вход ─────────────────────────────────────────────────────────────────────

test('верный пароль пускает на главную', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, {}, async ({ get, post, csrfOf }) => {
    const html = await (await get('/ru/login')).text();
    const res = await post('/ru/login', {
      email: 'a@b.c', password: PASSWORD, csrf: csrfOf(html), next: '/',
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/ru/');
    assert.ok(res.headers.getSetCookie?.().length, 'выдана сессионная cookie');
  });
});

test('неверный пароль даёт один общий ответ', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, {}, async ({ get, post, csrfOf }) => {
    const html = await (await get('/ru/login')).text();
    const wrong = await post('/ru/login', { email: 'a@b.c', password: 'неверный-пароль', csrf: csrfOf(html) });
    const wrongBody = await wrong.text();
    const unknown = await post('/ru/login', { email: 'нет@такого', password: 'неверный-пароль', csrf: csrfOf(html) });
    const unknownBody = await unknown.text();
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    // Совпадать должно сообщение об ошибке, а не вся страница: форма
    // законно возвращает введённый адрес, и это различие не опасное.
    // Опасное — если различаются текст ошибки или код ответа.
    const err = (s) => s.match(/class="form__error">([^<]*)</)?.[1];
    assert.equal(err(wrongBody), err(unknownBody));
    assert.ok(err(wrongBody), 'сообщение об ошибке должно быть на странице');
  });
});

test('email вводится в ответ при ошибке', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, {}, async ({ get, post, csrfOf }) => {
    const html = await (await get('/ru/login')).text();
    const res = await post('/ru/login', { email: 'a@b.c', password: 'неверный-пароль', csrf: csrfOf(html) });
    const body = await res.text();
    assert.match(body, /value="a@b\.c"/, 'адрес не должен теряться при ошибке');
    assert.ok(!/value="неверный-пароль"/.test(body), 'пароль не возвращается в форму');
  });
});

test('без CSRF-токена запрос отклоняется', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, {}, async ({ post }) => {
    const res = await post('/ru/login', { email: 'a@b.c', password: PASSWORD, csrf: 'подделка' });
    assert.equal(res.status, 403);
  });
});

test('возврат после входа ведёт по внутреннему адресу', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, {}, async ({ get, post, csrfOf }) => {
    const html = await (await get('/ru/login')).text();
    const res = await post('/ru/login', {
      email: 'a@b.c', password: PASSWORD, csrf: csrfOf(html), next: '/ru/calendar',
    });
    assert.equal(res.headers.get('location'), '/ru/calendar');
  });
});

test('внешний адрес возврата не проводится', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, {}, async ({ get, post, csrfOf }) => {
    const html = await (await get('/ru/login')).text();
    const res = await post('/ru/login', {
      email: 'a@b.c', password: PASSWORD, csrf: csrfOf(html), next: 'https://evil.example',
    });
    assert.equal(res.headers.get('location'), '/ru/');
  });
});

// ─── Состояния учётки ─────────────────────────────────────────────────────────

test('забаненный получает отказ, но не раньше верного пароля', async () => {
  const user = await activeUser({ status: 'banned' });
  await withServer({ 'a@b.c': user }, {}, async ({ get, post, csrfOf }) => {
    const html = await (await get('/ru/login')).text();
    const wrong = await post('/ru/login', { email: 'a@b.c', password: 'неверный', csrf: csrfOf(html) });
    assert.equal(wrong.status, 401, 'с неверным паролем бан не раскрывается');
    const right = await post('/ru/login', { email: 'a@b.c', password: PASSWORD, csrf: csrfOf(html) });
    assert.equal(right.status, 403);
    assert.match(await right.text(), /заблокирован/i);
  });
});

test('неподтверждённый email попадает на экран подтверждения', async () => {
  const user = await activeUser({ email_confirmed: false });
  await withServer({ 'a@b.c': user }, {}, async ({ get, post, csrfOf }) => {
    const html = await (await get('/ru/login')).text();
    const res = await post('/ru/login', { email: 'a@b.c', password: PASSWORD, csrf: csrfOf(html) });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/ru/verify');
  });
});

// ─── Лимиты ───────────────────────────────────────────────────────────────────

test('после серии неудач включается невидимая проверка', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, {}, async ({ get, post, csrfOf }) => {
    for (let i = 0; i < AUTH.powAfterFailures; i++) {
      await post('/ru/login', { email: 'a@b.c', password: 'неверный', csrf: csrfOf(await (await get('/ru/login')).text()) });
    }
    const html = await (await get('/ru/login?email=a%40b.c')).text();
    assert.match(html, /data-challenge="/, 'задача должна попасть в форму');

    // Без решения вход не проходит, даже с верным паролем.
    const denied = await post('/ru/login', {
      email: 'a@b.c', password: PASSWORD, csrf: csrfOf(html),
    });
    assert.notEqual(denied.status, 303);
  });
});

test('решение задачи доводит вход до конца', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, {}, async ({ get, post, csrfOf }) => {
    for (let i = 0; i < AUTH.powAfterFailures; i++) {
      await post('/ru/login', { email: 'a@b.c', password: 'неверный', csrf: csrfOf(await (await get('/ru/login')).text()) });
    }
    const html = await (await get('/ru/login?email=a%40b.c')).text();
    const challenge = html.match(/data-challenge="([^"]+)"/)[1];
    const res = await post('/ru/login', {
      email: 'a@b.c', password: PASSWORD, csrf: csrfOf(html), pow: solve(challenge),
    });
    assert.equal(res.status, 303, 'с верным решением вход проходит');
  });
});

test('задержка отдаётся кодом 429 с Retry-After', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, {}, async ({ get, post, csrfOf }) => {
    // Задержка растёт по неверным паролям, а после трёх неудач включается
    // невидимая проверка. Значит парольные попытки дальше идут только
    // с решённой задачей — иначе задержка недостижима и 429 не наступает.
    for (let i = 0; i < AUTH.attemptsPerAccount + 2; i++) {
      const form = await (await get('/ru/login?email=a%40b.c')).text();
      const challenge = form.match(/data-challenge="([^"]+)"/)?.[1];
      await post('/ru/login', {
        email: 'a@b.c', password: 'неверный', csrf: csrfOf(form),
        pow: challenge ? solve(challenge) : '',
      });
    }
    const form = await (await get('/ru/login')).text();
    const res = await post('/ru/login', {
      email: 'a@b.c', password: PASSWORD, csrf: csrfOf(form),
    });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0, 'нужен Retry-After');
  });
});

test('задача включается раньше задержки', async () => {
  // Порядок важен: сначала дешёвая проверка, потом дорогая задержка.
  // Иначе человек ждал бы пять минут ради сообщения «неверный пароль».
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, {}, async ({ get, post, csrfOf }) => {
    for (let i = 0; i < AUTH.powAfterFailures; i++) {
      await post('/ru/login', {
        email: 'a@b.c', password: 'неверный',
        csrf: csrfOf(await (await get('/ru/login')).text()),
      });
    }
    const form = await (await get('/ru/login')).text();
    const challenge = form.match(/data-challenge="([^"]+)"/);
  });
});

// ─── Выход ────────────────────────────────────────────────────────────────────

test('выход отзывает сессию на сервере', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, {}, async ({ get, post, csrfOf }) => {
    const html = await (await get('/ru/login')).text();
    await post('/ru/login', { email: 'a@b.c', password: PASSWORD, csrf: csrfOf(html) });
    const out = await post('/ru/logout', {});
    assert.equal(out.status, 303);
    const cookies = out.headers.getSetCookie?.() ?? [];
    assert.ok(cookies.some((c) => c.startsWith('sid=;')), 'cookie очищается');
  });
});

// ─── Сессия как объект ────────────────────────────────────────────────────────

test('CSRF-токен переиспользуется в пределах сессии', () => {
  const session = {};
  const first = csrfToken(session);
  assert.equal(csrfToken(session), first, 'токен должен быть один на сессию');
  assert.ok(csrfValid(session, first));
  assert.equal(csrfValid(session, 'другой'), false);
  assert.equal(csrfValid({}, first), false);
});

test('сравнение CSRF устойчиво к длине', () => {
  const session = { csrf: 'abc' };
  assert.equal(csrfValid(session, 'abcd'), false);
  assert.equal(csrfValid(session, ''), false);
});

function solve(challenge) {
  for (let n = 0; n < 5_000_000; n++) {
    const h = crypto.createHash('sha256').update(challenge + n, 'utf8').digest('hex');
    if (h.startsWith('0'.repeat(AUTH.powZeros))) return String(n);
  }
  throw new Error('не нашлось решения');
}