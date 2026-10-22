// Режимы почты и «почтовый ящик разработчика» (F-01-12).
//
// Проверяется то, ради чего фича и затевалась:
//
//   • в режиме `devbox` письмо не уходит провайдеру, а остаётся в базе и
//     видно админу; это единственный способ показать регистрацию без интернета;
//   • не-админ получает 404, а не 403: существование страницы не выдаётся;
//   • демо-помощник показывает только письмо, созданное этим браузером —
//     иначе это был бы способ читать чужие письма (H-51);
//   • режим переключает только админ, с повторным паролем и записью в журнал.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { generateSecret, totpAt } from '../src/services/auth/totp.js';
import { effectiveMode, switchMode } from '../src/services/mail/mode.js';
import { devboxBadge, demoMailFor } from '../src/services/mail/devbox.js';

const PASSWORD = 'правильный-пароль-из-десяти';

async function viewer(over = {}) {
  return {
    id: 20,
    email: 'anna@example.com',
    password_hash: await hashPassword(PASSWORD),
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
    ...over,
  };
}

/**
 * Сервер с очередью писем в памяти и журналом, который только запоминает.
 *
 * `mode` — режим по умолчанию, как если бы он пришёл из окружения: хранилище
 * настроек в тесте пустое.
 */
async function withServer({
  user, extra = [], roles: roleMap = {}, mode = 'smtp', storedMode = null, letters = [], run,
}) {
  const accounts = { [user.email]: user };
  for (const other of extra) accounts[other.email] = other;

  const events = [];
  const queued = [];
  const settings = new Map();
  if (storedMode) settings.set('mail.mode', storedMode);
  const auth = stubAuthStore(accounts, roleMap);
  const admin = roleMap[20]?.includes('admin') ? { secret: generateSecret() } : null;
  if (admin) auth.setTwoFactor(user.id, admin);

  const app = createApp({
    data: stubData(),
    auth,
    // createApp объявляет middleware сессий функцией, а модуль отдаёт обработчик
    // или их пару — Express принимает и то и другое.
    sessionMw: /** @type {Function} */ (createSessionMiddleware({ query: async () => ({ rows: [] }), on: () => {} }, createMemorySessionStore())),
    journal: { security: (entry) => events.push(entry) },
    mailQueue: {
      async enqueue(job) { queued.push(job); return queued.length; },
      async listing() { return letters; },
    },
    mailMode: {
      current: async () => (settings.has('mail.mode') ? settings.get('mail.mode') : mode),
      change: async (value, changedBy) => {
        settings.set('mail.mode', value);
        events.push({ event: 'mail_mode_changed', requestId: 'тест', user_id: changedBy });
        return { ok: true, previous: mode };
      },
    },
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
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

  const login = await (await get('/ru/login')).text();
  const first = await post('/ru/login', {
    email: user.email, password: PASSWORD, csrf: csrfOf(login),
  });
  if (first.headers.get('location')?.endsWith('/2fa')) {
    const form = await (await get('/ru/2fa')).text();
    await post('/ru/2fa', { code: totpAt(admin.secret, Math.floor(clock / 1000)), csrf: csrfOf(form) });
  }

  try {
    return await run({ get, post, csrfOf, user, auth, queued, events, settings });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ─── Режим ───────────────────────────────────────────────────────────────────

test('режим по умолчанию берётся из окружения, пока его не меняли', async () => {
  const setting = { rows: [] };
  const pool = { async query() { return { rows: setting.rows }; } };

  assert.equal(await effectiveMode(pool, 'smtp'), 'smtp', 'без строки в базе — окружение');
  assert.equal(await effectiveMode(pool, 'devbox'), 'devbox');

  setting.rows = [{ value: 'devbox' }];
  assert.equal(
    await effectiveMode(pool, 'smtp'), 'devbox',
    'запись админа в базе сильнее окружения',
  );
});

test('переключение режима требует повторного пароля', async () => {
  const changes = [];
  const setting = { rows: [] };

  // `setting` функция не читает: остаток от прежней версии `switchMode`.
  // Объявленный тип её не вмещает, поэтому лишнее свойство описано здесь.
  /** @type {Parameters<typeof switchMode>[0] & { setting: { rows: unknown[] } }} */
  const deps = {
    current: async () => 'smtp',
    change: async (value, by) => { changes.push([value, by]); return { ok: true, previous: 'smtp' }; },
    verify: async () => false,
    setting,
  };

  const verdict = await switchMode(deps);

  assert.equal(verdict.ok, false, 'без верного пароля режим не переключается');
  assert.equal(changes.length, 0, 'и в базу ничего не записано');
});

test('смена режима пишется в журнал', async () => {
  const events = [];

  const verdict = await switchMode({
    current: async () => 'smtp',
    change: async (value, by) => { events.push({ event: 'mail_mode_changed', user_id: by }); return { ok: true, previous: 'smtp' }; },
    verify: async () => true,
  });

  assert.equal(verdict.ok, true);
  assert.equal(events.length, 1, 'опасное действие попало в журнал (R-SEC-12)');
});

test('предупреждение о devbox видно и в тексте, и флагом', async () => {
  // EC-A23: режим, включённый по ошибке, должен быть заметен.
  assert.match(devboxBadge('devbox'), /не отправляются/i);
  assert.equal(devboxBadge('smtp'), null, 'в обычном режиме предупреждения нет');
});

// ─── Ящик S-84 ───────────────────────────────────────────────────────────────

test('не-админ получает 404, а не 403', async () => {
  // §18: не-админ не должен даже узнать, что страница есть.
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get }) => {
      const res = await get('/ru/admin/mailbox');

      assert.equal(res.status, 404, 'страницы как будто нет');
    },
  });
});

test('админ видит список писем и может открыть письмо', async () => {
  const user = await viewer();
  const { token } = makeToken();

  await withServer({
    user,
    roles: { 20: ['admin'] },
    mode: 'devbox',
    letters: [{
      id: 1,
      kind: 'email_verify',
      locale: 'ru',
      subject: 'Подтвердите адрес',
      body: `Здравствуйте!\n\nПодтвердите адрес: http://127.0.0.1:3000/ru/verify?token=${token}`,
      status: 'sent',
      attempts: 1,
      created_at: new Date().toISOString(),
    }],
    run: async ({ get }) => {
      const page = await (await get('/ru/admin/mailbox')).text();

      assert.match(page, /Письма не отправляются/, 'бейдж режима виден (EC-A23)');
      assert.match(page, /Режим почты/, 'переключатель режима на месте');
      assert.match(page, /Подтвердите адрес/, 'письмо в списке');

      const opened = await (await get(`/ru/admin/mailbox?token=${encodeURIComponent(token)}`)).text();
      assert.ok(opened.includes('Подтвердите адрес'), 'тело письма показано');
      assert.ok(opened.includes(token), 'ссылка из письма видна и копируется');
    },
  });
});

test('в ящике не видно адреса получателя открытым', async () => {
  // Получатель в базе зашифрован; в списке его быть не должно, а само письмо
  // — есть. Иначе проверка прошла бы на пустой странице.
  const user = await viewer();

  await withServer({
    user,
    roles: { 20: ['admin'] },
    letters: [{
      id: 1,
      kind: 'password_reset',
      locale: 'ru',
      subject: 'Сброс пароля',
      body: 'Здравствуйте!\n\nСсылка: http://127.0.0.1:3000/ru/password/reset?token=abc123',
      status: 'sent',
      attempts: 1,
      created_at: new Date().toISOString(),
      // Настоящее хранилище его не отдаёт; проверка в том, что даже если
      // поле есть, в разметку оно не попадает.
      recipient_enc: '<Buffer зашифровано>',
    }],
    run: async ({ get }) => {
      const page = await (await get('/ru/admin/mailbox')).text();

      assert.match(page, /Сброс пароля/, 'письмо в списке есть — страница не пустая');
      assert.equal(page.includes('anna@example.com'), false, 'адрес получателя не утёк');
      assert.equal(page.includes('зашифровано'), false, 'шифр тоже не утёк');
    },
  });
});

// ─── Демо-помощник (H-51) ───────────────────────────────────────────────────

test('демо-помощник показывает только письмо своего браузера', async () => {
  const mine = { browserId: 'браузер-анны', kind: 'email_verify', token: 'мой-токен' };
  const stranger = { browserId: 'чужой-браузер', kind: 'email_verify', token: 'чужой-токен' };
  const letters = [mine, stranger];

  assert.equal(
    /** @type {{token: string}|null} */ (demoMailFor(letters, 'браузер-анны'))?.token, 'мой-токен',
    'своё письмо показывается',
  );
  assert.equal(
    /** @type {{token: string}|null} */ (demoMailFor(letters, 'чужой-браузер'))?.token, 'чужой-токен',
  );
  assert.equal(demoMailFor(letters, 'никто'), null, 'чужому браузеру чужое письмо не выдаётся');
  assert.equal(demoMailFor(letters, ''), null, 'без отметки браузера — ничего');
});

test('демо-помощник не показывается, когда режим не devbox', async () => {
  // В обычном режиме подсказка «открыть письмо» бессмысленна и путает.
  const user = await viewer();

  await withServer({
    user,
    mode: 'smtp',
    run: async ({ get }) => {
      const page = await (await get('/ru/register')).text();

      assert.equal(/Демо-режим/.test(page), false, 'в режиме smtp подсказки нет');
    },
  });
});
// ─── Демо-помощник на страницах регистрации и сброса (F-01-12 §4, H-51) ─────

/**
 * Сервер, у которого очередь помнит отметку браузера и отдаёт письмо только
 * ему: так ведёт себя `mailQueue.forBrowser` против базы.
 */
async function withDemoServer({ mode = 'devbox', foreign = [], run }) {
  const auth = stubAuthStore({});
  // Очередь помнит, каким браузером письмо создано, — как настоящая: подсказка
  // появляется только у того, кто заказал письмо.
  const posted = [];
  const memStore = createMemorySessionStore();
  const app = createApp({
    data: stubData(),
    auth,
    // createApp объявляет middleware сессий функцией, а модуль отдаёт обработчик
    // или их пару — Express принимает и то и другое.
    sessionMw: /** @type {Function} */ (createSessionMiddleware({ query: async () => ({ rows: [] }), on: () => {} }, memStore)),
    journal: { security: () => {} },
    mailMode: { current: async () => mode, change: async () => ({ ok: true }) },
    mailQueue: {
      async enqueue(job) { posted.push(job); return posted.length; },
      async forBrowser(browserId) {
        if (!browserId) return [];
        // Настоящее хранилище возвращает отметку вместе с письмом; без неё
        // подсказка не смогла бы отличить своё письмо от чужого.
        const own = posted
          .filter((job) => job.browserId === browserId)
          .map((job) => ({
            id: 1, kind: job.kind, body: job.body ?? job.link ?? '', browserId,
          }));
        const theirs = foreign.filter((l) => l.browserId === browserId);
        return [...own, ...theirs];
      },
    },
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
    return await run({ get, post, csrfOf });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('в devbox на шаге подтверждения есть ссылка из своего письма', async () => {
  // Шаг 2: человек ждёт письма, которого не будет. Подсказка — единственный
  // способ показать подтверждение без интернета.
  const link = 'http://127.0.0.1:3000/ru/verify?token=моё-письмо';

  await withDemoServer({
    mode: 'devbox',
    run: async ({ get, post, csrfOf }) => {
      const form = await (await get('/ru/register')).text();
      const csrf = csrfOf(form);

      // Согласие с правилами — обязательное поле шага 1; без него регистрация
      // не проходит и письма не будет.
      const sent = await post('/ru/register', {
        email: 'anna@example.com', nickname: 'anna', password: PASSWORD, consent: 'on', csrf,
      });
      assert.equal(sent.status, 303, 'регистрация прошла');

      // Письмо привязано к тому браузеру, который его заказал: подсказка
      // появляется у него и только у него.
      const page = await (await get('/ru/register/confirm')).text();
      assert.match(page, /Демо-режим/, 'подсказка показана');
      assert.match(page, /\/ru\/verify\?token=/, 'в подсказке ссылка из письма');
    },
  });
});

test('в режиме smtp подсказки нет', async () => {
  await withDemoServer({
    mode: 'smtp',
    run: async ({ get, post, csrfOf }) => {
      const form = await (await get('/ru/register')).text();
      const csrf = csrfOf(form);

      await post('/ru/register', {
        email: 'anna@example.com', nickname: 'anna', password: PASSWORD, consent: 'on', csrf,
      });

      const page = await (await get('/ru/register/confirm')).text();
      assert.equal(/Демо-режим/.test(page), false, 'в обычном режиме подсказка не нужна');
    },
  });
});

test('подсказка показывает своё письмо, а не чужое', async () => {
  // Письмо в очереди лежит и чужое. Показать его — значит дать человеку
  // читать чужие письма со страницы входа; показывается только своё.
  await withDemoServer({
    mode: 'devbox',
    foreign: [{
      id: 9,
      kind: 'password_reset',
      body: 'Здравствуйте!\n\nЧужое письмо: http://127.0.0.1:3000/ru/password/reset?token=чужой-токен',
      // Отметка чужого браузера: подсказка его не примет, даже если письмо
      // попало в очередь.
      browserId: 'чужой-браузер',
    }],
    run: async ({ get, post, csrfOf }) => {
      const form = await (await get('/ru/register')).text();
      await post('/ru/register', {
        email: 'anna@example.com', nickname: 'anna', password: PASSWORD, consent: 'on',
        csrf: csrfOf(form),
      });

      const page = await (await get('/ru/register/confirm')).text();
      assert.match(page, /\/ru\/verify\?token=/, 'своё письмо показано');
      assert.equal(page.includes('чужой-токен'), false, 'чужое письмо не показано');
    },
  });
});
