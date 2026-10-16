// Колокольчик подписки в интерфейсе (F-03-07): путь «нажал → увидел».
//
// Проверяется вместе с живой базой: правило H-70 живёт на стыке статуса и
// подписки, и «работает» оно только когда меняются обе таблицы.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { createRateLimiter } from '../src/services/limits.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore, pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
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

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — колокольчик в интерфейсе не проверялся';

let pool;
let account;
let series;
let other;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  const { token, hash } = makeToken();
  const id = `hs-${crypto.randomUUID()}`;
  void token;

  const created = await pgAuthStore(pool).createUser({
    email: `${id}@example.com`,
    nickname: id,
    passwordHash: await hashPassword(PASSWORD),
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
  });

  const rows = [];
  for (const suffix of ['', '-2']) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
       VALUES ($1, 'Подписка: интерфейс', 'Subscription in UI', $2, 'published', 'airing', 2020)
       RETURNING id, slug`,
      [`${id}${suffix}`, 992000000 + (Number(id.replace(/\D/g, '').slice(0, 4)) || 1) * 10 + rows.length],
    );
    rows.push(row);
  }
  [series, other] = rows;
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
    timezone: 'Europe/Minsk',
    recs_enabled: true,
    profile_public: false,
    stats_public: false,
  };
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_subscription WHERE user_id = $1', [account.id]);
  await pool.query('DELETE FROM e_watch_status WHERE user_id = $1', [account.id]);
  await pool.query('DELETE FROM e_progress WHERE user_id = $1', [account.id]);
  await pool.query('DELETE FROM e_season WHERE series_id = ANY($1::bigint[])', [[series.id, other.id]]);
  await pool.query('DELETE FROM e_series WHERE id = ANY($1::bigint[])', [[series.id, other.id]]);
  await pool.query('DELETE FROM e_series WHERE slug LIKE $1', [`hs-%-fill-%`]);
  await pool.query('DELETE FROM e_user WHERE id = $1', [account.id]);
  await pool.end();
});

async function withServer({ signedIn = true, limiter = null, run }) {
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
    subscribeLimiter: limiter,
    pool,
    auth: stubAuthStore({ [account.email]: account }),
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

const bellOf = (body) => body.match(/class="subs__button[^"]*"[\s\S]*?aria-pressed="(\w+)"/)?.[1];
const targetOf = (body) => body.match(/name="on" value="(\d)"/)?.[1];

test('гость видит приглашение, а не кнопку (F-03-07 §4)', { skip }, async () => {
  await withServer({
    signedIn: false,
    run: async ({ get }) => {
      const body = await (await get(`/ru/series/${series.slug}`)).text();

      assert.ok(body.includes('subs--guest'), 'гостю объясняют, что делать');
      assert.match(body, /Войдите, чтобы следить за выходом/);
      assert.ok(!body.includes('name="on"'), 'и не показывают форму, которая всё равно не сработает');
    },
  });
});

test('вошедший видит выключенный колокольчик и включает его', { skip }, async () => {
  await withServer({
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      assert.equal(bellOf(page), 'false', 'подписки ещё нет');
      assert.equal(targetOf(page), '1', 'и кнопка предлагает включить');

      const res = await post(`/ru/series/${series.slug}/subscribe`, { on: '1', csrf: csrfOf(page) });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), `/ru/series/${series.slug}`);

      const after = await (await get(`/ru/series/${series.slug}`)).text();
      assert.equal(bellOf(after), 'true', 'состояние видно сразу после нажатия');
      assert.equal(targetOf(after), '0', 'и следующее нажатие выключает, а не «переключает вообще»');
    },
  });
});

test('после «Смотрю» подписка включена автоматически и это сказано', { skip }, async () => {
  await withServer({
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${other.slug}`)).text();
      await post(`/ru/series/${other.slug}/status`, { status: 'watching', csrf: csrfOf(page) });

      const after = await (await get(`/ru/series/${other.slug}`)).text();
      assert.equal(bellOf(after), 'true', 'статус «Смотрю» включает подписку');
      assert.match(after, /Включено автоматически/,
        'и человек видит, что это сделала автоматика, а не он');
    },
  });
});

test('ручное выключение переживает «Смотрю» (EC-T19)', { skip }, async () => {
  await withServer({
    run: async ({ get, post, csrfOf }) => {
      let page = await (await get(`/ru/series/${other.slug}`)).text();
      await post(`/ru/series/${other.slug}/subscribe`, { on: '0', csrf: csrfOf(page) });

      page = await (await get(`/ru/series/${other.slug}`)).text();
      assert.equal(bellOf(page), 'false');
      assert.match(page, /Выключено вручную/,
        'и сказано, что смена статуса не включит обратно — иначе отказаться невозможно');

      await post(`/ru/series/${other.slug}/status`, { status: 'watched', csrf: csrfOf(page) });
      await post(`/ru/series/${other.slug}/status`, { status: 'watching', csrf: csrfOf(page) });

      const after = await (await get(`/ru/series/${other.slug}`)).text();
      assert.equal(bellOf(after), 'false',
        'человек выключил уведомления — «Смотрю» их не включает обратно');
    },
  });
});

test('подделка без токена не переключает подписку (R-SEC-23)', { skip }, async () => {
  await withServer({
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${other.slug}`)).text();
      const before = bellOf(page);

      const res = await post(`/ru/series/${other.slug}/subscribe`, { on: '1', csrf: 'чужой' });
      assert.equal(res.status, 403);

      const after = await (await get(`/ru/series/${other.slug}`)).text();
      assert.equal(bellOf(after), before, 'состояние не изменилось');
    },
  });
});

test('слишком частые нажатия получают 429 с Retry-After (R-SEC-31)', { skip }, async () => {
  // Счётчик свой и с низким пределом: общий копит запросы от прогона к прогону,
  // и проверка лимита зависела бы от того, что нажали раньше в этом же файле.
  await withServer({
    limiter: createRateLimiter({ limit: 3, windowMs: 60_000 }),
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(page);

      let limited = null;
      for (let i = 0; i < 6 && !limited; i += 1) {
        const res = await post(`/ru/series/${series.slug}/subscribe`, { on: i % 2 ? '0' : '1', csrf });
        if (res.status === 429) limited = res;
      }

      assert.ok(limited, 'предел — это предел, а не пожелание');
      assert.equal(limited.headers.get('retry-after'), '60', 'и сказано, когда повторить');
    },
  });
});

test('нажатие в карточке закладки возвращает в закладки', { skip }, async () => {
  await withServer({
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/library')).text();
      const res = await post(`/ru/series/${series.slug}/subscribe`, { on: '0', view: 'library', csrf: csrfOf(page) });

      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/ru/library',
        'человек остался там, где нажал, а не на странице сериала');
    },
  });
});

test('потолок подписок объясняется, а не игнорируется', { skip }, async () => {
  // Заполняем потолок прямо в базе: проверяется отказ, а не способ наполнения.
  const { rows: fillers } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     SELECT $1 || '-fill-' || g, 'Заполнитель', 'Filler', 991000000 + g, 'published', 'airing', 2020
       FROM generate_series(1, 500) AS g
     RETURNING id`,
    [series.slug],
  );
  await pool.query(
    `INSERT INTO e_subscription (user_id, series_id, kind, source, enabled)
     SELECT $1, unnest($2::bigint[]), 'release', 'manual', true`,
    [account.id, fillers.map((item) => item.id)],
  );

  try {
    await withServer({
      run: async ({ get, post, csrfOf }) => {
        const page = await (await get(`/ru/series/${series.slug}`)).text();
        const res = await post(`/ru/series/${series.slug}/subscribe`, { on: '1', csrf: csrfOf(page) });
        assert.equal(res.status, 303);
        assert.match(res.headers.get('location'), /subs=limit/);

        const after = await (await get(res.headers.get('location'))).text();
        assert.match(after, /Подписок слишком много, отключите ненужные/,
          'человеку сказано, что делать, а не показано молчание');
        assert.equal(bellOf(after), 'false', 'и подписка не включилась');
      },
    });
  } finally {
    await pool.query('DELETE FROM e_subscription WHERE user_id = $1', [account.id]);
  }
});
