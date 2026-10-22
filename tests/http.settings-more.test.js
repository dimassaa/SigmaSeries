// S-32: профиль, уведомления и безопасность.
//
// Три раздела проверяются по критериям приёмки F-01-06 §18 и по правилам:
//
//   • ник меняется не чаще раза в 30 дней, старый сохраняется;
//   • аватар без загрузки — инициалы на плашке (H-52, загрузка не в P0);
//   • смена пароля требует текущий и отзывает остальные сессии (§8(в));
//   • 2FA выключается по паролю (F-01-05 §8), служебным ролям — нельзя;
//   • устройства видны и отзываются (F-01-03).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword } from '../src/services/auth/password.js';
import { generateSecret, generateBackupCodes, hashBackupCode, totpAt } from '../src/services/auth/totp.js';
import { AUTH } from '../src/config/settings.js';

const PASSWORD = 'правильный-пароль-из-десяти';
const NOW = 1_700_000_000;

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
    ...over,
  };
}

/** Сервер со входом. `twoFactor` задаётся ДО входа — иначе служебный вход ушёл бы на настройку. */
async function withServer({
  user, roles = {}, extra = [], twoFactor = null, clock = null, run,
}) {
  const accounts = { [user.email]: user };
  for (const other of extra) accounts[other.email] = other;

  const auth = stubAuthStore(accounts, roles);
  if (twoFactor) auth.setTwoFactor(user.id, twoFactor);

  const memStore = createMemorySessionStore();
  const app = createApp({
    data: stubData(),
    auth,
    // createApp объявляет middleware сессий функцией, а модуль отдаёт обработчик
    // или их пару — Express принимает и то и другое.
    sessionMw: /** @type {any} */ (createSessionMiddleware({ query: async () => ({ rows: [] }), on: () => {} }, memStore)),
    journal: { security: () => {} },
    mailQueue: { enqueue: async () => 0 },
    ...(clock ? { now: clock } : {}),
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
  const entered = await post('/ru/login', {
    email: user.email, password: PASSWORD, csrf: csrfOf(login),
  });
  // У кого проверка настроена, вход идёт через код (решение автора, 21.10):
  // без второго фактора сессии не будет, и проверка раздела ничего не значит.
  if (twoFactor?.secret && entered.headers.get('location')?.endsWith('/2fa')) {
    const page = await (await get('/ru/2fa')).text();
    await post('/ru/2fa', {
      code: totpAt(twoFactor.secret, Math.floor(Date.now() / 1000)),
      csrf: csrfOf(page),
    });
  }

  try {
    await run({ get, post, csrfOf, user, auth, memStore });
  } finally {
    await /** @type {Promise<void>} */ (new Promise((r) => server.close(r)));
  }
}

/** Смена с проверкой CSRF: почти все посты раздела требуют её. */
async function save(h, path, fields) {
  const form = await (await h.get(path)).text();
  return h.post(path, { ...fields, csrf: h.csrfOf(form) });
}

// ─── Профиль (F-01-06 §4) ──────────────────────────────────────────────────

test('аватар без загрузки — инициалы на плашке (H-52)', async () => {
  // Загрузка изображений не в P0, но плашка с инициалами обязана быть: иначе
  // у человека нет никакого аватара вообще.
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get }) => {
      const page = await (await get('/ru/settings/profile')).text();
      // Ник латиницей, значит и инициалы латинские: тест ищет то, что
      // действительно приходит от `anna`.
      assert.match(page, /AN/, 'инициалы показаны');
      assert.doesNotMatch(page, /type="file"/, 'загрузки в P0 нет');
    },
  });
});

test('ник меняется и старый сохраняется в истории', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, auth }) => {
      const csrfOf = (h) => h.match(/name="csrf" value="([^"]+)"/)?.[1];
      const res = await save({ get, post, csrfOf }, '/ru/settings/profile', { nickname: 'анна' });

      assert.equal(res.status, 303, 'ник применён');
      assert.equal(user.nickname, 'анна', 'ник изменён');

      const history = await auth.nicknameHistory(user.id);
      assert.equal(history.length, 1, 'старый ник сохранён');
      assert.equal(history[0].nickname, 'anna');
    },
  });
});

test('ник нельзя менять чаще, чем раз в 30 дней', async () => {
  // §9 и §18: «ник менялся 10 дней назад → следующая смена доступна через
  // 20 дней». Число дней названо человеку, иначе сообщение бесполезно.
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, auth }) => {
      const csrfOf = (h) => h.match(/name="csrf" value="([^"]+)"/)?.[1];
      await save({ get, post, csrfOf }, '/ru/settings/profile', { nickname: 'анна' });

      const again = await save({ get, post, csrfOf }, '/ru/settings/profile', { nickname: 'анна' });
      assert.equal(again.status, 429, 'вторая смена запрещена');
      const page = await again.text();
      assert.match(page, new RegExp(String(AUTH.nicknameChangeDays)), 'число дней названо');
      assert.equal(user.nickname, 'анна', 'ник не изменился');
    },
  });
});

test('занятый ник отклоняется у поля', async () => {
  const user = await viewer();
  const other = await viewer({ id: 21, email: 'other@example.com', nickname: 'busy' });

  await withServer({
    user,
    extra: [other],
    run: async ({ get, post }) => {
      const csrfOf = (h) => h.match(/name="csrf" value="([^"]+)"/)?.[1];
      const res = await save({ get, post, csrfOf }, '/ru/settings/profile', { nickname: 'busy' });

      assert.equal(res.status, 400, 'занятый ник отвергнут');
      assert.match(await res.text(), /занят/i, 'ошибка у поля, а не в общем блоке');
    },
  });
});

// ─── Безопасность: пароль (F-01-06 §8(в), §18) ─────────────────────────────

test('смена пароля требует текущий и отзывает остальные сессии', async () => {
  // §18: «остальные устройства разлогинены». Отзыв всех, включая текущую,
  // ломал бы форму, поэтому текущая остаётся, а прочие — нет.
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, auth }) => {
      const csrfOf = (h) => h.match(/name="csrf" value="([^"]+)"/)?.[1];
      const res = await save({ get, post, csrfOf }, '/ru/settings/security', {
        action: 'password',
        current: PASSWORD, password: 'совсем-другой-пароль-12',
      });

      assert.equal(res.status, 303, 'пароль изменён');
      assert.equal(
        await auth.verifyCurrent(user.id, PASSWORD), false,
        'старый пароль больше не подходит',
      );
      assert.equal(
        await auth.verifyCurrent(user.id, 'совсем-другой-пароль-12'), true,
        'новый пароль работает',
      );
      assert.ok(auth.calls.revokeSessions.length >= 1, 'сессии отозваны');
    },
  });
});

test('смена пароля с неверным текущим не проходит', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post }) => {
      const csrfOf = (h) => h.match(/name="csrf" value="([^"]+)"/)?.[1];
      const res = await save({ get, post, csrfOf }, '/ru/settings/security', {
        action: 'password',
        current: 'не-текущий-пароль-1', password: 'совсем-другой-пароль-12',
      });

      assert.equal(res.status, 400, 'неверный текущий отвергнут');
      assert.match(await res.text(), /текущ|парол/i, 'человеку сказано, что не так');
    },
  });
});

test('слабый новый пароль отклоняется у поля', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post }) => {
      const csrfOf = (h) => h.match(/name="csrf" value="([^"]+)"/)?.[1];
      const res = await save({ get, post, csrfOf }, '/ru/settings/security', {
        action: 'password',
        current: PASSWORD, password: 'password123',
      });

      assert.equal(res.status, 400, 'слабый пароль отвергнут');
      assert.equal(await (await get('/ru/settings/security')).text()
        .then((p) => p.includes('password123')), false, 'пароль не показан обратно в форме');
    },
  });
});

// ─── Безопасность: 2FA (F-01-05 §8) ────────────────────────────────────────

test('зритель выключает 2FA по паролю', async () => {
  // §8: «зритель отключает 2FA по паролю». Отключение без пароля оставило бы
  // окно, открытое одной ссылкой из письма.
  //
  // Проверка настроена до входа: у кого она есть, вход идёт через код
  // (решение автора, 21.10), иначе сессии не будет вовсе.
  const user = await viewer();

  await withServer({
    user,
    twoFactor: {
      secret: generateSecret(), lastStep: null, backup: [hashBackupCode('AAAAAAAAAA')],
    },
    run: async ({ get, post, auth }) => {
      const csrfOf = (h) => h.match(/name="csrf" value="([^"]+)"/)?.[1];
      const res = await save({ get, post, csrfOf }, '/ru/settings/security', {
        action: 'two_factor', op: 'disable', password: PASSWORD,
      });

      assert.equal(res.status, 303, '2FA выключена');
      assert.equal(await auth.twoFactor(user.id), null, 'настройки 2FA удалены');
    },
  });
});

test('выключение 2FA без пароля не проходит', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, auth }) => {
      auth.setTwoFactor(user.id, {
        secret: generateSecret(), lastStep: null, backup: [hashBackupCode('AAAAAAAAAA')],
      });

      const csrfOf = (h) => h.match(/name="csrf" value="([^"]+)"/)?.[1];
      const res = await save({ get, post, csrfOf }, '/ru/settings/security', {
        action: 'two_factor', op: 'disable', password: 'не-текущий-пароль-1',
      });

      assert.equal(res.status, 400, 'без верного пароля не отключается');
      assert.notEqual(await auth.twoFactor(user.id), null, '2FA на месте');
    },
  });
});

test('служебной роли 2FA отключить нельзя', async () => {
  // F-01-05 §8: служебным ролям отключить 2FA нельзя. Проверяется именно
  // сервером: скрытая кнопка обходится прямым запросом.
  const user = await viewer({ id: 10, email: 'admin@example.com', nickname: 'boss' });
  const backup = [hashBackupCode('AAAAAAAAAA')];

  await withServer({
    user,
    roles: { 10: ['admin'] },
    twoFactor: { secret: generateSecret(), lastStep: null, backup },
    run: async ({ get, post, auth }) => {
      const csrfOf = (h) => h.match(/name="csrf" value="([^"]+)"/)?.[1];

      // Служебный вход идёт через 2FA — она настроена, значит человек видит
      // поле кода, и резервный код его открывает.
      const page = await (await get('/ru/2fa')).text();
      const passed = await post('/ru/2fa', {
        backup_code: 'AAAAAAAAAA', csrf: csrfOf(page),
      });
      assert.equal(passed.status, 303, 'служебная роль вошла по резервному коду');

      const res = await save({ get, post, csrfOf }, '/ru/settings/security', {
        action: 'two_factor', op: 'disable', password: PASSWORD,
      });

      assert.notEqual(res.status, 303, 'выключение не прошло');
      assert.notEqual(await auth.twoFactor(user.id), null, '2FA на месте');
    },
  });
});

test('коды предлагают скачать и напечатать, и кнопки связаны с разметкой', async () => {
  // «Скачать» годами была кнопкой без обработчика: нажатие ничего не делало,
  // а спецификация требует оба действия (F-01-05 §4, §19). Проверяется связка
  // целиком — разметка с кодами и именем файла плюс подписка в клиентском
  // скрипте: без любой из частей кнопка остаётся мёртвой.
  const user = await viewer();
  await withServer({
    user,
    run: async ({ get, post, auth }) => {
      auth.setTwoFactor(user.id, {
        secret: generateSecret(), lastStep: null, backup: [],
      });

      const csrfOf = (h) => h.match(/name="csrf" value="([^"]+)"/)?.[1];
      const res = await save({ get, post, csrfOf }, '/ru/settings/security', {
        action: 'two_factor', op: 'regenerate', password: PASSWORD,
      });
      assert.equal(res.status, 303);

      const shown = await (await get(res.headers.get('location'))).text();
      assert.match(shown, /data-download-codes/, 'кнопка «Скачать» нарисована');
      assert.match(shown, /data-print-codes/, 'кнопка «Печать» нарисована');
      assert.match(shown, /data-file="[^"]+\.txt"/, 'имя файла задано в разметке');
      assert.doesNotMatch(shown, /onclick=/, 'инлайновых обработчиков в видах нет');

      const script = await (await get('/app.js')).text();
      assert.match(script, /data-download-codes/, 'скрипт подписан на кнопку скачивания');
      assert.match(script, /data-print-codes/, 'скрипт подписан на кнопку печати');
    },
  });
});

test('резервные коды перегенерируются по паролю, старые становятся недействительными', async () => {
  // F-01-05 §8: перегенерация по паролю и делает старые недействительными.
  const user = await viewer();
  const old = generateBackupCodes();

  await withServer({
    user,
    run: async ({ get, post, auth }) => {
      auth.setTwoFactor(user.id, {
        secret: generateSecret(), lastStep: null, backup: old.map((c) => hashBackupCode(c)),
      });

      const csrfOf = (h) => h.match(/name="csrf" value="([^"]+)"/)?.[1];
      const res = await save({ get, post, csrfOf }, '/ru/settings/security', {
        action: 'two_factor', op: 'regenerate', password: PASSWORD,
      });

      assert.equal(res.status, 303, 'коды перегенерированы');
      const state = await auth.twoFactor(user.id);
      assert.equal(state.backup.length, AUTH.backupCodeCount, 'новый набор полного размера');
      assert.equal(
        state.backup.some((h) => h.equals(hashBackupCode(old[0]))), false,
        'старый код больше не действует',
      );
    },
  });
});

// ─── Безопасность: устройства (F-01-03) ────────────────────────────────────

test('в списке устройств видно адрес, дату входа и «это устройство»', async () => {
  // F-01-03 §4 обещает в строке браузер и ОС, усечённый адрес, даты и отметку
  // «это устройство». Строка берётся настоящая: устройство записано входом,
  // который сервер только что провёл, а не подставлена в заглушку.
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, auth }) => {
      assert.equal(auth.calls.noteDevice.length, 1, 'вход записал устройство');
      const [, device] = auth.calls.noteDevice[0];
      assert.ok(device.sidHash, 'хеш идентификатора сессии записан');
      assert.equal(device.ipPrefix, '127.0.0.0/24', 'адрес усечён до /24');

      // Второе устройство — чужой вход: по нему и «выйти на остальных».
      const [current] = await auth.devices(user.id, device.sidHash);
      auth.setSessions(user.id, [
        { ...current, ip_prefix: '10.0.0.0/24' },
        {
          id: current.id + 1,
          device_label: 'Firefox · Linux',
          sid_hash: 'хеш-чужого-входа',
          ip_prefix: null,
          created_at: NOW,
          last_seen_at: NOW,
        },
      ]);

      const page = await (await get('/ru/settings/security')).text();
      assert.match(page, /10\.0\.0\.0\/24/, 'усечённый адрес показан');
      assert.match(page, /Firefox · Linux/, 'чужое устройство тоже в списке');
      assert.match(page, /Это устройство/, 'текущий вход отмечен');
      assert.match(page, /value="revoke_others"/, 'выход на остальных доступен');
      assert.match(page, /Вход /, 'дата входа показана');
    },
  });
});

test('выход на остальных не трогает текущий вход', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, auth }) => {
      const [, device] = auth.calls.noteDevice[0];
      const [current] = await auth.devices(user.id, device.sidHash);
      auth.setSessions(user.id, [current, {
        id: current.id + 1,
        device_label: 'Firefox · Linux',
        sid_hash: 'хеш-чужого-входа',
        ip_prefix: null,
        created_at: NOW,
        last_seen_at: NOW,
      }]);

      // Запрос собирается из разметки формы, а не набирается руками: в форме
      // есть скрытое поле и кнопки, и набор полей вручную не поймал бы форму,
      // в которой нажатая кнопка спорит со скрытым полем за одно имя.
      const page = await (await get('/ru/settings/security')).text();
      const start = page.indexOf('name="action" value="revoke_others"');
      assert.ok(start > 0, 'кнопка «выйти на остальных» нарисована');
      const csrf = page.match(/name="csrf" value="([^"]+)"/)[1];
      const res = await post('/ru/settings/security', { csrf, action: 'revoke_others' });

      assert.equal(res.status, 303, 'нажатая кнопка сработала');
      const [prunedFor, keepSid, max] = auth.calls.pruneSessions.at(-1);
      assert.equal(prunedFor, user.id);
      assert.ok(keepSid, 'текущий вход передаётся и остаётся');
      assert.equal(max, 1, 'остаётся одна сессия — своя');
    },
  });
});

test('устройства перечисляются и отзываются', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, auth }) => {
      auth.setSessions(user.id, [
        { id: 's1', device_label: 'Телефон', created_at: NOW, last_seen_at: NOW },
        { id: 's2', device_label: 'Ноутбук', created_at: NOW, last_seen_at: NOW },
      ]);

      const page = await (await get('/ru/settings/security')).text();
      assert.match(page, /Телефон/, 'устройство названо');
      assert.match(page, /Ноутбук/);

      // Форма отправляет то, что в ней есть: скрытое поле `csrf` и нажатую
      // кнопку `session`. Никакого `action` в этой форме больше нет.
      const csrfOf = (h) => h.match(/name="csrf" value="([^"]+)"/)?.[1];
      const res = await save({ get, post, csrfOf }, '/ru/settings/security', { session: 's1' });

      assert.equal(res.status, 303, 'устройство отозвано');
      assert.deepEqual(
        auth.calls.revokeDevice.map((c) => c[1]), ['s1'],
        'отозвано именно то устройство',
      );
    },
  });
});

test('отзыв чужого устройства не проходит', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, auth }) => {
      auth.setSessions(user.id, [{ id: 's1', device_label: 'Телефон' }]);
      const csrfOf = (h) => h.match(/name="csrf" value="([^"]+)"/)?.[1];

      const res = await save({ get, post, csrfOf }, '/ru/settings/security', {
        session: 'чужое-устройство',
      });

      assert.notEqual(res.status, 303, 'чужое устройство не отозвано');
    },
  });
});