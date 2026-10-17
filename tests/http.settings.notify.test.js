// Экран настроек уведомлений (F-03-10, вкладка S-32).
//
// Проверяется вместе с живой базой: экран, который рисует переключатели, но не
// меняет то, что едет в уведомлениях, хуже отсутствующего экрана — человек
// считает, что отписался, а письма и точки продолжают приходить.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { pgNotificationPreferences } from '../src/services/notify/preferences.js';
import { pgNotifications } from '../src/services/notify/notification.js';
import { settingsView } from '../src/view/settings.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — экран настроек уведомлений не проверялся';

let pool;
let preferences;
let notifications;
let account;
let staff;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  preferences = pgNotificationPreferences(pool);
  notifications = pgNotifications(pool);

  const id = `snpref-${crypto.randomUUID().slice(0, 8)}`;
  const make = async (nickname) => {
    const { hash } = makeToken();
    return pgAuthStore(pool).createUser({
      email: `${nickname}@example.com`,
      nickname,
      passwordHash: await hashPassword(PASSWORD),
      tokenHash: hash,
      timezone: 'Europe/Minsk',
      locale: 'ru',
      theme: 'dark',
    });
  };
  const viewerRow = await make(id);
  const staffRow = await make(`${id}-s`);

  // Хеш пароля считается один раз на двоих: строки заглушки сравниваются с
  // тем, что прислал настоящий вход, а `await` внутри объекта не проходит.
  const passwordHash = await hashPassword(PASSWORD);
  const row = (created, nickname, roles = []) => ({
    id: created.id,
    email: `${nickname}@example.com`,
    password_hash: passwordHash,
    nickname,
    status: 'active',
    email_confirmed: true,
    locale: 'ru',
    theme: 'dark',
    timezone: 'Europe/Minsk',
    recs_enabled: true,
    profile_public: false,
    stats_public: false,
    roles,
  });

  account = row(viewerRow, id);
  staff = row(staffRow, `${id}-s`, ['admin']);
  await pool.query(
    `INSERT INTO e_role_assignment (user_id, role, note) VALUES ($1, 'admin', 'проверка экрана настроек')`,
    [staffRow.id],
  );
});

test.after(async () => {
  if (!pool) return;
  const ids = [account.id, staff.id];
  await pool.query('DELETE FROM e_notification WHERE user_id = ANY($1::bigint[])', [ids]);
  await pool.query('DELETE FROM e_notification_preference WHERE user_id = ANY($1::bigint[])', [ids]);
  await pool.query('DELETE FROM e_role_assignment WHERE user_id = ANY($1::bigint[])', [ids]);
  await pool.query('DELETE FROM e_session WHERE user_id = ANY($1::bigint[])', [ids]);
  await pool.query('DELETE FROM e_user WHERE id = ANY($1::bigint[])', [ids]);
  await pool.end();
});

async function withServer({ user, run }) {
  // Настоящее хранилище, а не заглушка: экран пишет настройки в базу, и
  // проверка читает их оттуда же — иначе «сохранилось» означало бы «нарисовалось».
  const auth = pgAuthStore(pool);
  const app = createApp({
    data: stubData(),
    auth,
    pool,
    feed: { unreadCount: async () => 0 },
    preferences,
    sessionMw: createSessionMiddleware(
      { query: async () => ({ rows: [] }), on: () => {} },
      createMemorySessionStore(),
    ),
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

  const page = await (await get('/ru/login')).text();
  await post('/ru/login', { email: user.email, password: PASSWORD, csrf: csrfOf(page) });

  try {
    await run({ get, post, csrfOf });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('матрица показывает категории и один работающий канал (F-03-10 §4)', { skip }, async () => {
  await withServer({
    user: account,
    run: async ({ get }) => {
      const body = await (await get('/ru/settings/notifications')).text();

      assert.match(body, /Выход серий моих сериалов/, 'выходы — строка матрицы');
      assert.match(body, /Ответы/, 'ответы — строка матрицы');
      assert.match(body, /Результат проверки моих материалов/, 'результат проверки виден отдельной строкой');
      assert.match(body, /name="category" value="release"/, 'у категории есть переключатель');
      const lockedRow = /<tr class="notify-matrix__row notify-matrix__row--locked">([\s\S]*?)<\/tr>/
        .exec(body)?.[1] ?? '';
      assert.match(lockedRow, /aria-checked="true"/,
        'обязательная категория показана включённой');
      assert.match(lockedRow, /disabled/,
        'и её переключатель заблокирован в разметке — человек не тратит попытку');

      assert.match(body, /name="quiet_from"[^>]*value="23:00"/, 'границы тихих часов видны со значениями из модуля');
      assert.match(body, /name="quiet_to"[^>]*value="08:00"/);

      // Каналов-обещаний нет: почта и push ещё не отправляются, и переключатель,
      // который ничего не делает, хуже отсутствующего.
      assert.ok(!/value="email"/.test(body), 'канала почты пока нет');
      assert.ok(!/name="notifications_enabled"/.test(body), 'общего выключателя больше нет');
    },
  });
});

test('служебная строка не показывается зрителю (F-03-10 §4)', { skip }, async () => {
  await withServer({
    user: account,
    run: async ({ get }) => {
      const viewer = await (await get('/ru/settings/notifications')).text();
      assert.ok(!/name="category" value="service"/.test(viewer),
        'зритель не видит служебную категорию: она ему ничего не присылает');
    },
  });
});

// Служебная роль проверяется на самом виде, а не через вход: вход служебной
// роли требует второго фактора (R-SEC-04) и заканчивается на другом экране,
// а проверять надо строку матрицы, а не путь входа.
test('служебная строка появляется у служебной роли', { skip }, async () => {
  const page = settingsView({
    locale: 'ru',
    csrf: 'токен',
    section: 'notifications',
    sections: { notifications: 'settings.notifications.title' },
    user: { ...account, quietHours: false, quietFrom: '23:00', quietTo: '08:00' },
    matrix: await preferences.matrix(account.id),
    staff: true,
  }).__raw;

  assert.match(page, /name="category" value="service"/, 'служебная роль видит служебные уведомления');
});

test('переключатель сохраняется сразу и уведомления перестают приходить (§18)', { skip }, async () => {
  await withServer({
    user: account,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/settings/notifications')).text();

      const saved = await post('/ru/settings/notifications', {
        csrf: csrfOf(page), category: 'release', channel: 'in_service', enabled: 'off',
      });
      assert.equal(saved.status, 303, 'переключатель сохраняется без отдельной кнопки');
      assert.match(saved.headers.get('location') ?? '', /saved=1/);

      const matrix = await preferences.matrix(account.id);
      assert.equal(matrix.release.in_service, false, 'настройка записана');

      const created = await notifications.create({
        userIds: [account.id],
        kind: 'release_today',
        params: { seriesSlug: 'nastroyki', date: '2026-10-20' },
        dedupKey: `screen-${crypto.randomUUID()}`,
      });
      assert.equal(created.created, 0, 'и уведомление больше не создаётся');

      const back = await (await get(saved.headers.get('location').replace('http://', ''))).text();
      assert.match(back, /Сохранено|сохранено/, 'страница подтверждает сохранение для скринридера');
      const releaseRow = /<th scope="row">Выход серий[\s\S]*?<\/tr>/.exec(back)?.[0] ?? '';
      assert.match(releaseRow, /aria-checked="false"/,
        'строка осталась в выбранном состоянии — переключатель не сбросился при перерисовке');

      await preferences.set({ userId: account.id, category: 'release', channel: 'in_service', enabled: true });
    },
  });
});

test('попытка выключить обязательное отклоняется и объясняется (§5)', { skip }, async () => {
  await withServer({
    user: account,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/settings/notifications')).text();

      const res = await post('/ru/settings/notifications', {
        csrf: csrfOf(page), category: 'moderation', channel: 'in_service', enabled: 'off',
      });
      assert.equal(res.status, 403, 'сервер отказывает даже при прямом запросе (R-SEC-24)');
      assert.match(await res.text(), /материал|материалов/i, 'и объясняет почему');

      const matrix = await preferences.matrix(account.id);
      assert.equal(matrix.moderation.in_service, true, 'категория осталась включённой');
    },
  });
});

test('чужая категория и канал не принимаются (R-SEC-16)', { skip }, async () => {
  // Свои настройки проверяются отдельно, здесь таблица должна быть пустой:
  // иначе «ничего не попало» проверяло бы чужую строку.
  await pool.query('DELETE FROM e_notification_preference WHERE user_id = ANY($1::bigint[])',
    [[account.id, staff.id]]);

  await withServer({
    user: account,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/settings/notifications')).text();

      for (const fields of [
        { category: 'нужно-всем', channel: 'in_service', enabled: 'off' },
        { category: 'release', channel: 'телеграм', enabled: 'off' },
      ]) {
        const res = await post('/ru/settings/notifications', { csrf: csrfOf(page), ...fields });
        assert.equal(res.status, 400, `мусор отклонён: ${fields.category}/${fields.channel}`);
      }

      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM e_notification_preference WHERE user_id = $1', [account.id],
      );
      assert.equal(rows[0].n, 0, 'и в таблицу ничего не попало');
    },
  });
});

test('тихие часы сохраняются с границами', { skip }, async () => {
  await withServer({
    user: account,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/settings/notifications')).text();

      const saved = await post('/ru/settings/notifications', {
        csrf: csrfOf(page), quiet_hours: 'on', quiet_from: '22:00', quiet_to: '07:30',
      });
      assert.equal(saved.status, 303);

      const { rows } = await pool.query(
        'SELECT quiet_hours, quiet_hours_from::text AS f, quiet_hours_to::text AS t FROM e_user WHERE id = $1',
        [account.id],
      );
      assert.equal(rows[0].quiet_hours, true, 'тихие часы включились');
      assert.equal(rows[0].f, '22:00:00');
      assert.equal(rows[0].t, '07:30:00');
    },
  });

  await pool.query('UPDATE e_user SET quiet_hours = FALSE WHERE id = $1', [account.id]);
});