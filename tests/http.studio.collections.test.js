// S-77 через настоящий HTTP: маршрут правки подборки.
//
// Проверяется не «страница отдалась» (это делают юнит-тесты сервиса), а разбор
// формы в маршруте — то, что в юнит-тесты сервиса не попадает. Кейс №249:
// пустое поле списка сериалов — это отсутствие сериалов, а не сериал с
// номером ноль. До починки правка пустого черновика падала FK-ошибкой,
// потому что `Number('')` даёт 0, и сервис получал серийный номер 0.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword } from '../src/services/auth/password.js';
import { generateSecret, totpAt } from '../src/services/auth/totp.js';

const PASSWORD = 'правильный-пароль-из-десяти';
const NOW = 1_700_000_000;

/** Администратор раздела студии (R-SEC-35: только он видит подборки). */
async function adminUser(over = {}) {
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

/**
 * Сервер с подставными источниками студии: `save` запоминает вход, чтобы
 * тест видел, какие списки сериалов маршрут переслал сервису.
 *
 * @param {{run: (io: any) => Promise<void>, save: (input: any) => Promise<any>}} args
 */
async function withServer({ run, save }) {
  const user = await adminUser();
  const auth = stubAuthStore({ [user.email]: user }, { 10: ['admin'] });
  // R-SEC-04: служебная роль проходит второй фактор. Секрет заводится заранее,
  // иначе вход уводит на экран настройки, а сессии для раздела студии нет.
  const secret = generateSecret();
  auth.setTwoFactor(user.id, { secret });
  const pool = { query: async () => ({ rows: [] }), on: () => {} };
  const memStore = createMemorySessionStore();

  const collections = {
    list: async () => [],
    one: async () => null,
    save,
    reorder: async () => true,
  };

  const app = createApp({
    data: stubData(),
    auth,
    sessionMw: /** @type {any} */ (createSessionMiddleware(pool, memStore)),
    now: () => NOW * 1000,
    studioCollections: /** @type {any} */ (collections),
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(/** @type {import('http').Server} */ (s)));
  });
  const base = `http://127.0.0.1:${/** @type {any} */ (server).address().port}`;
  let jar = '';

  /** Запрос с общей банкой cookie: смена сессии на входе тоже сохраняется. */
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

  try {
    // Вход паролем: админ по R-SEC-04 идёт дальше на второй фактор, а раздел
    // студии открывается только после него.
    const loginPage = await (await get('/ru/login')).text();
    const signIn = await post('/ru/login', {
      email: user.email, password: PASSWORD, csrf: csrfOf(loginPage),
    });
    assert.equal(signIn.status, 303, 'пароль принят');
    assert.ok(signIn.headers.get('location')?.endsWith('/2fa'), 'служебная роль идёт на второй фактор');

    const twoFactorPage = await (await get('/ru/2fa')).text();
    const verified = await post('/ru/2fa', {
      code: totpAt(secret, NOW), csrf: csrfOf(twoFactorPage),
    });
    assert.equal(verified.status, 303, 'второй фактор принят');

    await run({ get, post, csrfOf });
  } finally {
    await /** @type {Promise<void>} */ (new Promise((r) => server.close(r)));
  }
}

test('пустой список сериалов в правке — отсутствие сериалов, не «сериал ноль» (№249)', async () => {
  let input = null;
  await withServer({
    save: async (arg) => {
      input = arg;
      return { ok: true, slug: arg.slug };
    },
    run: async ({ get, post, csrfOf }) => {
      const newPage = await (await get('/ru/admin/collections/new')).text();
      assert.match(newPage, /Новая подборка/, 'раздел студии открыт админу');

      const res = await post('/ru/admin/collections/qa-draft', {
        csrf: csrfOf(newPage),
        title_ru: 'Правка', slug: 'qa-draft', weight: '3',
        // Пустой состав: черновик без сериалов — форма шлёт пустую строку.
        series_ids: '',
      });
      assert.equal(res.status, 303, 'правка пустого черновика сохраняется');

      assert.ok(input, 'сервис был вызван');
      assert.deepEqual(input.seriesIds, [],
        'пустая строка списка — пустой массив, а не [0] с несуществующим сериалом');
    },
  });
});
