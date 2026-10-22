// S-20 и S-21 через настоящий HTTP: регистрация, подтверждение, отказы.
//
// Спецификация: docs/01-product/features/M1-identity.md F-01-01, F-01-02.
// Требования: R-SEC-06, R-SEC-07, R-SEC-13, R-SEC-31, R-DES-34.
// Edge cases: EC-A1, EC-A2, EC-A4, EC-A5, EC-A16.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import * as limits from '../src/services/auth/limits.js';
import { AUTH } from '../src/config/settings.js';

const PASSWORD = 'правильный-пароль-из-десяти';

/** Тот же хеш, что считает сервер, — иначе тест проверяет не то. */
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Очередь, которая только запоминает.
 *
 * Подменяется очередь, а не шлюз: маршрут кладёт письмо в очередь и сразу
 * отвечает человеку, а отправка — дело работника. Работа самой очереди
 * проверяется в `tests/mail.queue.test.js` против настоящей базы.
 */
function recordingQueue() {
  const sent = [];
  return {
    sent,
    async enqueue(job) { sent.push(job); return sent.length; },
  };
}

/**
 * Токен из поставленного письма.
 *
 * В письме лежит готовая ссылка, а не токен: получатель видит именно её, и
 * тест должен знать ровно то же, что знает он.
 */
function tokenOf(mail) {
  return mail.link.split('?token=')[1];
}

/** То же, что выше, но в виде объекта — там, где тесту нужен `{token}`. */
function verifyTokenOf(mail) {
  return { token: tokenOf(mail) };
}

function makeApp(users = {}) {
  const pool = { query: async () => ({ rows: [] }), on: () => {} };
  return createApp({
    data: stubData(),
    auth: stubAuthStore(users),
    // createApp объявляет middleware сессий функцией, а модуль отдаёт обработчик
    // или их пару — Express принимает и то и другое.
    sessionMw: /** @type {any} */ (createSessionMiddleware(pool, createMemorySessionStore())),
    mailQueue: recordingQueue(),
  });
}

async function withServer(run, users = {}) {
  const mailQueue = recordingQueue();
  const pool = { query: async () => ({ rows: [] }), on: () => {} };
  const auth = stubAuthStore(users);
  const app = createApp({
    data: stubData(),
    auth,
    // createApp объявляет middleware сессий функцией, а модуль отдаёт обработчик
    // или их пару — Express принимает и то и другое.
    sessionMw: /** @type {any} */ (createSessionMiddleware(pool, createMemorySessionStore())),
    mailQueue,
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let jar = '';

  /** Отдельная cookie-корзина = отдельный браузер. */
  function browser() {
    let own = '';
    const send = async (path, init = {}) => {
      const res = await fetch(base + path, {
        redirect: 'manual',
        ...init,
        headers: { cookie: own, ...(init.headers ?? {}) },
      });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) own = set.map((c) => c.split(';')[0]).join('; ');
      return res;
    };
    return {
      send,
      get: (path) => send(path),
      post: (path, fields, init = {}) => send(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(init.headers ?? {}) },
        body: new URLSearchParams(fields),
        ...init,
      }),
      /** CSRF из формы — так его видит и человек, и робот. */
      csrfOf: (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1],
    };
  }

  const main = browser();
  const get = main.get;
  const post = main.post;
  const csrfOf = main.csrfOf;

  try {
    await run({ get, post, csrfOf, browser, mailQueue, auth });
  } finally {
    limits._reset();
    await /** @type {Promise<void>} */ (new Promise((r) => server.close(r)));
  }
}

/**
 * Решает невидимую проверку так же, как это делает браузер.
 *
 * Возвращает undefined, если задачи на странице нет: тогда форма
 * отправляется без поля, и это тоже правильное поведение.
 */
function solveChallenge(page) {
  const challenge = page.match(/data-challenge="([^"]+)"/)?.[1];
  if (!challenge) return undefined;
  const zeros = Number(page.match(/data-zeros="(\d+)"/)?.[1] ?? 3);
  for (let nonce = 0; ; nonce++) {
    if (sha256(challenge + nonce).startsWith('0'.repeat(zeros))) return String(nonce);
  }
}

/**
 * Заполняет шаг 1.
 *
 * Задача, если она есть, решается автоматически — иначе тест проверял бы
 * не регистрацию, а обход невидимой проверки. Явно переданное `pow`
 * используется как есть: так проверяется отказ без решения.
 *
 * При успехе страница шага 2 запрашивается отдельным запросом: ответ 303
 * тела страницы не содержит, и проверять содержимое по нему бессмысленно.
 */
async function register(client, overrides = {}) {
  const page = await (await client.get('/ru/register')).text();
  const fields = {
    csrf: client.csrfOf(page),
    email: 'anna@example.com',
    nickname: 'anna',
    password: PASSWORD,
    consent: 'on',
    timezone: 'Europe/Minsk',
    ...overrides,
    pow: 'pow' in overrides ? overrides.pow : solveChallenge(page),
  };
  const res = await client.post('/ru/register', fields);
  const body = await res.text();
  const followed = res.status === 303
    ? await (await client.get(res.headers.get('location'))).text()
    : body;
  return { res, page: followed, body, fields };
}

// ─── Шаг 1 ───────────────────────────────────────────────────────────────────

test('страница регистрации открывается и содержит все поля', async () => {
  await withServer(async (c) => {
    const res = await c.get('/ru/register');
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('x-robots-tag'), /noindex/, 'служебная страница не индексируется');
    for (const id of ['email', 'nickname', 'password', 'consent']) {
      assert.ok(html.includes(`id="${id}"`), `нет поля ${id}`);
    }
    assert.match(html, /Шаг 1 из 3/, 'R-DES-34: показан прогресс шагов');
  });
});

test('личные страницы не кэшируются (R-SEC-24)', async () => {
  // Иначе на общем компьютере следующий человек увидит из кеша заполненную
  // форму и адрес из неё, не заходя в аккаунт.
  await withServer(async (c) => {
    for (const path of ['/ru/login', '/ru/register']) {
      const res = await c.get(path);
      assert.equal(res.headers.get('cache-control'), 'no-store', path);
    }
  });
});

test('успешная регистрация ведёт на шаг 2 и отправляет письмо', async () => {
  await withServer(async (c) => {
    const { res, page } = await register(c);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/ru/register/confirm');
    assert.match(page, /anna@example\.com/);
    assert.match(page, /Шаг 2 из 3/);
    assert.equal(c.mailQueue.sent.length, 1);
    assert.equal(c.mailQueue.sent[0].kind, 'email_verify');
    assert.ok(
    tokenOf(c.mailQueue.sent[0]).length >= 40,
    'в письме ссылка с токеном',
  );
  assert.match(
    c.mailQueue.sent[0].link,
    /\/ru\/verify\?token=/,
    'ссылка ведёт на подтверждение по адресу из SCREENS',
  );
  });
});

test('английская версия отдаётся по адресу с другой локалью', async () => {
  // DEC-026 и F-00-02 §4: язык — часть адреса, а не настройка браузера.
  // Значит русский доступен без предварительного выбора (`/ru/...`), а
  // английский включается адресом, а не тем, что человек выбрал в браузере.
  // R-I18N-03 здесь ни при чём: это правило про множественные числа ICU.
  await withServer(async (c) => {
    const res = await c.get('/en/register');
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<html lang="en"/);
    assert.match(html, /Create account/);
  });
});

test('пароль никогда не возвращается в форму', async () => {
  await withServer(async (c) => {
    const { page } = await register(c, { password: 'короткий' });
    assert.ok(!page.includes('короткий'), 'значение пароля не должно попасть в разметку');
  });
});

test('ошибки полей показываются у самих полей', async () => {
  // R-A11Y-11: ошибка названа текстом, связана с полем и объявляется.
  await withServer(async (c) => {
    const { res, page } = await register(c, {
      email: 'без-знака', nickname: 'ab', password: 'короткий',
    });
    assert.equal(res.status, 422);
    assert.match(page, /id="email-error"/);
    assert.match(page, /id="nickname-error"/);
    assert.match(page, /id="password-error"/);
    assert.match(page, /aria-invalid="true"/);
    // Введённое сохраняется — иначе всё приходится набирать заново.
    assert.match(page, /value="без-знака"/);
  });
});

test('без согласия аккаунт не создаётся', async () => {
  await withServer(async (c) => {
    const { res, page } = await register(c, { consent: undefined });
    assert.equal(res.status, 422);
    assert.match(page, /Без согласия/);
    assert.equal(c.mailQueue.sent.length, 0, 'письмо не отправляется');
  });
});

test('занятый ник отклоняется', async () => {
  await withServer(async (c) => {
    const { res, page } = await register(c, { nickname: 'admin' });
    assert.equal(res.status, 422);
    assert.match(page, /зарезервирован/);
  });
});

test('занятый адрес даёт тот же ответ, что и свободный (R-SEC-06)', async () => {
  // Отличается только письмо: по ответу страницы иначе перебираются адреса.
  await withServer(async (c) => {
    const first = await register(c, { email: 'zanyat@example.com', nickname: 'pervyy' });
    assert.equal(first.res.status, 303);

    limits._reset();
    const second = await register(c, { email: 'zanyat@example.com', nickname: 'vtoroy' });
    assert.equal(second.res.status, 303, 'страница не должна отличаться по коду');
    assert.match(second.page, /Шаг 2 из 3/);
    // Письмо другое: владельцу занятого адреса предлагают восстановить пароль.
    assert.equal(c.mailQueue.sent.length, 2);
    assert.equal(c.mailQueue.sent[1].kind, 'email_taken');
  });
});

test('форма без CSRF отвергается', async () => {
  await withServer(async (c) => {
    const res = await c.post('/ru/register', {
      email: 'anna@example.com', nickname: 'anna', password: PASSWORD, consent: 'on',
    });
    assert.equal(res.status, 403);
    assert.equal(c.mailQueue.sent.length, 0);
  });
});

test('повторное письмо уважает паузу в минуту', async () => {
  await withServer(async (c) => {
    await register(c);
    const page = await (await c.get('/ru/register/confirm')).text();

    const first = await c.post('/ru/register/resend', { csrf: c.csrfOf(page) });
    assert.equal(first.status, 200);

    const second = await c.post('/ru/register/resend', { csrf: c.csrfOf(await first.text()) });
    assert.equal(second.status, 429);
    assert.match(second.headers.get('retry-after'), /^\d+$/);
    assert.match(await second.text(), /Повторите через/);
  });
});

test('шаг 2 без сессии возвращает на начало', async () => {
  // Человек закрыл вкладку и вернулся позже: пустой адрес читается как
  // «письмо ушло неизвестно куда».
  await withServer(async (c) => {
    const res = await c.get('/ru/register/confirm');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/ru/register');
  });
});

test('проверка занятости ника отвечает по адресу', async () => {
  await withServer(async (c, users) => {
    const res = await c.get('/ru/register/nick?nick=свободный');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { free: true });
  });
});

// ─── Ограничения (R-SEC-31, EC-A16) ─────────────────────────────────────────

test('пять успешных регистраций с адреса закрывают форму на час', async () => {
  await withServer(async (c) => {
    for (let i = 0; i < 5; i++) {
      const { res } = await register(c, {
        email: `anna${i}@example.com`, nickname: `anna${i}`,
      });
      assert.equal(res.status, 303, `регистрация ${i + 1} должна пройти`);
    }
    const { res, page } = await register(c, {
      email: 'шестая@example.com', nickname: 'шестая',
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '3600');
    assert.match(page, /Слишком много регистраций/);
  });
});

test('неудачные попытки не тратят лимит успешных регистраций', async () => {
  // Стена стоит по успехам. Иначе пять раз неверно написанный адрес
  // закрыли бы человеку регистрацию на час.
  await withServer(async (c) => {
    for (let i = 0; i < 8; i++) {
      const { res } = await register(c, { email: 'плохо' });
      assert.equal(res.status, 422, `попытка ${i + 1} не должна закрывать форму`);
    }
    const { res } = await register(c, { email: 'anna@example.com' });
    assert.equal(res.status, 303);
  });
});

test('занятый адрес не считается успешной регистрацией', async () => {
  await withServer(async (c) => {
    await register(c, { email: 'zanyat@example.com', nickname: 'pervyy' });
    limits._reset();
    for (let i = 0; i < 5; i++) {
      const { res } = await register(c, {
        email: 'zanyat@example.com', nickname: `imya${i}`,
      });
      assert.equal(res.status, 303, `повтор ${i + 1} не должен упираться в стену`);
    }
  });
});

test('невидимая проверка включается после трёх регистраций (EC-A16)', async () => {
  await withServer(async (c) => {
    for (let i = 0; i < 3; i++) {
      await register(c, { email: `anna${i}@example.com`, nickname: `anna${i}` });
    }
    // Четвёртая попытка идёт с задачей той же сложности, что и при входе.
    const fourth = await register(c, {
      email: 'chetroe@example.com', nickname: 'chetroe', pow: '',
    });
    assert.equal(fourth.res.status, 400, 'без решения четвёртая не проходит');
    assert.match(fourth.page, /data-zeros="3"/);
  });
});

test('после отказа по задаче форма снова проходима (EC-A16)', async () => {
  // Здесь была настоящая поломка: в повторно выданную форму подставлялось
  // число нулей вместо самой задачи. Решение никогда не подходило, и форма
  // становилась непроходимой с первого же отказа — без единого сообщения
  // об ошибке, кроме «проверьте отмеченные поля».
  await withServer(async (c) => {
    for (let i = 0; i < 3; i++) {
      await register(c, { email: `anna${i}@example.com`, nickname: `anna${i}` });
    }
    const refused = await register(c, {
      email: 'novyy@example.com', nickname: 'novyy', pow: '',
    });
    assert.equal(refused.res.status, 400);

    const challenge = refused.page.match(/data-challenge="([^"]+)"/)?.[1];
    assert.ok(challenge, 'задача выдана заново');
    assert.ok(!/^\d+$/.test(challenge), 'в разметке строка задачи, а не число нулей');

    // Отправка идёт из той же страницы: новый GET выдал бы новую задачу,
    // и решение считалось бы не для той, что хранится на сервере.
    const solved = await c.post('/ru/register', {
      csrf: c.csrfOf(refused.page),
      email: 'novyy@example.com',
      nickname: 'novyy',
      password: PASSWORD,
      consent: 'on',
      timezone: 'Europe/Minsk',
      pow: solveChallenge(refused.page),
    });
    assert.equal(solved.status, 303, 'форма проходима после отказа');
  });
});

test('сложность растёт с каждой регистрацией', async () => {
  await withServer(async (c) => {
    for (let i = 0; i < 4; i++) {
      await register(c, { email: `anna${i}@example.com`, nickname: `anna${i}` });
    }
    const page = await (await c.get('/ru/register')).text();
    const zeros = Number(page.match(/data-zeros="(\d+)"/)?.[1]);
    assert.equal(zeros, 4, `сложность должна вырасти на один нуль, получено ${zeros}`);
    assert.ok(page.includes('name="pow"'), 'задача вставлена в форму');
  });
});

test('сложность ограничена потолком', async () => {
  // Иначе при всплеске задача становится неразрешимой в разумное время.
  await withServer(async (c) => {
    for (let i = 0; i < 12; i++) {
      await register(c, { email: `anna${i}@example.com`, nickname: `anna${i}` });
    }
    const page = await (await c.get('/ru/register')).text();
    const zeros = Number(page.match(/data-zeros="(\d+)"/)?.[1]);
    assert.equal(zeros, AUTH.powZeros + 2, 'рост ограничен');
  });
});

// ─── Шаг 2: опрос (EC-A2) ───────────────────────────────────────────────────

test('опрос сообщает о подтверждении адреса', async () => {
  await withServer(async (c) => {
    await register(c);
    const before = await (await c.get('/ru/register/status')).json();
    assert.deepEqual(before, { confirmed: false });

    await c.auth.confirmEmail(1);
    const after = await (await c.get('/ru/register/status')).json();
    assert.deepEqual(after, { confirmed: true });
  });
});

test('опрос без сессии не раскрывает ничего', async () => {
  await withServer(async (c) => {
    const res = await c.get('/ru/register/status');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { confirmed: false });
  });
});

// ─── Подтверждение (S-21) ────────────────────────────────────────────────────

test('ссылка из письма открывает страницу с кнопкой и не подтверждает', async () => {
  // EC-A4: почтовые сканеры открывают ссылки сами, и подтверждение по GET
  // сожгло бы токен раньше времени.
  await withServer(async (c) => {
    await register(c);
    const { token } = verifyTokenOf(c.mailQueue.sent[0]);

    const res = await c.get(`/ru/verify?token=${encodeURIComponent(token)}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Подтвердить email/);

    const status = await (await c.get('/ru/register/status')).json();
    assert.equal(status.confirmed, false, 'GET не должен подтверждать');
  });
});

test('подтверждение по POST переводит аккаунт в активный и создаёт сессию', async () => {
  await withServer(async (c) => {
    await register(c);
    const { token } = verifyTokenOf(c.mailQueue.sent[0]);
    const page = await (await c.get(`/ru/verify?token=${encodeURIComponent(token)}`)).text();

    const res = await c.post('/ru/verify', { csrf: c.csrfOf(page), token });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/ru/');
    assert.equal((await c.auth.byEmail('anna@example.com')).email_confirmed, true);
  });
});

test('токен одноразовый: повторное использование даёт «уже подтверждён»', async () => {
  await withServer(async (c) => {
    await register(c);
    const { token } = verifyTokenOf(c.mailQueue.sent[0]);

    const first = await (await c.get(`/ru/verify?token=${encodeURIComponent(token)}`)).text();
    await c.post('/ru/verify', { csrf: c.csrfOf(first), token });

    const page = await (await c.get(`/ru/verify?token=${encodeURIComponent(token)}`)).text();
    const again = await c.post('/ru/verify', { csrf: c.csrfOf(page), token });
    assert.equal(again.status, 200);
    assert.match(await again.text(), /Email уже подтверждён/);
  });
});

test('чужой токен не подтверждает никого', async () => {
  await withServer(async (c) => {
    await register(c);
    const page = await (await c.get('/ru/verify?token=чужой')).text();
    const res = await c.post('/ru/verify', { csrf: c.csrfOf(page), token: 'чужой' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Ссылка устарела/);
    assert.equal((await c.auth.byEmail('anna@example.com')).email_confirmed, false);
  });
});

test('подтверждение без CSRF отвергается', async () => {
  await withServer(async (c) => {
    await register(c);
    const { token } = verifyTokenOf(c.mailQueue.sent[0]);
    const res = await c.post('/ru/verify', { token });
    assert.equal(res.status, 403);
    assert.equal((await c.auth.byEmail('anna@example.com')).email_confirmed, false);
  });
});

test('подтверждение в другом браузере завершает регистрацию (EC-A2)', async () => {
  // Письмо открыли на телефоне, а форма шага 2 открыта на компьютере.
  // Подтверждает телефон, компьютер узнаёт об этом опросом и идёт дальше.
  await withServer(async (c) => {
    await register(c);
    const { token } = verifyTokenOf(c.mailQueue.sent[0]);

    assert.deepEqual(await (await c.get('/ru/register/status')).json(), { confirmed: false });

    const phone = c.browser();
    const page = await (await phone.get(`/ru/verify?token=${encodeURIComponent(token)}`)).text();
    const res = await phone.post('/ru/verify', { csrf: phone.csrfOf(page), token });
    assert.equal(res.status, 303, 'телефон подтвердил и вошёл');
    assert.equal(res.headers.get('location'), '/ru/');

    // Исходная страница на компьютере видит подтверждение при опросе.
    assert.deepEqual(await (await c.get('/ru/register/status')).json(), { confirmed: true });
  });
});

test('подтверждение в своём браузере видно опросу (EC-A2)', async () => {
  // Ссылку из письма открывает новая вкладка того же браузера — это тоже
  // «подтверждение в другом месте». Идентификатор сессии при подтверждении
  // меняется, поэтому адрес ожидания переносится в новую сессию явно:
  // восстановить его из базы нельзя, он хранится шифром.
  await withServer(async (c) => {
    await register(c);
    const { token } = verifyTokenOf(c.mailQueue.sent[0]);
    const page = await (await c.get(`/ru/verify?token=${encodeURIComponent(token)}`)).text();
    await c.post('/ru/verify', { csrf: c.csrfOf(page), token });

    const status = await (await c.get('/ru/register/status')).json();
    assert.deepEqual(status, { confirmed: true }, 'вкладка со шагом 2 должна узнать о подтверждении');
  });
});

test('ссылка без токена не показывает кнопку', async () => {
  // Кнопка, нажатие которой всегда кончается «ссылка устарела», — обман.
  await withServer(async (c) => {
    const page = await (await c.get('/ru/verify')).text();
    assert.match(page, /Ссылка устарела/);
    assert.ok(!page.includes('name="token"'), 'формы подтверждения на странице нет');
  });
});

// ─── Повторные письма ────────────────────────────────────────────────────────

test('пятая отправка за час закрывает повторное письмо', async () => {
  // Пауза в минуту не дала бы дойти до часового лимита в тесте, поэтому
  // окно заполняется напрямую: счётчик живёт в модуле и считается по адресу,
  // а не по сессии.
  await withServer(async (c) => {
    await register(c);
    const page = await (await c.get('/ru/register/confirm')).text();
    for (let i = 0; i < AUTH.resendPerHour; i++) limits.recordResend('anna@example.com');

    const res = await c.post('/ru/register/resend', { csrf: c.csrfOf(page) });
    assert.equal(res.status, 429);
    assert.match(res.headers.get('retry-after'), /^[1-9]\d*$/);
    assert.equal(c.mailQueue.sent.length, 1, 'шестое письмо не отправляется');
  });
});
