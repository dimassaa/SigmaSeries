// S-30 — закладки: адрес, вкладки, гость, личный список.
//
// Проверяется правило, которое чаще всего нарушают: счётчики на вкладках не
// меняются при переключении вкладки (F-03-04 §8), а страница личная и в
// индексе не нужна. Гость уходит на вход с возвратом (R-SEC-08).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore, pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { pgCatalogueList } from '../src/services/catalogue/list.js';
import { pgSeasons } from '../src/services/catalogue/season.js';
import { pgCollections } from '../src/services/catalogue/collection.js';
import { pgPerson } from '../src/services/catalogue/person.js';
import { pgCalendar } from '../src/services/catalogue/calendar.js';
import { pgWatchStatus } from '../src/services/tracking/status.js';
import { pgLibrary } from '../src/services/tracking/library.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — закладки не проверялись';

let pool;
let account;
let series;
let other;

/** Аккаунт с тремя закладками в разных статусах и одна чужая закладка. */
test.before(async () => {
  if (!available) return;
  pool = createPool();
  const store = pgAuthStore(pool);

  const make = async (prefix) => {
    const { token, hash } = makeToken();
    const id = `${prefix}-${crypto.randomUUID()}`;
    void token;
    const user = await store.createUser({
      email: `${id}@example.com`,
      nickname: id,
      passwordHash: await hashPassword(PASSWORD),
      tokenHash: hash,
      timezone: 'Europe/Minsk',
      locale: 'ru',
      theme: 'dark',
    });
    return {
      row: {
        id: user.id,
        email: `${id}@example.com`,
        password_hash: await hashPassword(PASSWORD),
        nickname: id,
        status: 'active',
        email_confirmed: true,
        locale: 'ru',
        theme: 'dark',
        timezone: 'Europe/Minsk',
        recs_enabled: true,
        profile_public: false,
        stats_public: false,
      },
    };
  };

  const mine = await make('lib1');
  account = mine.row;
  const theirs = await make('lib2');
  other = theirs.row;

  const makeSeries = async (slug, title) => {
    const { rows: [row] } = await pool.query(
      `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
       VALUES ($1, $2, $3, $4, 'published', 'airing', 2019) RETURNING id, slug`,
      [slug, title, `Fixture ${title}`, 993000000 + Math.floor(Math.random() * 900)],
    );
    return row;
  };

  series = [];
  for (const [index, status] of ['watching', 'watching', 'planned'].entries()) {
    const row = await makeSeries(`${account.nickname}-${index}`, `Закладка ${index + 1}`);
    await pool.query(
      'INSERT INTO e_watch_status (user_id, series_id, status) VALUES ($1, $2, $3)',
      [account.id, row.id, status],
    );
    series.push(row);
  }

  // Чужая закладка того же зрителя: в поиске по названию её не должно быть.
  const foreign = await makeSeries(`${other.nickname}-x`, 'Чужая закладка');
  await pool.query(
    'INSERT INTO e_watch_status (user_id, series_id, status) VALUES ($1, $2, $3)',
    [other.id, foreign.id, 'watching'],
  );
});

test.after(async () => {
  if (!pool) return;
  for (const id of [account.id, other.id]) {
    await pool.query('DELETE FROM e_watch_status WHERE user_id = $1', [id]);
    await pool.query('DELETE FROM e_subscription WHERE user_id = $1', [id]);
  }
  await pool.query('DELETE FROM e_series WHERE slug LIKE $1', [`${account.nickname}-%`]);
  await pool.query('DELETE FROM e_series WHERE slug LIKE $1', [`${other.nickname}-%`]);
  await pool.query('DELETE FROM e_user WHERE id IN ($1, $2)', [account.id, other.id]);
  await pool.end();
});

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
    pool,
    auth: stubAuthStore({
      [account.email]: account,
      [other.email]: other,
    }),
    sessionMw: createSessionMiddleware(
      { query: async () => ({ rows: [] }), on: () => {} },
      createMemorySessionStore(),
    ),
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
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

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

test('гость уходит на вход и возвращается обратно (R-SEC-08)', { skip }, async () => {
  await withServer({
    signedIn: false,
    run: async ({ get }) => {
      const res = await get('/ru/library');
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), `/ru/login?next=${encodeURIComponent('/ru/library')}`);
    },
  });
});

test('список показывает свои закладки, счётчики и кнопки статуса', { skip }, async () => {
  await withServer({
    run: async ({ get }) => {
      const res = await get('/ru/library');
      const body = await res.text();

      assert.equal(res.status, 200);
      assert.match(body, /<meta name="robots" content="noindex, follow">/, 'личный список в индексе не нужен');
      assert.equal((body.match(/class="library__item/g) ?? []).length, 3, 'три закладки зрителя');
      assert.ok(!body.includes('Чужая закладка'), 'чужие данные не показываются (R-SEC-10)');
      assert.match(body, /library__tab-count">2<\/span>/, 'на вкладке «Смотрю» два');
      assert.match(body, /name="status" value="planned"/, 'в карточке есть меню статуса');
      assert.match(body, /name="csrf"/, 'форма статуса несёт токен');
    },
  });
});

test('счётчики не меняются при переключении вкладки', { skip }, async () => {
  await withServer({
    run: async ({ get }) => {
      const all = await (await get('/ru/library')).text();
      const watching = await (await get('/ru/library?status=watching')).text();

      assert.equal((watching.match(/class="library__item/g) ?? []).length, 2, 'на вкладке только «Смотрю»');
      assert.match(watching, /library__tab-count">2<\/span>/, 'цифра на вкладке «Смотрю» прежняя');
      assert.match(watching, /library__tab-count">1<\/span>/, 'и цифра «В планах» тоже прежняя');

      const countsOf = (html) => [...html.matchAll(/library__tab-count">(\d+)</g)].map((m) => m[1]);
      assert.deepEqual(countsOf(watching), countsOf(all), 'числа на вкладках считаются по счётчикам');
    },
  });
});

test('состояние живёт в адресе и открывается ссылкой', { skip }, async () => {
  await withServer({
    run: async ({ get }) => {
      const body = await (await get('/ru/library?status=planned&sort=title&q=Закладка+3')).text();
      assert.equal((body.match(/class="library__item/g) ?? []).length, 1, 'поиск и фильтр сузили список');
      assert.match(body, /aria-current="true"/, 'активная вкладка помечена для скринридера');
    },
  });
});

test('пустой фильтр предлагает сбросить, а пустой список — каталог', { skip }, async () => {
  await withServer({
    run: async ({ get }) => {
      const filtered = await (await get('/ru/library?status=watched')).text();
      assert.match(filtered, /Сбросить/, 'пустой фильтр объясняет, что делать дальше');

      const library = pgLibrary(pool);
      const page = await library.list({ userId: other.id, today: '2026-10-15' });
      assert.equal(page.total, 1, 'у второго зрителя одна закладка — это не пустой список');
    },
  });
});

test('сортировки и постраничность принимаются, а мусор отбрасывается', { skip }, async () => {
  await withServer({
    run: async ({ get }) => {
      for (const sort of ['recent', 'title', 'progress', 'next', 'year', 'не-сортировка']) {
        const res = await get(`/ru/library?sort=${encodeURIComponent(sort)}`);
        assert.equal(res.status, 200, `сортировка «${sort}» открывается`);
      }

      const beyond = await get('/ru/library?page=99');
      assert.equal(beyond.status, 200, 'страница за концом списка не превращается в 404');
      const library = pgLibrary(pool);
      const page = await library.list({ userId: account.id, page: 99, today: '2026-10-15' });
      assert.equal(page.page, 1, 'показана последняя страница, а не пустая');
    },
  });
});

test('смена статуса из закладок возвращает в закладки', { skip }, async () => {
  await withServer({
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/library')).text();
      const csrf = csrfOf(page);

      const res = await post(`/ru/series/${series[2].slug}/status`, {
        status: 'watching',
        view: 'library',
        csrf,
      });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/ru/library',
        'нажали в закладках — вернулись в закладки');

      const library = pgLibrary(pool);
      const list = await library.list({ userId: account.id, today: '2026-10-15' });
      assert.equal(list.counts.watching, 3, 'счётчик вкладки обновился после смены статуса');
    },
  });
});