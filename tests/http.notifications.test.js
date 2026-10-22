// Лента уведомлений и красная точка (F-03-09, S-31, UI-11).
//
// Проверки собраны в один файл намеренно: половина из них берёт одни и те же
// записи, а удаление чужих строк в уборке потребовало бы знать, что натворили
// соседние прогоны.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore, pgAuthStore } from '../src/services/auth/store.js';
import {
  createSessionMiddleware, createMemorySessionStore,
} from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { pgSeasons } from '../src/services/catalogue/season.js';
import { pgCatalogueList } from '../src/services/catalogue/list.js';
import { pgCollections } from '../src/services/catalogue/collection.js';
import { pgPerson } from '../src/services/catalogue/person.js';
import { pgCalendar } from '../src/services/catalogue/calendar.js';
import { pgWatchStatus } from '../src/services/tracking/status.js';
import { pgLibrary } from '../src/services/tracking/library.js';
import { pgSubscriptions } from '../src/services/tracking/subscription.js';
import { pgNotificationFeed, PAGE_SIZE, POLL_SECONDS } from '../src/services/notify/feed.js';
import { pgNotifications } from '../src/services/notify/notification.js';
import { todayIn } from '../src/services/timezone.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';
const TIMEZONE = 'Europe/Minsk';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — лента уведомлений не проверялась';

let pool;
let account;
let series;
let gone;
let feed;
let notifications;

/** Пишет уведомление напрямую: время важнее дедупликации. */
async function seed({ kind = 'release_today', category = null, params = {}, at = new Date(), read = false }) {
  const { rows } = await pool.query(
    `INSERT INTO e_notification (user_id, kind, category, params, dedup_key, created_at, read_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING id`,
    [
      account.id,
      kind,
      category ?? (kind === 'release_today' ? 'release' : 'reply'),
      JSON.stringify(params),
      `nt-test-${crypto.randomUUID()}`,
      at,
      read ? at : null,
    ],
  );
  return rows[0].id;
}

const seriesParams = (overrides = {}) => ({
  seriesSlug: series.slug,
  seriesTitle: 'Сериал из проверки',
  season: 1,
  episodes: [3],
  date: '2026-10-20',
  ...overrides,
});

test.before(async () => {
  if (!available) return;
  pool = createPool();
  feed = pgNotificationFeed(pool);
  notifications = pgNotifications(pool);

  const id = `nt-${crypto.randomUUID().slice(0, 8)}`;
  const { hash } = makeToken();
  const created = await pgAuthStore(pool).createUser({
    email: `${id}@example.com`,
    nickname: id,
    passwordHash: await hashPassword(PASSWORD),
    tokenHash: hash,
    timezone: TIMEZONE,
    locale: 'ru',
    theme: 'dark',
  });

  const rows = [];
  for (const suffix of ['', '-gone']) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
       VALUES ($1, 'Лента: уведомления', 'Notification feed', $2, 'published', 'airing', 2021)
       RETURNING id, slug`,
      [`${id}${suffix}`, 993_000_000 + rows.length],
    );
    rows.push(row);
  }
  [series, gone] = rows;
  await pool.query('INSERT INTO e_season (series_id, number) VALUES ($1, 1)', [series.id]);

  account = {
    id: created.id,
    email: `${id}@example.com`,
    password_hash: await hashPassword(PASSWORD),
    nickname: id,
    status: 'active',
    email_confirmed: true,
    locale: 'ru',
    theme: 'dark',
    timezone: TIMEZONE,
    recs_enabled: true,
    profile_public: false,
    stats_public: false,
  };
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_notification WHERE user_id = $1', [account.id]);
  await pool.query('DELETE FROM e_season WHERE series_id = ANY($1::bigint[])', [[series.id, gone.id]]);
  await pool.query('DELETE FROM e_series WHERE id = ANY($1::bigint[])', [[series.id, gone.id]]);
  await pool.query('DELETE FROM e_user WHERE id = $1', [account.id]);
  await pool.end();
});

// ─── Данные ленты ────────────────────────────────────────────────────────────

test('лента разложена по дням читателя, а не по дням сервера', { skip }, async () => {
  const today = todayIn(TIMEZONE);
  // Вчера по поясу читателя: день в ленте считается по нему, а не по UTC.
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = [
    yesterdayDate.getFullYear(),
    String(yesterdayDate.getMonth() + 1).padStart(2, '0'),
    String(yesterdayDate.getDate()).padStart(2, '0'),
  ].join('-');

  await seed({ params: seriesParams(), at: new Date() });
  await seed({ params: seriesParams({ episodes: [4] }), at: new Date() });
  await seed({ params: seriesParams({ episodes: [5] }), at: new Date(Date.now() - 86_400_000) });

  const data = await feed.feed({ userId: account.id, today });
  assert.equal(data.groups[0].day, today, 'первым идёт сегодняшний день');
  assert.equal(data.groups[0].items.length, 2, 'два уведомления сегодня');
  assert.equal(data.groups[1].day, yesterday, 'вчерашнее — своим днём');
  assert.equal(data.groups[1].items.length, 1);

  // Читатель в поясе впереди сервера получает день по-своему: сдвиг часового
  // пояса не должен переносить уведомление через полночь.
  const ahead = await feed.feed({ userId: account.id, today: '2099-01-01' });
  assert.equal(ahead.groups[0].day, today, 'подпись дня считается по поясу читателя');
});

test('открытая лента ничего не помечает прочитанным', { skip }, async () => {
  const id = await seed({ params: seriesParams() });

  await feed.feed({ userId: account.id, today: todayIn(TIMEZONE) });
  await feed.feed({ userId: account.id, today: todayIn(TIMEZONE) });

  const { rows } = await pool.query('SELECT read_at FROM e_notification WHERE id = $1', [id]);
  assert.equal(rows[0].read_at, null, 'просмотр ленты не читает её за человека');
});

test('чужая запись не читается и не удаляется (R-SEC-10)', { skip }, async () => {
  const id = await seed({ params: seriesParams() });

  const other = { id: 999_999_999 };
  assert.deepEqual(await feed.setRead({ userId: other.id, id, read: true }), { ok: false });
  assert.deepEqual(await feed.remove({ userId: other.id, id }), { ok: false });

  const { rows } = await pool.query('SELECT read_at FROM e_notification WHERE id = $1', [id]);
  assert.equal(rows[0].read_at, null, 'запись на месте и непрочитана');
});

test('открытие ведёт на серию одной серии, а группой — на сериал', { skip }, async () => {
  const one = await seed({ params: seriesParams({ episodes: [7] }) });
  const group = await seed({ params: seriesParams({ episodes: [1, 2, 3] }) });

  assert.equal(
    (await feed.open({ userId: account.id, id: one })).target,
    `/series/${series.slug}/seasons/1/episodes/7`,
  );
  assert.equal(
    (await feed.open({ userId: account.id, id: group })).target,
    `/series/${series.slug}`,
  );
});

test('снятый с публикации сериал не даёт ссылки (EC-T14)', { skip }, async () => {
  const id = await seed({ params: seriesParams({ seriesSlug: gone.slug }) });
  await pool.query(
    `UPDATE e_series SET publication_state = 'archived' WHERE id = $1`, [gone.id],
  );
  try {
    assert.deepEqual(await feed.open({ userId: account.id, id }), { ok: true, target: null },
      'ссылка ведёт туда, где человек сможет открыть, а не туда, где запись создана');

    const data = await feed.feed({ userId: account.id, today: todayIn(TIMEZONE) });
    const row = data.groups.flatMap((group) => group.items).find((item) => item.id === id);
    assert.equal(row.available, false, 'лента знает, что цели больше нет');
  } finally {
    await pool.query(
      `UPDATE e_series SET publication_state = 'published' WHERE id = $1`, [gone.id],
    );
  }
});

test('фильтр по категории и постраничность в 30 записей', { skip }, async () => {
  const before = (await pool.query(
    'SELECT count(*)::int AS n FROM e_notification WHERE user_id = $1', [account.id],
  )).rows[0].n;
  const many = [];
  for (let i = 0; i < PAGE_SIZE + 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    many.push(await seed({ params: seriesParams({ episodes: [i + 1] }) }));
  }

  const page = await feed.feed({ userId: account.id, today: todayIn(TIMEZONE) });
  assert.equal(page.items ?? page.groups.flatMap((g) => g.items).length, PAGE_SIZE,
    'на странице ровно столько, сколько велено настройкой');
  assert.equal(page.size, PAGE_SIZE);
  assert.equal(page.total, before + PAGE_SIZE + 3);

  const second = await feed.feed({ userId: account.id, page: 2, today: todayIn(TIMEZONE) });
  const ids1 = new Set(page.groups.flatMap((g) => g.items).map((r) => r.id));
  assert.equal(second.groups.flatMap((g) => g.items).some((r) => ids1.has(r.id)), false,
    'вторая страница не повторяет первую');

  // Категория фильтра отсекает чужие записи, а счётчик остаётся прежним:
  // фильтр сужает вид, а не данные.
  const onlyReply = await seed({ kind: 'reply', params: { materialId: 1 } });
  const filtered = await feed.feed({
    userId: account.id, category: 'reply', today: todayIn(TIMEZONE),
  });
  const ids = filtered.groups.flatMap((g) => g.items).map((r) => r.id);
  assert.deepEqual(ids, [onlyReply], 'в выдаче только запрошенная категория');

  for (const id of [...many, onlyReply]) {
    // eslint-disable-next-line no-await-in-loop
    await pool.query('DELETE FROM e_notification WHERE id = $1', [id]);
  }
});

test('хранение: срок и потолок, а непрочитанные живут дольше прочитанных', { skip }, async () => {
  // Проверка считает «последние непрочитанные», поэтому набор должен быть
  // ровно известным: чужие остатки сдвинули бы ожидаемый результат.
  await pool.query('DELETE FROM e_notification WHERE user_id = $1', [account.id]);

  // Возраст между сроками: 90 дней для прочитанного и 180 для непрочитанного.
  // Взятый за пределами обоих сроков тест проверял бы только уборку по возрасту
  // и ничего — про разницу между прочитанным и непрочитанным.
  const stale = new Date(Date.now() - 120 * 86_400_000);
  const oldRead = await seed({ params: seriesParams(), read: true, at: stale });
  const oldUnread = await seed({ params: seriesParams(), at: stale });
  const fresh = await seed({ params: seriesParams() });

  await feed.prune({ readDays: 90, unreadDays: 180 });
  const left = async () => (await pool.query(
    'SELECT id FROM e_notification WHERE id = ANY($1::bigint[]) ORDER BY id',
    [[oldRead, oldUnread, fresh]],
  )).rows.map((row) => row.id);

  assert.equal((await left()).includes(oldRead), false, 'прочитанное старше срока уходит');
  assert.equal((await left()).includes(oldUnread), true, 'непрочитанное живёт дольше');

  // Потолок на человека: остаются последние непрочитанные, а не случайные.
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    ids.push(await seed({ params: seriesParams({ episodes: [100 + i] }) }));
  }
  await feed.prune({ readDays: 90, unreadDays: 180, maxPerUser: 3 });

  const rest = (await pool.query(
    'SELECT id FROM e_notification WHERE user_id = $1 AND read_at IS NULL'
    + ' ORDER BY created_at DESC, id DESC',
    [account.id],
  )).rows;
  assert.equal(rest.length, 3, `непрочитанных осталось три, а не ${rest.length}`);
  // Остались новейшие из пяти (ids[2..4]): потолок оставляет именно их, и
  // проверка на «последние три» ловила бы случайный выбор из шести.
  assert.deepEqual(rest.map((row) => row.id).sort(), [...ids.slice(2)].sort(),
    'остались новейшие непрочитанные, а не случайные');

  await pool.query('DELETE FROM e_notification WHERE id = ANY($1::bigint[])',
    [[oldUnread, fresh, ...ids]]);
});

// ─── Интерфейс ───────────────────────────────────────────────────────────────

async function withServer({ signedIn = true, run }) {
  const app = createApp({
    data: stubData(),
    series: pgSeries(pool),
    catalogue: pgCatalogueList(pool),
    seasons: pgSeasons(pool),
    collections: pgCollections(pool),
    person: pgPerson(pool),
    calendar: pgCalendar(pool),
    watchStatus: pgWatchStatus(pool),
    library: pgLibrary(pool),
    subscriptions: pgSubscriptions(pool),
    feed,
    pool,
    auth: stubAuthStore({ [account.email]: account }),
    // createApp объявляет middleware сессий функцией, а модуль отдаёт обработчик
    // или их пару — Express принимает и то и другое.
    sessionMw: /** @type {any} */ (createSessionMiddleware(
      { query: async () => ({ rows: [] }), on: () => {} },
      createMemorySessionStore(),
      {
        account: async (user) => ({
          nickname: user.nickname,
          unread: await feed.unreadCount(user.id),
          pollSeconds: POLL_SECONDS,
        }),
      },
    )),
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
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
  const csrfOf = (body) => body.match(/name="csrf" value="([^"]+)"/)?.[1];

  if (signedIn) {
    const page = await (await get('/ru/login')).text();
    await post('/ru/login', { email: account.email, password: PASSWORD, csrf: csrfOf(page) });
  }

  try {
    await run({ get, post, csrfOf });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('гостя встречает приглашение войти, а не пустая лента', { skip }, async () => {
  await withServer({
    signedIn: false,
    run: async ({ get }) => {
      const res = await get('/ru/notifications');
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/ru/login?next=%2Fru%2Fnotifications');
    },
  });
});

test('лента показывает дни, непрочитанные выделяет и ничего не читает сама', { skip }, async () => {
  const id = await seed({ params: seriesParams() });

  await withServer({
    run: async ({ get }) => {
      const res = await get('/ru/notifications');
      const body = await res.text();

      assert.equal(res.status, 200);
      assert.match(body, /Сегодня/, 'день подписан по-человечески');
      assert.match(body, /notifications__item--unread/, 'непрочитанное выделено');
      assert.match(body, /<span class="visually-hidden">новое<\/span>/,
        'выделение не только цветом: для чтения с экрана есть слово');
      assert.match(body, /name="noindex"|noindex/, 'личная страница не индексируется');
      assert.match(body, /Сериал из проверки/, 'текст собран из параметров, а не из сохранённой строки');

      const { rows } = await pool.query('SELECT read_at FROM e_notification WHERE id = $1', [id]);
      assert.equal(rows[0].read_at, null, 'открытие ленты не читает её за человека');
    },
  });

  await pool.query('DELETE FROM e_notification WHERE id = $1', [id]);
});

test('красная точка и число на аватаре исчезают после «прочитать всё»', { skip }, async () => {
  const first = await seed({ params: seriesParams() });
  const second = await seed({ params: seriesParams({ episodes: [6] }) });

  await withServer({
    run: async ({ get, post, csrfOf }) => {
      const probe = await (await get('/ru/')).text();
      assert.ok(probe.includes('data-account-menu'), 'меню есть и на главной');
      const feedPage = await (await get('/ru/notifications')).text();
      assert.match(feedPage, /data-unread-dot/, 'точка на аватаре есть');
      assert.match(feedPage, /Уведомления\s*·\s*2/, 'в меню число, а не только точка');

      await post('/ru/notifications', { csrf: csrfOf(feedPage), action: 'read-all' });

      const home = await (await get('/ru/')).text();
      assert.ok(!home.includes('data-unread-dot'), 'после прочтения точки нет');
      const mark = /<details class="account"[^>]*>/.exec(home)?.[0];
      assert.match(String(mark), /data-notify-poll="60"/, 'опрос включается только меню');

      const counted = await (await get('/ru/notifications/count')).json();
      assert.deepEqual(counted, { unread: 0 }, 'счётчик для опроса совпадает с лентой');
    },
  });

  await pool.query('DELETE FROM e_notification WHERE id = ANY($1::bigint[])', [[first, second]]);
});

test('действия возвращают на ту же страницу и фильтр', { skip }, async () => {
  const id = await seed({ params: seriesParams() });

  await withServer({
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/notifications?category=release')).text();

      const read = await post('/ru/notifications', {
        csrf: csrfOf(page), action: 'read', id: String(id), page: '2', category: 'release',
      });
      assert.equal(read.status, 303);
      assert.equal(read.headers.get('location'), '/ru/notifications?page=2&category=release',
        'возврат на ту же страницу и фильтр: иначе чтение третьей страницы выкидывает на первую');

      const { rows } = await pool.query('SELECT read_at FROM e_notification WHERE id = $1', [id]);
      assert.ok(rows[0].read_at, 'запись прочитана');

      await post('/ru/notifications', {
        csrf: csrfOf(page), action: 'unread', id: String(id), page: '1',
      });
      const back = await pool.query('SELECT read_at FROM e_notification WHERE id = $1', [id]);
      assert.equal(back.rows[0].read_at, null, '«не прочитано» возвращает её в счётчик');

      await post('/ru/notifications', { csrf: csrfOf(page), action: 'remove', id: String(id) });
      const gone = await pool.query('SELECT id FROM e_notification WHERE id = $1', [id]);
      assert.equal(gone.rowCount, 0, 'удалённой записи нет');
    },
  });
});

test('без CSRF действие не выполняется', { skip }, async () => {
  const id = await seed({ params: seriesParams() });

  await withServer({
    run: async ({ post }) => {
      const res = await post('/ru/notifications', { action: 'remove', id: String(id) });
      assert.equal(res.status, 403);

      const { rows } = await pool.query('SELECT id FROM e_notification WHERE id = $1', [id]);
      assert.equal(rows.length, 1, 'запись осталась на месте');
    },
  });

  await pool.query('DELETE FROM e_notification WHERE id = $1', [id]);
});

test('текст уведомления собирается на языке читателя (R-I18N-14)', { skip }, async () => {
  const id = await seed({ params: seriesParams() });

  await withServer({
    run: async ({ get }) => {
      const ru = await (await get('/ru/notifications')).text();
      assert.match(ru, /Сегодня|Уведомления/);

      const en = await (await get('/en/notifications')).text();
      assert.match(en, /Notifications/);
      assert.match(en, /Today/, 'английская подпись дня приходит из строк, а не из русской строки');

      void notifications;
    },
  });

  await pool.query('DELETE FROM e_notification WHERE id = $1', [id]);
});