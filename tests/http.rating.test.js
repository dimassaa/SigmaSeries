// Оценка сериала: приём запроса и показ (F-04-01, OP-03).
//
// Проверяется через настоящий HTTP, потому что правила модуля в основном
// серверные: гость, нет отметки, чужой сериал, лимит частоты. Защита от
// подделки запроса проверяется здесь же — прямым POST без сессии.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword } from '../src/services/auth/password.js';
import crypto from 'node:crypto';

import { pgRatings } from '../src/services/rating/store.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { RATING } from '../src/config/settings.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';
const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — оценка через HTTP не проверялась';

let pool;
/** Номера сериалов фикстуры — их убирает `test.after`. */
const fixtures = [];

/**
 * Зритель для HTTP-проверки.
 *
 * Аккаунт создаётся по-настоящему: правило «оценить можно только с отметкой
 * и подтверждённым адресом» читает `e_user` и `e_watch_mark`, и подставной
 * идентификатор без строки в базе отвечал бы отказом на любую оценку —
 * проверка зеленела бы вовсе не по той причине.
 *
 * @returns {Promise<object>} строка для заглушки хранилища с настоящим `id`
 */
const viewer = async () => {
  const { hash } = makeToken();
  const email = `rate-http-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const created = await pgAuthStore(pool).createUser({
    email,
    nickname: `rate-http-${crypto.randomUUID().slice(0, 4)}`,
    passwordHash: await hashPassword(PASSWORD),
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  await pool.query('UPDATE e_user SET email_confirmed = TRUE WHERE id = $1', [created.id]);
  return {
    id: created.id,
    email,
    email_enc: null,
    password_hash: await hashPassword(PASSWORD),
    nickname: 'anna',
    status: 'active',
    email_confirmed: true,
    locale: 'ru',
    theme: 'dark',
    timezone: 'Europe/Minsk',
  };
};

/** Отметка просмотра — без неё оценить нельзя (EC-V1). */
async function mark(userId, episodeId) {
  await pool.query(
    `INSERT INTO e_watch_mark (user_id, episode_id, precision) VALUES ($1, $2, 'exact')
     ON CONFLICT DO NOTHING`,
    [userId, episodeId],
  );
}

/** Сериал с одной серией: `number` — чтобы разные проверки не мешали. */
async function seriesWith(number) {
  fixtures.push(number);
  const { rows: [seriesRow] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Оценка фикстуры', 'Rating fixture', $2, 'published', 'airing', 2024) RETURNING id, slug`,
    [`rating-http-${number}-${crypto.randomUUID().slice(0, 6)}`, 980_000_000 + number],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [seriesRow.id],
  );
  const { rows: [episode] } = await pool.query(
    `INSERT INTO e_episode (season_id, number, title_ru, runtime_min)
     VALUES ($1, 1, 'Серия', 45) RETURNING id`, [season.id],
  );
  return { ...seriesRow, episodeId: episode.id };
}

/**
 * Сервер с настоящей базой: маршрут оценки проверяет право по `e_user`,
 * `e_watch_mark` и `e_rating`, и заглушка здесь сказала бы «да» на всё.
 */
async function withServer({ user, run, limiter }) {
  const auth = stubAuthStore(user ? { [user.email]: user } : {});
  const app = createApp({
    data: stubData(),
    auth,
    series: pgSeries(pool),
    ratings: pgRatings(pool),
    ratingLimiter: limiter,
    sessionMw: createSessionMiddleware(pool, createMemorySessionStore(), {
      account: async (u) => ({ nickname: u.nickname, unread: 0, pollSeconds: 0 }),
    }),
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
  const post = (path, fields, init = {}) => get(path, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(init.headers ?? {}) },
    body: new URLSearchParams(fields),
  });
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

  if (user) {
    const form = await (await get('/ru/login')).text();
    await post('/ru/login', { email: user.email, password: PASSWORD, csrf: csrfOf(form) });
  }

  try {
    await run({ get, post, csrfOf });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
});

test.after(async () => {
  if (!pool) return;
  // Фикстуры убираются в порядке внешних ключей: оценки и сезоны ссылаются на
  // сериал, а удалить сериал раньше них нельзя (ON DELETE RESTRICT). Без
  // уборки они остались бы в общей базе и мешали чужим проверкам — например,
  // поиску по названию.
  for (const prefix of ['rating-', 'rating-http-%']) {
    if (prefix.endsWith('-%')) continue;
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `DELETE FROM e_rating WHERE series_id IN (SELECT id FROM e_series WHERE slug LIKE $1)`, [`${prefix}%`],
    );
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `DELETE FROM e_season WHERE series_id IN (SELECT id FROM e_series WHERE slug LIKE $1)`, [`${prefix}%`],
    );
    // eslint-disable-next-line no-await-in-loop
    await pool.query(`DELETE FROM e_series WHERE slug LIKE $1`, [`${prefix}%`]);
  }
  await pool.end();
});

test('оценка без отметки просмотра отклоняется сервером (EC-V1)', { skip }, async () => {
  const user = await viewer();
  const seriesRow = await seriesWith(1);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${seriesRow.slug}`)).text();
      const res = await post(`/ru/series/${seriesRow.slug}/rating`, {
        value: '8', csrf: csrfOf(page),
      });

      assert.equal(res.status, 303);
      assert.match(res.headers.get('location'), /rating=no-mark/, 'причина отказа названа прямо');
      const row = await pool.query(
        `SELECT count(*)::int AS n FROM e_rating WHERE user_id = $1 AND series_id = $2`,
        [user.id, seriesRow.id],
      );
      assert.equal(row.rows[0].n, 0, 'в базе пусто: кнопка недоступна, значит и сервер отказывает');
    },
  });
});

test('гость отправляется во вход с возвратом на страницу (R-SEC-08)', { skip }, async () => {
  const seriesRow = await seriesWith(2);

  await withServer({
    run: async ({ get, post }) => {
      const page = await (await get(`/ru/series/${seriesRow.slug}`)).text();
      const res = await post(`/ru/series/${seriesRow.slug}/rating`, {
        value: '8', csrf: page.match(/name="csrf" value="([^"]+)"/)?.[1],
      });

      assert.equal(res.status, 303);
      const location = res.headers.get('location');
      assert.match(location, /^\/ru\/login\?next=/, 'гость видит форму входа, а не отказ');
      const next = decodeURIComponent(location.split('next=')[1]);
      assert.ok(next.startsWith(`/${'ru'}/series/${seriesRow.slug}`), 'возврат на ту же страницу');
      assert.ok(!next.includes('://'), 'адрес внутренний: открытое перенаправление запрещено');
    },
  });
});

test('оценка без токена не принимается (R-SEC-23)', { skip }, async () => {
  const user = await viewer();
  const seriesRow = await seriesWith(3);

  await withServer({
    user,
    run: async ({ post }) => {
      const res = await post(`/ru/series/${seriesRow.slug}/rating`, { value: '8' });
      assert.equal(res.status, 403);
    },
  });
});

test('слишком частые оценки получают 429 (R-SEC-31)', { skip }, async () => {
  const user = await viewer();
  const seriesRow = await seriesWith(4);
  await mark(user.id, seriesRow.episodeId);

  // Предел в одну попытку: проверяется ответ лимита, а не сорок запросов подряд.
  const limiter = { allow: () => false, windowMs: 3_600_000 };
  await withServer({
    user,
    limiter,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${seriesRow.slug}`)).text();
      const res = await post(`/ru/series/${seriesRow.slug}/rating`, {
        value: '8', csrf: csrfOf(page),
      });

      assert.equal(res.status, 429);
      assert.ok(Number(res.headers.get('retry-after')) > 0, 'нужен Retry-After');
    },
  });

  assert.equal(RATING.ratePerHour, 30, 'предел из таблицы настроек M4 §0');
});

test('оценка сохраняется и видна на странице сериала', { skip }, async () => {
  const user = await viewer();
  const seriesRow = await seriesWith(5);
  await mark(user.id, seriesRow.episodeId);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${seriesRow.slug}`)).text();
      assert.match(page, /Ваша оценка/, 'блок оценки нарисован');

      const res = await post(`/ru/series/${seriesRow.slug}/rating`, {
        value: '8', csrf: csrfOf(page),
      });
      assert.equal(res.status, 303);

      const after = await (await get(`/ru/series/${seriesRow.slug}`)).text();
      assert.match(after, /rating-value--on|value="8"[^>]*checked/, 'выбранное значение отмечено');
    },
  });

  const stored = await pool.query(
    `SELECT value, counted FROM e_rating WHERE user_id = $1 AND series_id = $2`,
    [user.id, seriesRow.id],
  );
  assert.equal(stored.rows.length, 1, 'оценка записана в базу');
  assert.equal(stored.rows[0].value, 8);
});