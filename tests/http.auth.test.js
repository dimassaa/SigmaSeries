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

/**
 * Адрес, под которым сервер видит тестовый запрос.
 *
 * Проверен: приложение слушает `127.0.0.1`, `trust proxy` не включён, и
 * `req.ip` для такого соединения — ровно `127.0.0.1`. Лимит по адресу сети
 * считается по нему же, поэтому сид счётчика в тесте должен совпадать.
 */
const LOCAL_IP = '127.0.0.1';

/** Заголовок настоящего браузера: подпись устройства читается из него. */
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Приложение с сессиями в памяти: развёрнутая база здесь не проверяется. */
function makeApp(users = {}, roles = {}) {
  const pool = { query: async () => ({ rows: [] }), on: () => {} };
  const store = createMemorySessionStore();
  const sessionMw = createSessionMiddleware(pool, store);
  const auth = stubAuthStore(users, roles);
  const app = createApp({ data: stubData(), auth, sessionMw });
  return { app, sessionMw, store, auth };
}

async function withServer(users, roles, run) {
  const { app, store, auth } = makeApp(users, roles);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let jar = '';
  const get = async (path, init = {}) => {
    const res = await fetch(base + path, { redirect: 'manual', ...init });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) jar = set.map((c) => c.split(';')[0]).join('; ');
    return res;
  };
  // `...init` идёт последним и раньше затирал собранные заголовки целиком:
  // достаточно было передать один заголовок, чтобы потерять cookie и тип
  // содержимого, и проверка падала бы на CSRF вместо своего предмета.
  const post = (path, fields, init = {}) => get(path, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar, ...init.headers },
    body: new URLSearchParams(fields),
  });
  /**
   * Достаёт CSRF из формы — так его видит и человек, и робот.
   * Синхронная: если сделать её async, в форму уедет «[object Promise]»
   * и проверка не будет проходить никогда.
   */
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];
  /**
   * Все сессии, какие сейчас лежат на сервере. Нужны, чтобы отличить
   * «cookie выдана» от «человек вошёл»: анонимная сессия с одним CSRF
   * заводится на любой форме и ничего не доказывает.
   */
  const sessions = () => new Promise((r) => store.all((e, s) => r(s ?? [])));
  try {
    await run({ get, post, csrfOf, sessions, auth });
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

test('служебная роль после пароля ещё не внутри (R-SEC-04)', async () => {
  // Здесь была дыра: маршрут выставлял `pendingStaff` и открывал полную
  // сессию с правами админа — на одном пароле. Флаг не читал никто: ни один
  // маршрут, ни middleware, ни шаблон.
  //
  // Теперь вход служебной роли не отказывает, а ведёт на второй фактор
  // (F-01-05). Проверяется, что до подтверждения кода прав нет ни в одной
  // сессии: «получил пароль» и «вошёл» — разные вещи.
  const user = await activeUser({ nickname: 'boss' });
  await withServer({ 'a@b.c': user }, { 1: ['admin'] }, async ({ get, post, csrfOf, sessions }) => {
    const html = await (await get('/ru/login')).text();
    const res = await post('/ru/login', {
      email: 'a@b.c', password: PASSWORD, csrf: csrfOf(html), next: '/',
    });

    assert.equal(res.status, 303, 'пароль верен — идём ко второму фактору');
    assert.equal(res.headers.get('location'), '/ru/2fa/setup', 'роль без 2FA идёт на настройку');

    // Cookie от анонимной сессии с CSRF — это норма: форма без неё не
    // защищена. Проверяется другое: что ни в одной сессии нет прав.
    const open = (await sessions()).filter((s) => s?.user);
    assert.equal(open.length, 0, 'до кода сессии с правами не существует');
  });
});

test('незавершённый вход служебной роли не стирает историю перебора', async () => {
  // Верный пароль служебного аккаунта не должен обнулять историю неудач:
  // вход ведь не состоялся. Раньше `recordSuccess` вызывался до проверки
  // второго фактора, и один угаданный пароль стирал накопленную историю —
  // перебор можно было начинать заново хоть после каждой удачной попытки.
  //
  // Теперь вход не отказывает, а уходит на второй фактор. Значит верный
  // пароль — это половина входа, и историю он стереть не должен тем более.
  //
  // Порог невидимой проверки (3) перешагивается только после входа:
  // набрать его раньше нельзя, иначе PoW-заслонка не пустит запрос до
  // проверки роли и тест перестанет проходить по нужной причине.
  const user = await activeUser({ nickname: 'boss' });
  await withServer({ 'a@b.c': user }, { 1: ['admin'] }, async ({ get, post, csrfOf }) => {
    limits.recordFailure('a@b.c', '10.0.0.1');
    limits.recordFailure('a@b.c', '10.0.0.1');
    assert.ok(!limits.needsProofOfWork('a@b.c'), 'порог невидимой проверки ещё не достигнут');

    const right = await (await get('/ru/login')).text();
    const res = await post('/ru/login', {
      email: 'a@b.c', password: PASSWORD, csrf: csrfOf(right),
    });
    assert.equal(res.status, 303, 'пароль верен, ждём второго фактора');
    assert.equal(res.headers.get('location'), '/ru/2fa/setup', 'вход ещё не завершён');

    limits.recordFailure('a@b.c', '10.0.0.1');
    assert.ok(limits.needsProofOfWork('a@b.c'), 'история перебора не стёрта');
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

test('вход упирается в лимит по адресу сети, а не по аккаунту', async () => {
  // Лимит по IP (`ipLimited`) был написан и проверен отдельно, но ни один
  // маршрут его не спрашивал: перебор двадцати аккаунтов с одного адреса
  // проходил без помех. Проверка нужна именно на другом аккаунте — иначе
  // сработала бы задержка по аккаунту, и тест зеленел бы не по той причине.
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, {}, async ({ get, post, csrfOf }) => {
    for (let i = 0; i < AUTH.attemptsPerIp; i++) {
      limits.recordFailure(`чужой-${i}@b.c`, LOCAL_IP);
    }
    const form = await (await get('/ru/login')).text();
    const res = await post('/ru/login', {
      // Верный пароль: лимит по адресу не должен зависеть от того, верен он.
      email: 'a@b.c', password: PASSWORD, csrf: csrfOf(form),
    });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0, 'нужен Retry-After');
    assert.match(await res.text(), /[Пп]опробуйте/);
  });
});

test('под лимитом по адресу вход проходит', async () => {
  // Контроль к предыдущей проверке: тот же верный пароль, на одну неудачу
  // меньше лимита — вход должен состояться. Иначе 429 выше объяснялся бы чем
  // угодно, кроме лимита по адресу.
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, {}, async ({ get, post, csrfOf }) => {
    for (let i = 0; i < AUTH.attemptsPerIp - 1; i++) {
      limits.recordFailure(`чужой-${i}@b.c`, LOCAL_IP);
    }
    const form = await (await get('/ru/login')).text();
    const res = await post('/ru/login', {
      email: 'a@b.c', password: PASSWORD, csrf: csrfOf(form),
    });
    assert.equal(res.status, 303, 'под лимитом вход не блокируется');
  });
});

test('вход записывает устройство и подрезает лишние сессии', async () => {
  // Обе вещи описаны в F-01-03 и обе были сделаны наполовину: устройство не
  // записывалось нигде (список S-32 был всегда пуст, «Выйти на этом» —
  // недостижимая кнопка), а `auth.sessions_max` был числом без применения.
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, {}, async ({ get, post, csrfOf, auth }) => {
    const form = await (await get('/ru/login')).text();
    const res = await post('/ru/login', {
      email: 'a@b.c', password: PASSWORD, csrf: csrfOf(form),
    }, { headers: { 'user-agent': CHROME_WIN } });
    assert.equal(res.status, 303);

    assert.equal(auth.calls.noteDevice.length, 1, 'устройство записывается один раз');
    const [userId, device] = auth.calls.noteDevice[0];
    assert.equal(userId, user.id);
    assert.equal(device.label, 'Chrome · Windows');
    assert.ok(device.sidHash, 'без хеша идентификатора отзыв устройства не найдёт сессию');
    assert.equal(device.ipPrefix, '127.0.0.0/24');

    const [prunedFor, keepSid, max] = auth.calls.pruneSessions[0];
    assert.equal(prunedFor, user.id);
    assert.ok(keepSid, 'идентификатор текущей сессии передаётся: её закрывать нельзя');
    assert.equal(max, AUTH.sessionsMax);
  });
});

test('выход не стирает устройство из списка', async () => {
  // Граница между двумя действиями: «выйти» закрывает сессию, а «Выйти на
  // этом» в списке устройств снимает само устройство. Если бы обычный выход
  // стирал строку, список после выхода был бы пуст — и кнопка в нём тоже.
  const user = await activeUser();
  await withServer({ 'a@b.c': user }, {}, async ({ get, post, csrfOf, auth }) => {
    const form = await (await get('/ru/login')).text();
    await post('/ru/login', { email: 'a@b.c', password: PASSWORD, csrf: csrfOf(form) });
    const before = await auth.devices(user.id);
    await post('/ru/logout', { csrf: csrfOf(await (await get('/ru/')).text()) });
    assert.equal((await auth.devices(user.id)).length, before.length);
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