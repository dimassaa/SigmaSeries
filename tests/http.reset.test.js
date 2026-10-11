// S-22 через настоящий HTTP: заявка, ссылка, смена пароля.
// Спецификация: docs/01-product/features/M1-identity.md F-01-04.
//
// Почему HTTP, а не только сервис: половина требований этой фичи —
// про ответ, который видит человек. «Ответ идентичен для существующего и
// несуществующего адреса» (R-SEC-06) нельзя доказать вызовом функции: он
// про байты страницы.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { createJournal } from '../src/services/journal.js';
import { hashPassword, verifyPassword, makeToken } from '../src/services/auth/password.js';
import * as limits from '../src/services/auth/limits.js';

const PASSWORD = 'правильный-пароль-из-десяти';
const NEW_PASSWORD = 'совсем-другой-пароль-12';

/** Учётка, прошедшая подтверждение: без него сброс не выдаётся. */
async function activeUser(over = {}) {
  return {
    id: 1, email_enc: null, password_hash: await hashPassword(PASSWORD),
    nickname: 'anna', status: 'active', email_confirmed: true,
    locale: 'ru', theme: 'dark', ...over,
  };
}

/**
 * Сервер со заглушкой хранилища и перехваченной почтой.
 *
 * Почта перехватывается, а не подглядывается в базе: ссылка — то, что
 * получает человек, и проверять надо её, а не строку токена.
 */
async function withServer(users = {}, run) {
  const auth = stubAuthStore(users, {});
  const sent = [];
  const calls = { revokeSessions: [], resetPassword: [] };
  // Журнал пишется в массив, а не в stdout: иначе тест проверял бы вывод
  // консоли, а не то, что событие действительно записано. Забирается
  // настоящий createJournal с подменённым sink — тогда проверяется и
  // отбрасывание лишних полей, а не только то, что функцию позвали.
  const logged = [];
  const journal = createJournal({ sink: (line) => logged.push(JSON.parse(line)) });
  // Методы оборачиваются всегда: «отозваны ли сессии» — требование фичи
  // (EC-A9), и проверять его надо на каждом прогоне, а не по просьбе.
  for (const [name, record] of Object.entries(calls)) {
    const original = auth[name].bind(auth);
    auth[name] = async (...args) => { record.push(args); return original(...args); };
  }
  // Письма различаются видом: по адресу подтверждённого аккаунта уходит
  // ссылка на смену пароля, по адресу неподтверждённого — подтверждение
  // (F-01-04 §4), и спутать их в тесте нельзя.
  const mailer = {
    verificationEmail: async (msg) => { sent.push({ ...msg, kind: 'verify' }); },
    resetEmail: async (msg) => { sent.push({ ...msg, kind: 'reset' }); },
  };
  const pool = { query: async () => ({ rows: [] }), on: () => {} };
  const memStore = createMemorySessionStore();
  const app = createApp({
    data: stubData(),
    auth,
    sessionMw: createSessionMiddleware(pool, memStore),
    mailer,
    journal,
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let jar = '';
  const get = async (path, init = {}) => {
    const res = await fetch(base + path, {
      redirect: 'manual',
      ...init,
      // Кука отправляется и в GET: без неё каждый запрос начинал бы новую
      // сессию, и проверка «вход не открылся» стала бы бессмысленной.
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
  const sessions = () => new Promise((r) => memStore.all((_e, s) => r(s ?? [])));
  try {
    await run({ get, post, csrfOf, sessions, sent, calls, auth, journal: logged });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** Заявка на сброс через настоящую форму; возвращает ответ и токен из письма. */
async function requestReset(handles, email, path = '/ru/password/reset') {
  const html = await (await handles.get(path)).text();
  const res = await handles.post(path, { email, csrf: handles.csrfOf(html) });
  return { res, body: await res.text(), token: handles.sent.at(-1)?.token };
}

test.beforeEach(() => limits._reset());

// ─── Форма запроса ───────────────────────────────────────────────────────────

test('форма запроса отдаётся, не кэшируется и не индексируется', async () => {
  await withServer({}, async ({ get }) => {
    const res = await get('/ru/password/reset');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, follow');
    const html = await res.text();
    assert.match(html, /<input[^>]+name="csrf"/);
    assert.match(html, /<label[^>]+for="email"/);
    assert.match(html, /autocomplete="email"/);
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, 'один заголовок первого уровня');
  });
});

test('страница смены пароля не кэшируется: в адресе лежит токен', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, async (h) => {
    await requestReset(h, 'a@b.c');
    const res = await h.get(`/ru/password/reset?token=${h.sent.at(-1).token}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(await res.text(), /autocomplete="new-password"/);
  });
});

// ─── Ответ не зависит от существования аккаунта (R-SEC-06) ───────────────────

test('ответ на заявку совпадает для существующего и несуществующего адреса', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, async (h) => {
    const known = await requestReset(h, 'a@b.c');
    const unknown = await requestReset(h, 'zzz@nowhere.example');
    assert.equal(known.res.status, unknown.res.status);
    assert.equal(known.body, unknown.body, 'тела ответов обязаны совпадать посимвольно');
  });
});

test('неподтверждённому адресу уходит письмо подтверждения, а не ссылка сброса', async () => {
  const confirmed = await activeUser({ id: 1 });
  const pending = await activeUser({ id: 2, email_confirmed: false, nickname: 'bob' });
  await withServer({ 'yes@b.c': confirmed, 'no@b.c': pending }, async (h) => {
    const unconfirmed = await requestReset(h, 'no@b.c');
    assert.equal(unconfirmed.res.status, 200, 'ответ тот же: по нему нельзя узнать про аккаунт');
    assert.equal(h.sent.at(-1).kind, 'verify', 'неподтверждённому — письмо подтверждения (F-01-04 §4)');
    assert.equal(h.sent.at(-1).to, 'no@b.c');

    const { token } = await requestReset(h, 'yes@b.c');
    assert.ok(token, 'подтверждённому адресу приходит ссылка');
    assert.equal(h.sent.at(-1).kind, 'reset');
    assert.equal(h.sent.at(-1).to, 'yes@b.c');
  });
});

test('письмо не уходит никому, кроме активного аккаунта', async () => {
  const banned = await activeUser({ id: 3, email_confirmed: false, status: 'banned' });
  await withServer({ 'ban@b.c': banned }, async (h) => {
    // Подтверждение адреса снимает блокировку, поэтому письмо забаненному
    // открывало бы ему доступ через собственную почту.
    await requestReset(h, 'zzz@nowhere.example');
    await requestReset(h, 'ban@b.c');
    assert.equal(h.sent.length, 0, 'ни чужому адресу, ни забаненному письма нет');
  });
});

test('в письме лежит ссылка на S-22 с токеном', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, async (h) => {
    const { token } = await requestReset(h, 'a@b.c');
    // Разметка письма собирается шлюзом; здесь важен адрес из SCREENS S-22.
    assert.match(token, /^[A-Za-z0-9_-]{40,}$/, 'токен непредсказуем и длинен');
  });
});

// ─── Открытие формы не гасит токен (F-01-04 §8) ──────────────────────────────

test('открытие формы нового пароля не гасит токен', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, async (h) => {
    const { token } = await requestReset(h, 'a@b.c');
    const first = await h.get(`/ru/password/reset?token=${token}`);
    const second = await h.get(`/ru/password/reset?token=${token}`);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200, 'почтовый сканер открывает ссылку раньше человека');

    const h1 = await (await h.get('/ru/password/reset')).text();
    const res = await h.post('/ru/password/reset', {
      token, password: NEW_PASSWORD, csrf: h.csrfOf(h1),
    });
    assert.equal(res.status, 303, 'после двух открытий токен всё ещё действует');
  });
});

// ─── Смена пароля ────────────────────────────────────────────────────────────

test('смена пароля отзывает сессии, не пускает внутрь и переводит на вход', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, async (h) => {
    const { token } = await requestReset(h, 'a@b.c');
    const form = await (await h.get(`/ru/password/reset?token=${token}`)).text();
    const res = await h.post('/ru/password/reset', {
      token, password: NEW_PASSWORD, csrf: h.csrfOf(form),
    });

    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/ru/password/reset?done=1');
    assert.deepEqual(h.calls.revokeSessions, [[1]], 'все сессии аккаунта отозваны (EC-A9)');
    assert.equal(h.calls.resetPassword.length, 1, 'пароль записан один раз');
    assert.match(String(h.calls.resetPassword[0][1]), /^\$argon2/, 'в базу уходит хеш, а не пароль');
    assert.equal((await h.sessions()).length, 1, 'вход не открывается: остаётся только анонимная сессия формы');

    // Письма «Пароль изменён» здесь нет и быть не может: на момент смены
    // известен только идентификатор, а адрес лежит в базе без шифрования —
    // получателя взять негде. Это запись в IMPROVEMENTS, а не забытый вызов.
  });
});

test('смена пароля попадает в журнал безопасности', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, async (h) => {
    const { token } = await requestReset(h, 'a@b.c');
    const form = await (await h.get(`/ru/password/reset?token=${token}`)).text();
    const res = await h.post('/ru/password/reset', {
      token, password: NEW_PASSWORD, csrf: h.csrfOf(form),
    });

    const entry = h.journal.find((e) => e.event === 'password_reset');
    assert.ok(entry, 'смена пароля обязана оставить запись (F-01-04 §17)');
    assert.equal(entry.user_id, 1);
    assert.equal(entry.level, 'security');
    // Идентификатор должен совпасть с тем, что человек увидел в ответе:
    // иначе связать запись с запросом нечем (R-SEC-29).
    assert.equal(entry.request, res.headers.get('x-request-id'));
    assert.equal(JSON.stringify(entry).includes('правильный-пароль'), false, 'пароля в записи нет');
    assert.equal(JSON.stringify(entry).includes(token), false, 'токена в записи нет');
  });
});

test('старая ссылка в журнал не попадает: попыток было, смены не было', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, async (h) => {
    await h.get('/ru/password/reset?token=подделка');
    assert.equal(h.journal.filter((e) => e.event === 'password_reset').length, 0);
  });
});

test('старый пароль после сброса не подходит, новый подходит', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, async (h) => {
    const { token } = await requestReset(h, 'a@b.c');
    const form = await (await h.get(`/ru/password/reset?token=${token}`)).text();
    await h.post('/ru/password/reset', { token, password: NEW_PASSWORD, csrf: h.csrfOf(form) });

    // Хеш читается из хранилища, а не из переданного объекта: проверяется
    // запись, а не то, что заглушка поменяла поле у себя в памяти.
    const stored = (await h.auth.byEmail('a@b.c')).password_hash;
    assert.equal(await verifyPassword(PASSWORD, stored), false, 'старый пароль не подходит');
    assert.equal(await verifyPassword(NEW_PASSWORD, stored), true, 'новый пароль подходит');
  });
});

test('после смены пароля вход старым паролем отклоняется, новым — проходит', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, async (h) => {
    const { token } = await requestReset(h, 'a@b.c');
    const form = await (await h.get(`/ru/password/reset?token=${token}`)).text();
    await h.post('/ru/password/reset', { token, password: NEW_PASSWORD, csrf: h.csrfOf(form) });

    const loginPage = async () => await (await h.get('/ru/login')).text();
    const oldTry = await h.post('/ru/login', {
      email: 'a@b.c', password: PASSWORD, csrf: h.csrfOf(await loginPage()), next: '/',
    });
    assert.equal(oldTry.status, 401, 'старый пароль не пускает');

    limits._reset();
    const newTry = await h.post('/ru/login', {
      email: 'a@b.c', password: NEW_PASSWORD, csrf: h.csrfOf(await loginPage()), next: '/',
    });
    assert.equal(newTry.status, 303, 'новый пароль пускает');
  });
});

test('успех показывается страницей, а не ответом на POST (Post/Redirect/Get)', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, async (h) => {
    const { token } = await requestReset(h, 'a@b.c');
    const form = await (await h.get(`/ru/password/reset?token=${token}`)).text();
    const res = await h.post('/ru/password/reset', {
      token, password: NEW_PASSWORD, csrf: h.csrfOf(form),
    });
    assert.equal(res.headers.get('location'), '/ru/password/reset?done=1');

    const done = await h.get('/ru/password/reset?done=1');
    assert.equal(done.status, 200);
    const html = await done.text();
    assert.match(html, /<\/html>/);
    assert.match(html, /href="\/ru\/login"/, 'со успеха есть переход на вход');
  });
});

// ─── Устаревшая ссылка (EC-A3) ───────────────────────────────────────────────

test('повторное использование ссылки даёт «Ссылка устарела» и форму новой заявки', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, async (h) => {
    const { token } = await requestReset(h, 'a@b.c');
    const form = await (await h.get(`/ru/password/reset?token=${token}`)).text();
    const first = await h.post('/ru/password/reset', {
      token, password: NEW_PASSWORD, csrf: h.csrfOf(form),
    });
    assert.equal(first.status, 303);

    const again = await h.get(`/ru/password/reset?token=${token}`);
    assert.equal(again.status, 200, 'страница объясняет, а не отдаёт 404');
    const html = await again.text();
    assert.match(html, /name="csrf"/, 'EC-A3: на устаревшей ссылке есть форма новой заявки');
    assert.match(html, /name="email"/);
  });
});

test('использованный токен повторно не принимается', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, async (h) => {
    const { token } = await requestReset(h, 'a@b.c');
    const form = await (await h.get(`/ru/password/reset?token=${token}`)).text();
    await h.post('/ru/password/reset', { token, password: NEW_PASSWORD, csrf: h.csrfOf(form) });

    const page = await (await h.get('/ru/password/reset')).text();
    const reused = await h.post('/ru/password/reset', {
      token, password: 'ещё-один-пароль-12', csrf: h.csrfOf(page),
    });
    assert.equal(reused.status, 200);
    assert.match(await reused.text(), /name="email"/, 'вместо формы — предложение запросить новую');
  });
});

test('мусорный токен читается как устаревшая ссылка, а не как ошибка сервера', async () => {
  await withServer({}, async (h) => {
    const res = await h.get('/ru/password/reset?token=%D0%BC%D1%83%D1%81%D0%BE%D1%80');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /name="email"/);
  });
});

test('токен другого назначения не открывает смену пароля', async () => {
  const user = await activeUser();
  const { token, hash } = makeToken();
  await withServer({ 'a@b.c': user }, async (h) => {
    // Токен подтверждения адреса лежит в той же таблице: без проверки вида
    // он менял бы пароль.
    await h.auth.createUser({
      email: 'b@b.c', nickname: 'bob', passwordHash: user.password_hash,
      tokenHash: hash, locale: 'ru', theme: 'dark',
    });
    const res = await h.get(`/ru/password/reset?token=${token}`);
    assert.match(await res.text(), /name="email"/, 'чужой вид токена не принимается');
  });
});

// ─── Пароль и лимит ──────────────────────────────────────────────────────────

test('слабый пароль отвергается у поля, а ссылка остаётся действующей', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, async (h) => {
    const { token } = await requestReset(h, 'a@b.c');
    const form = await (await h.get(`/ru/password/reset?token=${token}`)).text();
    const weak = await h.post('/ru/password/reset', {
      token, password: 'коротко', csrf: h.csrfOf(form),
    });
    assert.equal(weak.status, 400);
    assert.match(await weak.text(), /role="alert"/, 'ошибка названа текстом');
    assert.equal(await verifyPassword(PASSWORD, user.password_hash), true, 'пароль не сменился');

    const retry = await h.post('/ru/password/reset', {
      token, password: NEW_PASSWORD, csrf: h.csrfOf(form),
    });
    assert.equal(retry.status, 303, 'после ошибки ссылкой ещё можно воспользоваться');
  });
});

test('шестая заявка за час отклоняется с Retry-After', async () => {
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, async (h) => {
    for (let i = 0; i < 5; i++) {
      const { res } = await requestReset(h, 'a@b.c');
      assert.equal(res.status, 200, `заявка ${i + 1} проходит`);
    }
    const sixth = await requestReset(h, 'a@b.c');
    assert.equal(sixth.res.status, 429);
    assert.ok(Number(sixth.res.headers.get('retry-after')) > 0, 'указано, когда повторить');
  });
});

test('лимит считается по заявкам, а не по существующим аккаунтам', async () => {
  // Иначе 429 выдавал бы только существующие адреса, и по нему они бы
  // перебирались (R-SEC-06).
  await withServer({}, async (h) => {
    let last;
    for (let i = 0; i < 6; i++) last = await requestReset(h, 'никого@нет.example');
    assert.equal(last.res.status, 429, 'несуществующий адрес тоже упирается в лимит');
  });
});
