// Смена email внутри раздела «Безопасность» (F-01-06 §4, §5).
//
// Проверяется то, что отличает смену от простой правки профиля:
//
//   • письмо уходит на НОВЫЙ адрес, и старый остаётся рабочим до
//     подтверждения — иначе запись на старый адрес перестала бы работать
//     раньше, чем человек доказал владение новым;
//   • занятый адрес даёт тот же ответ, что и свободный, а письмо получает
//     владелец занятого (EC-A15);
//   • применяется только по ссылке из письма, а не сразу.
//
// Ответ проверяется посимвольно: по формулировке иначе перебираются адреса.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';

const PASSWORD = 'правильный-пароль-из-десяти';
const NEW_EMAIL = 'novyy@example.com';

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

/** Сервер со входом и очередью писем, которая только запоминает. */
async function withServer({ user, extra = [], run }) {
  const accounts = { [user.email]: user };
  for (const other of extra) accounts[other.email] = other;

  const auth = stubAuthStore(accounts);
  const queued = [];
  const memStore = createMemorySessionStore();
  const app = createApp({
    data: stubData(),
    auth,
    // createApp объявляет middleware сессий функцией, а модуль отдаёт обработчик
    // или их пару — Express принимает и то и другое.
    sessionMw: /** @type {Function} */ (createSessionMiddleware({ query: async () => ({ rows: [] }), on: () => {} }, memStore)),
    journal: { security: () => {} },
    mailQueue: { async enqueue(job) { queued.push(job); return queued.length; } },
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
  const post = (path, fields) => get(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

  const login = await (await get('/ru/login')).text();
  await post('/ru/login', { email: user.email, password: PASSWORD, csrf: csrfOf(login) });

  try {
    await run({ get, post, csrfOf, user, auth, queued });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** Заявка на смену адреса с формы «Безопасность». */
async function requestChange(h, email, password = PASSWORD) {
  const form = await (await h.get('/ru/settings/security')).text();
  return h.post('/ru/settings/security', {
    action: 'email', email, password, csrf: h.csrfOf(form),
  });
}

/**
 * Адрес страницы и токен из ссылки письма.
 *
 * Ссылка приходит относительной — `baseUrl` в тесте не задан, и `new URL`
 * без базы её не разбирает. Страница открывается по ссылке целиком, вместе с
 * `?token=`: без токена в адресе она отдаёт «ссылка устарела», а не форму.
 */
function linkOf(job) {
  const [path, query = ''] = String(job.link).split('?');
  return {
    href: query ? `${path}?${query}` : path,
    path,
    token: new URLSearchParams(query).get('token'),
  };
}

// ─── Заявка ─────────────────────────────────────────────────────────────────

test('смена email требует текущий пароль', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, queued }) => {
      const res = await requestChange({ get, post, csrfOf }, NEW_EMAIL, 'не-текущий-пароль-1');

      assert.equal(res.status, 400, 'без верного пароля адрес не меняется');
      assert.equal(queued.length, 0, 'письмо не отправлялось');
      assert.match(await res.text(), /парол/i, 'человеку сказано, что не так');
    },
  });
});

test('письмо о смене уходит на новый адрес, а не на старый', async () => {
  // §4: письмо на новый адрес. На старый — отдельное уведомление о том, что
  // адрес меняют: иначе человек узнает о смене, только потеряв доступ.
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, queued }) => {
      const res = await requestChange({ get, post, csrfOf }, NEW_EMAIL);

      assert.equal(res.status, 303, 'заявка принята');
      const toNew = queued.filter((job) => job.to === NEW_EMAIL);
      assert.equal(toNew.length, 1, 'на новый адрес ушло письмо');
      assert.equal(toNew[0].kind, 'email_change', 'это подтверждение смены');

      const toOld = queued.filter((job) => job.to === 'anna@example.com');
      assert.equal(toOld.length, 1, 'на старый адрес ушло уведомление');
      assert.equal(toOld[0].kind, 'email_change_requested', 'это уведомление, а не ссылка');
    },
  });
});

test('старый адрес работает до подтверждения, новый — нет', async () => {
  // Пока человек не доказал владение новым адресом, аккаунт остаётся на
  // старом: иначе подтверждение незнакомого адреса отнимало бы аккаунт.
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, auth }) => {
      await requestChange({ get, post, csrfOf }, NEW_EMAIL);

      assert.ok(await auth.byEmail('anna@example.com'), 'старый адрес работает');
      assert.equal(await auth.byEmail(NEW_EMAIL), null, 'новый адрес ещё не работает');
    },
  });
});

test('занятый адрес даёт тот же ответ, что и свободный (EC-A15)', async () => {
  // R-SEC-06: по ответу нельзя определить, что адрес занят. Письмо на новый
  // адрес не уходит, уведомление получает владелец занятого.
  const user = await viewer();
  const stranger = await viewer({ id: 21, email: NEW_EMAIL, nickname: 'other' });

  let freeBody;
  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const free = await requestChange({ get, post, csrfOf }, 'svободный@example.com');
      freeBody = await free.text();
    },
  });

  await withServer({
    user,
    extra: [stranger],
    run: async ({ get, post, csrfOf, queued }) => {
      const taken = await requestChange({ get, post, csrfOf }, NEW_EMAIL);
      const takenBody = await taken.text();

      assert.equal(taken.status, 303, 'тот же код ответа');
      assert.equal(takenBody, freeBody, 'тело ответа совпадает посимвольно');
      assert.equal(
        queued.filter((job) => job.to === NEW_EMAIL && job.kind === 'email_change').length,
        0,
        'на занятый адрес письмо со ссылкой не уходит',
      );
      assert.equal(
        queued.filter((job) => job.to === NEW_EMAIL && job.kind === 'email_taken').length,
        1,
        'владелец занятого адреса получил уведомление',
      );
    },
  });
});

test('непригодный адрес отвергается до постановки в очередь', async () => {
  // F-01-12 §5: невалидный адрес получателя — отказ до постановки в очередь.
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, queued }) => {
      const res = await requestChange({ get, post, csrfOf }, 'не-адрес');

      assert.equal(res.status, 400, 'мусорный адрес отвергнут');
      assert.equal(queued.length, 0, 'письмо не отправлялось');
    },
  });
});

// ─── Подтверждение по ссылке ────────────────────────────────────────────────

test('по ссылке из письма адрес применяется, старый перестаёт работать', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, auth, queued }) => {
      await requestChange({ get, post, csrfOf }, NEW_EMAIL);
      const { href, path, token } = linkOf(queued[0]);
      const form = await (await get(href)).text();
      const res = await post(path, { token, csrf: csrfOf(form) });

      assert.equal(res.status, 303, 'адрес применён');
      assert.ok(await auth.byEmail(NEW_EMAIL), 'новый адрес работает');
      assert.equal(await auth.byEmail('anna@example.com'), null, 'старый больше не работает');
    },
  });
});

test('ссылка без токена не предлагает подтверждать', async () => {
  // Обрезанная или старая ссылка приходит без токена (EC-A3). Кнопки нет:
  // нажатие всё равно кончилось бы «ссылка не работает».
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get }) => {
      const page = await (await get('/ru/settings/email-change')).text();

      assert.equal(page.includes('name="token"'), false, 'токен в форму не попал');
      assert.match(page, /больше не работает/, 'сказано, что ссылка недействительна');
    },
  });
});

test('пустой токен не применяется', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, auth, queued }) => {
      await requestChange({ get, post, csrfOf }, NEW_EMAIL);
      const { href } = linkOf(queued[0]);

      // CSRF берётся со страницы, где форма есть: иначе отказ был бы от
      // проверки CSRF, а проверку токена тест бы не испытал.
      const form = await (await get(href)).text();
      const res = await post('/ru/settings/email-change', { token: '', csrf: csrfOf(form) });

      assert.equal(res.status, 200, 'страница с отказом, а не редирект');
      assert.ok(await auth.byEmail('anna@example.com'), 'адрес не тронут');
    },
  });
});

test('чужой или поддельный токен не применяется', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, auth, queued }) => {
      await requestChange({ get, post, csrfOf }, NEW_EMAIL);
      const { href } = linkOf(queued[0]);

      const { token } = makeToken();
      const form = await (await get(href)).text();
      const res = await post('/ru/settings/email-change', { token, csrf: csrfOf(form) });

      assert.equal(res.status, 200, 'отказ, а не применение адреса');
      assert.ok(await auth.byEmail('anna@example.com'), 'адрес не тронут');
    },
  });
});

test('использованный токен второй раз не применяется', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, auth, queued }) => {
      await requestChange({ get, post, csrfOf }, NEW_EMAIL);
      const { href, path, token } = linkOf(queued[0]);
      const form = await (await get(href)).text();
      assert.equal((await post(path, { token, csrf: csrfOf(form) })).status, 303);

      const again = await (await get(href)).text();
      const res = await post(path, { token, csrf: csrfOf(again) });
      assert.equal(res.status, 200, 'второй раз тот же токен не применяется');
      assert.ok(await auth.byEmail(NEW_EMAIL), 'адрес остался прежним');
    },
  });
});

test('после применения на старый адрес уходит уведомление', async () => {
  // Без него человек узнаёт о смене, только потеряв вход, — а потеря входа
  // выглядит как взлом.
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, queued }) => {
      await requestChange({ get, post, csrfOf }, NEW_EMAIL);
      const { href, path, token } = linkOf(queued[0]);
      const form = await (await get(href)).text();
      await post(path, { token, csrf: csrfOf(form) });

      const old = queued.filter((job) => job.to === 'anna@example.com');
      assert.equal(
        old.some((job) => job.kind === 'email_changed'), true,
        'на старый адрес ушло уведомление о смене',
      );
    },
  });
});

test('новая заявка отменяет незавершённую предыдущую', async () => {
  // Две смены подряд: подтверждается только последняя. Иначе подтверждение
  // старой заявки применило бы адрес, который человек уже передумал.
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, auth, queued }) => {
      await requestChange({ get, post, csrfOf }, 'pervyy@example.com');
      const first = linkOf(queued[0]).token;

      await requestChange({ get, post, csrfOf }, NEW_EMAIL);
      const latest = linkOf(queued.filter((job) => job.kind === 'email_change').at(-1));

      const form = await (await get(latest.href)).text();
      await post(latest.path, { token: latest.token, csrf: csrfOf(form) });
      assert.ok(await auth.byEmail(NEW_EMAIL), 'применился последний адрес');

      const stale = await (await get('/ru/settings/security')).text();
      const res = await post('/ru/settings/email-change', {
        token: first, csrf: csrfOf(stale),
      });
      assert.notEqual(res.status, 303, 'прежняя заявка больше не действует');
      assert.ok(await auth.byEmail(NEW_EMAIL), 'адрес не откатился на прежний');
    },
  });
});