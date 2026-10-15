// Кнопка статуса на странице сериала (F-03-01).
//
// Проверяется то, что видит человек и что происходит при нажатии: гость
// получает приглашение с возвратом на то же место (R-SEC-08), вошедший меняет
// статус одной кнопкой, подделка без токена отклоняется, а слишком частые
// запросы получают 429 (R-SEC-31).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword } from '../src/services/auth/password.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { pgCatalogueList } from '../src/services/catalogue/list.js';
import { pgSeasons } from '../src/services/catalogue/season.js';
import { pgCollections } from '../src/services/catalogue/collection.js';
import { pgPerson } from '../src/services/catalogue/person.js';
import { pgCalendar } from '../src/services/catalogue/calendar.js';
import { pgWatchStatus } from '../src/services/tracking/status.js';
import { createRateLimiter } from '../src/services/limits.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
// Сессии настоящие: подделанный токен CSRF должен проверяться по-настоящему.
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — кнопка статуса не проверялась';

let pool;

/** Аккаунт и сериал фикстуры; убираются в `test.after`. */
let account;
let series;

test.before(async () => {
  if (!available) return;
  pool = createPool();

  const { token, hash } = makeToken();
  const id = `btn-${crypto.randomUUID()}`;
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

  const { rows: [row] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state)
     VALUES ($1, 'Кнопка статуса', 'Status button fixture', $2, 'published', 'airing')
     RETURNING id, slug`,
    [id, 995000000 + (Number(id.replace(/\D/g, '').slice(0, 4)) || 1)],
  );

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
  series = row;
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_watch_status WHERE user_id = $1', [account.id]);
  await pool.query('DELETE FROM e_subscription WHERE user_id = $1', [account.id]);
  await pool.query('DELETE FROM e_series WHERE id = $1', [series.id]);
  await pool.query('DELETE FROM e_user WHERE id = $1', [account.id]);
  await pool.end();
});

/**
 * Сервер с настоящей базой и заглушкой входа.
 *
 * Хранилище заглушено, сессии настоящие: замена нужна только чтобы войти без
 * пароля, а статус зрителя хранится в базе по-настоящему.
 */
async function withServer({ signedIn, run, ratePerMinute = 60 }) {
  const app = createApp({
    // Счётчик частоты — свой на каждый сервер: общий копил бы запросы от
    // одного теста к следующему, и проверка лимита зависела бы от порядка.
    statusLimiter: createRateLimiter({ limit: ratePerMinute, windowMs: 60_000 }),
    data: stubData(),
    series: pgSeries(pool),
    catalogue: pgCatalogueList(pool),
    seasons: pgSeasons(pool),
    collections: pgCollections(pool),
    person: pgPerson(pool),
    calendar: pgCalendar(pool),
    watchStatus: pgWatchStatus(pool),
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

test('гость видит приглашение с возвратом на эту же серию', { skip }, async () => {
  await withServer({
    signedIn: false,
    run: async ({ get }) => {
      const body = await (await get(`/ru/series/${series.slug}`)).text();

      assert.match(body, /Войдите, чтобы отметить/, 'гость не получает кнопку, которую не нажмёт');
      const href = body.match(/href="(\/ru\/login\?next=[^"]+)"/)?.[1];
      assert.ok(href, 'приглашение ведёт на вход');
      assert.match(decodeURIComponent(href), new RegExp(`/ru/series/${series.slug}`),
        'после входа человек вернётся туда же (R-SEC-08)');
    },
  });
});

test('POST без сессии уводит на вход и не пишет статус', { skip }, async () => {
  await withServer({
    signedIn: false,
    run: async ({ post }) => {
      const res = await post(`/ru/series/${series.slug}/status`, { status: 'watching' });
      assert.equal(res.status, 303);

      const location = res.headers.get('location');
      assert.match(decodeURIComponent(location), /^\/ru\/login\?next=/);

      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM e_watch_status WHERE user_id = $1 AND series_id = $2',
        [account.id, series.id],
      );
      assert.equal(rows[0].n, 0, 'чужой или гостевой запрос не создал строку');
    },
  });
});

test('вошедший меняет статус одной кнопкой и возвращается на страницу', { skip }, async () => {
  await withServer({
    signedIn: true,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      assert.match(page, /name="status" value="watching"/,
        'у кого статуса нет — кнопка и есть «Смотрю»');

      const res = await post(`/ru/series/${series.slug}/status`, {
        status: 'watching',
        csrf: csrfOf(page),
      });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), `/ru/series/${series.slug}`,
        'человек возвращается туда, откуда нажал');

      const { rows } = await pool.query(
        'SELECT status FROM e_watch_status WHERE user_id = $1 AND series_id = $2',
        [account.id, series.id],
      );
      assert.equal(rows[0].status, 'watching');

      const withStatus = await (await get(`/ru/series/${series.slug}`)).text();
      assert.match(withStatus, /data-status="watching"/, 'кнопка показывает текущий статус');
      assert.match(withStatus, /name="status" value="planned"/, 'остальные статусы — в меню');
      assert.ok(!withStatus.includes('status__primary'),
        'после выбора статуса «Смотрю» больше не primary — иначе на странице два главных действия');
    },
  });
});

test('подписка на выходы следует за статусом (H-70)', { skip }, async () => {
  await withServer({
    signedIn: true,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      await post(`/ru/series/${series.slug}/status`, { status: 'watching', csrf: csrfOf(page) });

      const { rows } = await pool.query(
        `SELECT enabled FROM e_subscription WHERE user_id = $1 AND series_id = $2 AND kind = 'release'`,
        [account.id, series.id],
      );
      assert.equal(rows.length, 1, 'подписка создана — иначе «Мои» в календаре всегда пуст');
      assert.equal(rows[0].enabled, true);
    },
  });
});

test('подделка без токена отклоняется', { skip }, async () => {
  await withServer({
    signedIn: true,
    run: async ({ post }) => {
      const res = await post(`/ru/series/${series.slug}/status`, { status: 'dropped', csrf: 'чужой' });
      assert.equal(res.status, 403);

      // Проверяем именно «не изменилось»: предыдущие тесты уже создали строку
      // статуса, и сравнивать с нулём тут нельзя.
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM e_watch_status WHERE user_id = $1 AND series_id = $2 AND status = $3',
        [account.id, series.id, 'dropped'],
      );
      assert.equal(rows[0].n, 0, 'без токена статус не записан (R-SEC-23)');
    },
  });
});

test('чужая страница не может сменить статус чужому сериалу', { skip }, async () => {
  await withServer({
    signedIn: true,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      // Подмена slug на несуществующий: такой сериала просто нет.
      const res = await post('/ru/series/такого-сериала-нет/status', {
        status: 'watching',
        csrf: csrfOf(page),
      });
      assert.equal(res.status, 404);
    },
  });
});

test('слишком частые смены статуса получают 429 с Retry-After (R-SEC-31)', { skip }, async () => {
  await withServer({
    signedIn: true,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(page);

      let limited = false;
      for (let i = 0; i < 70; i += 1) {
        const res = await post(`/ru/series/${series.slug}/status`, { status: 'planned', csrf });
        if (res.status === 429) {
          limited = true;
          assert.ok(res.headers.get('retry-after'), '429 обязан говорить, когда повторить');
          break;
        }
      }
      assert.ok(limited, 'шестьдесят смен в минуту — предел, а не пожелание');
    },
  });
});

test('«Убрать» удаляет статус и выключает подписку', { skip }, async () => {
  await withServer({
    signedIn: true,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const res = await post(`/ru/series/${series.slug}/status`, { status: '', csrf: csrfOf(page) });
      assert.equal(res.status, 303);

      const status = await pool.query('SELECT count(*)::int AS n FROM e_watch_status WHERE user_id = $1', [account.id]);
      assert.equal(status.rows[0].n, 0);

      const sub = await pool.query(
        `SELECT enabled FROM e_subscription WHERE user_id = $1 AND series_id = $2 AND kind = 'release'`,
        [account.id, series.id],
      );
      assert.equal(sub.rows[0].enabled, false);
    },
  });
});