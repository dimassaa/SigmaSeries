// S-23 через настоящий HTTP.
//
// Формально проверяется не «страница отдалась», а три вещи, которые видны
// только в ответе сервера: служебная сессия без пройденной 2FA не попадает
// в обычные разделы (F-01-05 §18), код одного шага второй раз не
// принимается, а неверный код не раскрывает, настроена ли 2FA.
//
// Время подставляется в приложение (`now`): код TOTP считается от часов, и
// без этого тест сравнивал бы код, вычисленный для 2023 года, с тем, что
// ждёт сервер сегодня.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword } from '../src/services/auth/password.js';
import { totpAt, generateSecret, generateBackupCodes, hashBackupCode } from '../src/services/auth/totp.js';
import * as limits from '../src/services/auth/limits.js';

const PASSWORD = 'правильный-пароль-из-десяти';
const NOW = 1_700_000_000;

/** Администратор без настроенной 2FA — состояние EC-A19. */
async function staffUser(over = {}) {
  return {
    id: 10,
    email: 'admin@example.com',
    password_hash: await hashPassword(PASSWORD),
    nickname: 'boss',
    status: 'active',
    email_confirmed: true,
    locale: 'ru',
    theme: 'dark',
    ...over,
  };
}

/** Зритель: обычный аккаунт, 2FA по желанию. */
async function viewerUser(over = {}) {
  return {
    id: 20,
    email: 'anna@example.com',
    password_hash: await hashPassword(PASSWORD),
    nickname: 'anna',
    status: 'active',
    email_confirmed: true,
    locale: 'ru',
    theme: 'dark',
    ...over,
  };
}

/**
 * Корзина браузера: своя сессия на каждый вызов.
 *
 * Отдельные корзины нужны там, где одноразовость проверяется на другой
 * сессии: в этой после успеха сессия очищена, и повтор ушёл бы на экран
 * входа — то есть проверял бы редирект, а не код.
 */
function browser(base) {
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

  /** Вход паролем; возвращает ответ, на который привели. */
  const signIn = async (email, password = PASSWORD) => {
    const page = await (await get('/ru/login')).text();
    return post('/ru/login', { email, password, csrf: csrfOf(page) });
  };

  return { get, post, csrfOf, signIn };
}

/**
 * Сервер со заглушкой хранилища.
 *
 * `twoFactor` — состояние 2FA аккаунта; тесты задают его напрямую, потому
 * что настройка идёт через QR, который проверяется настоящим декодированием.
 */
async function withServer({ user, roles = {}, twoFactor = null, run }) {
  const auth = stubAuthStore({ [user.email]: user }, roles);
  if (twoFactor) auth.setTwoFactor(user.id, twoFactor);

  const logged = [];
  const journal = { security: (e) => logged.push(e) };
  const pool = { query: async () => ({ rows: [] }), on: () => {} };
  const memStore = createMemorySessionStore();
  const app = createApp({
    data: stubData(),
    auth,
    // createApp объявляет middleware сессий функцией, а модуль отдаёт обработчик
    // или их пару — Express принимает и то и другое.
    sessionMw: /** @type {Function} */ (createSessionMiddleware(pool, memStore)),
    journal,
    now: () => NOW * 1000,
  });

  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const main = browser(base);
  /** Сессии с сервера: проверяются напрямую, а не по разметке. */
  const sessions = () => new Promise((r) => memStore.all((_e, s) => r(s ?? [])));

  try {
    await run({ ...main, newBrowser: () => browser(base), sessions, auth, logged });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test.beforeEach(() => limits._reset());

// ─── Вход служебной роли требует 2FA (R-SEC-04) ───────────────────────────────

test('служебная роль после пароля попадает на экран кода, а не в свои разделы', async () => {
  const user = await staffUser();
  await withServer({
    user,
    roles: { 10: ['admin'] },
    twoFactor: { secret: generateSecret(), lastStep: null, backup: [] },
    run: async ({ signIn }) => {
      const res = await signIn(user.email);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/ru/2fa');
    },
  });
});

test('служебная роль без настроенной 2FA попадает на настройку, а не на код', async () => {
  // EC-A19: роль действует, но служебные разделы закрыты до настройки 2FA.
  const user = await staffUser();
  await withServer({
    user,
    roles: { 10: ['admin'] },
    twoFactor: null,
    run: async ({ signIn }) => {
      const res = await signIn(user.email);
      assert.equal(res.headers.get('location'), '/ru/2fa/setup');
    },
  });
});

test('зритель после пароля входит сразу: 2FA у него по желанию', async () => {
  const user = await viewerUser();
  await withServer({
    user,
    twoFactor: null,
    run: async ({ signIn }) => {
      const res = await signIn(user.email);
      assert.equal(res.headers.get('location'), '/ru/', 'зрителя не заставляют настраивать 2FA');
    },
  });
});

test('зритель с настроенной 2FA после пароля ещё не внутри (F-01-05 §4)', async () => {
  // Решение автора (21.10): код спрашивается у того, кто настроил проверку, —
  // и зрителю тоже. DEC-015 делает проверку обязательной для служебных ролей,
  // но не отменяет её у того, кто выбрал её сам. Потерявшее устройство
  // проходит через резервные коды, а затем через сброс админом (EC-A8).
  const user = await viewerUser();
  await withServer({
    user,
    twoFactor: { secret: generateSecret(), lastStep: null, backup: [] },
    run: async ({ signIn }) => {
      const res = await signIn(user.email);
      assert.equal(res.headers.get('location'), '/ru/2fa');
    },
  });
});

test('вход служебного аккаунта без настроенной 2FA не падает', async () => {
  // Проверка усилена после находки в браузере: страница настройки падала с
  // «req is not defined», и тест этого не видел — он требовал лишь «страница
  // непустая», а экран ошибки тоже непустой. Теперь требуется содержимое
  // экрана: секрет и поле кода.
  const user = await staffUser({ id: 11, email: 'ed@example.com' });
  await withServer({
    user,
    roles: { 11: ['editor'] },
    twoFactor: null,
    run: async ({ signIn, get }) => {
      const res = await signIn(user.email);
      assert.equal(res.status, 303, 'вход завершается, а не падает');
      const page = await (await get('/ru/2fa/setup')).text();
      assert.ok(!page.includes('Что-то пошло не так'), 'страница настройки не экрана ошибки');
      assert.match(page, /name="code"/, 'экран настройки просит код');
      assert.match(page, /class="setup__secret"/, 'экран настройки показывает секрет');
    },
  });
});

// ─── Ввод кода (F-01-05 §4, §5) ─────────────────────────────────────────────

test('верный код открывает служебные разделы', async () => {
  const user = await staffUser();
  const secret = generateSecret();
  await withServer({
    user,
    roles: { 10: ['admin'] },
    twoFactor: { secret, lastStep: null, backup: [] },
    run: async ({ signIn, get, post, csrfOf }) => {
      await signIn(user.email);

      const form = await (await get('/ru/2fa')).text();
      const res = await post('/ru/2fa', {
        code: totpAt(secret, NOW), csrf: csrfOf(form),
      });

      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/ru/');
    },
  });
});

test('неверный код не пускает дальше и не говорит, настроена ли 2FA', async () => {
  const user = await staffUser();
  await withServer({
    user,
    roles: { 10: ['admin'] },
    twoFactor: { secret: generateSecret(), lastStep: null, backup: [] },
    run: async ({ signIn, get, post, csrfOf }) => {
      await signIn(user.email);
      const form = await (await get('/ru/2fa')).text();
      const res = await post('/ru/2fa', { code: '000000', csrf: csrfOf(form) });
      const page = await res.text();

      assert.equal(res.status, 200, 'ошибка показывается на странице, а не редиректом');
      assert.match(page, /не подош/i, 'человеку сказано, что код не тот');
      assert.doesNotMatch(page, /секрет/i, 'секрет на странице ошибки не светится');
    },
  });
});

test('код одного шага второй раз не принимается', async () => {
  const user = await staffUser();
  const secret = generateSecret();
  await withServer({
    user,
    roles: { 10: ['admin'] },
    twoFactor: { secret, lastStep: null, backup: [] },
    run: async ({ signIn, get, post, csrfOf, newBrowser }) => {
      const code = totpAt(secret, NOW);

      await signIn(user.email);
      const first = await (await get('/ru/2fa')).text();
      const ok = await post('/ru/2fa', { code, csrf: csrfOf(first) });
      assert.equal(ok.status, 303, 'первый раз код принят');

      // Другая корзина: без проверки шага тот же код прошёл бы снова, и
      // перехваченный код работал бы все 30 секунд.
      const other = newBrowser();
      await other.signIn(user.email);
      const again = await (await other.get('/ru/2fa')).text();
      const res = await other.post('/ru/2fa', { code, csrf: other.csrfOf(again) });

      assert.equal(res.status, 200, 'второй раз тот же код отвергнут');
      assert.match(await res.text(), /уже использован/i);
    },
  });
});

test('мусорный код не роняет страницу', async () => {
  const user = await staffUser();
  await withServer({
    user,
    roles: { 10: ['admin'] },
    twoFactor: { secret: generateSecret(), lastStep: null, backup: [] },
    run: async ({ signIn, get, post, csrfOf }) => {
      await signIn(user.email);
      const form = await (await get('/ru/2fa')).text();
      const res = await post('/ru/2fa', { code: 'не-код', csrf: csrfOf(form) });
      assert.equal(res.status, 200, 'не 500: ошибка в поле, а не падение');
    },
  });
});

test('экран кода не кэшируется: на нём видно, что человек вошёл', async () => {
  const user = await staffUser();
  await withServer({
    user,
    roles: { 10: ['admin'] },
    twoFactor: { secret: generateSecret(), lastStep: null, backup: [] },
    run: async ({ signIn, get }) => {
      await signIn(user.email);
      const res = await get('/ru/2fa');
      assert.equal(res.status, 200, 'человек остаётся на экране кода');
      assert.match(res.headers.get('cache-control') ?? '', /no-store/);
      assert.match(await res.text(), /autocomplete="one-time-code"/, 'R-A11Y-10: поле готово к автоподстановке');
    },
  });
});

test('после верного кода вход состоялся, а экран кода больше не нужен', async () => {
  const user = await staffUser();
  const secret = generateSecret();
  await withServer({
    user,
    roles: { 10: ['admin'] },
    twoFactor: { secret, lastStep: null, backup: [] },
    run: async ({ signIn, get, post, csrfOf, sessions }) => {
      await signIn(user.email);
      const form = await (await get('/ru/2fa')).text();
      const res = await post('/ru/2fa', { code: totpAt(secret, NOW), csrf: csrfOf(form) });

      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/ru/');

      // Проверяется состояние сессии, а не разметка главной: главная для всех
      // и никаких признаков входа не показывает — искать их там бессмысленно.
      const [session] = await sessions();
      assert.equal(session.user.id, user.id, 'человек внутри');
      assert.equal(session.twoFactorPassed, true, 'второй фактор пройден');
      assert.equal(session.pendingTwoFactor, undefined, 'наполовину доверенная сессия убрана');
      assert.deepEqual(session.user.roles, ['admin'], 'роль на месте');

      // Экран кода после входа больше не предлагается.
      const again = await get('/ru/2fa');
      assert.equal(
        again.headers.get('location'), '/ru/login',
        'код повторно не спрашивается: сессия уже доверенная',
      );
    },
  });
});

test('проверка кода попадает в журнал безопасности без секретов', async () => {
  const user = await staffUser();
  const secret = generateSecret();
  await withServer({
    user,
    roles: { 10: ['admin'] },
    twoFactor: { secret, lastStep: null, backup: [] },
    run: async ({ signIn, get, post, csrfOf, logged }) => {
      await signIn(user.email);
      const form = await (await get('/ru/2fa')).text();
      await post('/ru/2fa', { code: totpAt(secret, NOW), csrf: csrfOf(form) });

      const events = logged.map((e) => e.event);
      assert.ok(events.includes('two_factor_verified'), 'успешная проверка записана');
      for (const entry of logged) {
        assert.equal(JSON.stringify(entry).includes(secret), false, 'секрет в журнале не лежит');
        assert.equal(JSON.stringify(entry).includes(PASSWORD), false, 'пароль в журнале не лежит');
      }
    },
  });
});

// ─── Резервные коды (F-01-05 §4, §18) ────────────────────────────────────────

test('резервный код открывает доступ и после этого не работает', async () => {
  const user = await staffUser();
  const codes = generateBackupCodes();
  await withServer({
    user,
    roles: { 10: ['admin'] },
    twoFactor: {
      secret: generateSecret(),
      lastStep: null,
      backup: codes.map((c) => hashBackupCode(c)),
    },
    run: async ({ signIn, get, post, csrfOf, newBrowser }) => {
      await signIn(user.email);
      const form = await (await get('/ru/2fa')).text();
      const res = await post('/ru/2fa', { backup_code: codes[0], csrf: csrfOf(form) });
      assert.equal(res.status, 303, 'резервный код пускает');

      const other = newBrowser();
      await other.signIn(user.email);
      const form2 = await (await other.get('/ru/2fa')).text();
      const again = await other.post('/ru/2fa', { backup_code: codes[0], csrf: other.csrfOf(form2) });
      assert.equal(again.status, 200, 'использованный резервный код второй раз не принимается');
    },
  });
});

test('на экране кода сказано, сколько резервных кодов осталось', async () => {
  // F-01-05 §5: при ≤ 3 оставшихся — предупреждение. Без числа человек
  // узнает об этом, только когда коды кончатся.
  const user = await staffUser();
  const codes = generateBackupCodes();
  await withServer({
    user,
    roles: { 10: ['admin'] },
    twoFactor: {
      secret: generateSecret(),
      lastStep: null,
      backup: codes.slice(0, 3).map((c) => hashBackupCode(c)),
    },
    run: async ({ signIn, get }) => {
      await signIn(user.email);
      const page = await (await get('/ru/2fa')).text();
      assert.match(page, /3/, 'оставшееся число названо');
    },
  });
});