// Голос «Полезно» по HTTP (F-04-06, S-09).
//
// Проверяется маршрут и порядок отказов: вход, CSRF, потолок частоты, цель,
// существование сериала и отзыва. Приёмка «поставил → снял» — на уровне
// сервиса (`reviews.votes.test.js`), разметку кнопки проверяет вид в
// `http.reviews.list.test.js`.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore, pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { createRateLimiter } from '../src/services/limits.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { pgRatings } from '../src/services/rating/store.js';
import { pgReviews } from '../src/services/reviews/store.js';
import { pgReviewList } from '../src/services/reviews/list.js';
import { pgReviewVotes } from '../src/services/reviews/votes.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';
const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — голос по HTTP не проверялся';
const PREFIX = 'review-vote-http-%';

let pool;
let ratings;
let reviews;

/** Человек: подтверждённый аккаунт — «Зритель». */
async function viewer() {
  const { hash } = makeToken();
  const email = `review-vote-http-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const nickname = `review-vote-http-${crypto.randomUUID().slice(0, 8)}`;
  const passwordHash = await hashPassword(PASSWORD);
  const created = await pgAuthStore(pool).createUser({
    email,
    nickname,
    passwordHash,
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  // Взрослый аккаунт: оценка фикстуры не должна упираться в EC-V4.
  await pool.query(
    `UPDATE e_user SET email_confirmed = TRUE, registered_at = now() - interval '30 days' WHERE id = $1`,
    [created.id],
  );
  return {
    id: created.id,
    email,
    nickname,
    email_enc: null,
    password_hash: passwordHash,
    status: 'active',
    email_confirmed: true,
    locale: 'ru',
    theme: 'dark',
    timezone: 'Europe/Minsk',
  };
}

async function seriesWith(number) {
  const { rows: [seriesRow] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Голос HTTP', 'Vote HTTP', $2, 'published', 'airing', 2024) RETURNING id, slug`,
    [`review-vote-http-${number}-${crypto.randomUUID().slice(0, 6)}`, 975_000_000 + number],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [seriesRow.id],
  );
  await pool.query(
    `INSERT INTO e_episode (season_id, number, title_ru, runtime_min)
     VALUES ($1, 1, 'Серия', 45)`, [season.id],
  );
  return seriesRow;
}

async function mark(userId, seriesId) {
  const { rows: [episode] } = await pool.query(
    `SELECT e.id FROM e_episode e JOIN e_season s ON s.id = e.season_id
      WHERE s.series_id = $1 ORDER BY e.id LIMIT 1`,
    [seriesId],
  );
  await pool.query(
    `INSERT INTO e_watch_mark (user_id, episode_id, precision) VALUES ($1, $2, 'exact')
     ON CONFLICT DO NOTHING`,
    [userId, episode.id],
  );
}

const CLEAN = { block: [], allow: [], available: true };

/** Отзыв от имени человека: отметка, оценка и текст одним действием. */
async function write({ user, series, text = 'Отзыв голоса: текст длиннее двадцати знаков.' }) {
  await mark(user.id, series.id);
  const rate = await ratings.setSeriesRating({ userId: user.id, seriesId: series.id, value: 8 });
  assert.equal(rate.ok, true, `оценка должна записаться: ${rate.reason ?? ''}`);
  const res = await reviews.submit({
    userId: user.id, seriesId: series.id, body: text, spoiler: false, lang: 'ru', dictionary: CLEAN,
  });
  assert.equal(res.ok, true, `отзыв должен записаться: ${res.reason ?? ''}`);
  const { rows: [material] } = await pool.query(
    `SELECT id FROM e_material WHERE author_id = $1 AND series_id = $2 AND kind = 'review'`,
    [user.id, series.id],
  );
  return Number(material.id);
}

const votesInDb = async (materialId) => {
  const { rows: [row] } = await pool.query(
    'SELECT count(*)::int AS n FROM e_helpful_vote WHERE material_id = $1', [materialId],
  );
  return row.n;
};

/** Сервер: настоящий список и голоса, узкий лимит подставляется для 429. */
async function withServer({ user = null, limiter = null, run }) {
  const app = createApp({
    data: stubData(),
    auth: stubAuthStore(user ? { [user.email]: user } : {}),
    series: pgSeries(pool),
    ratings: pgRatings(pool),
    reviews: pgReviews(pool),
    reviewList: pgReviewList(pool),
    votes: pgReviewVotes(pool),
    helpfulLimiter: limiter,
    dictionary: { load: async () => CLEAN },
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
  ratings = pgRatings(pool);
  reviews = pgReviews(pool);
});

test.after(async () => {
  if (!pool) return;
  const ids = 'SELECT id FROM e_series WHERE slug LIKE $1';
  await pool.query(`DELETE FROM e_helpful_vote WHERE material_id IN (SELECT id FROM e_material WHERE series_id IN (${ids}))`, [PREFIX]);
  await pool.query(`DELETE FROM e_material WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_rating WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_watch_mark WHERE episode_id IN (
    SELECT e.id FROM e_episode e JOIN e_season s ON s.id = e.season_id WHERE s.series_id IN (${ids}))`, [PREFIX]);
  await pool.query(`DELETE FROM e_season WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_series WHERE slug LIKE $1`, [PREFIX]);
  await pool.end();
});

test('гость по прямому POST уходит на вход и голос не записывает', { skip }, async () => {
  const series = await seriesWith(11);
  const author = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    run: async ({ post }) => {
      const res = await post(`/ru/series/${series.slug}/reviews/${reviewId}/helpful`, { to: 'set' });
      assert.equal(res.status, 303, 'гость получает вход, а не ошибку');
      assert.match(res.headers.get('location') ?? '', /^\/ru\/login\?next=/, 'R-SEC-08: вход с возвратом');
      assert.equal(await votesInDb(reviewId), 0, 'голоса нет');
    },
  });
});

test('поставить: 303 на адрес возврата с фильтрами; снять тем же адресом', { skip }, async () => {
  const series = await seriesWith(12);
  const author = await viewer();
  const reader = await viewer();
  const reviewId = await write({ user: author, series });
  const back = `/ru/series/${series.slug}/reviews?group=positive`;

  await withServer({
    user: reader,
    run: async ({ get, post, csrfOf }) => {
      const csrf = csrfOf(await (await get(`/ru/series/${series.slug}`)).text());

      const set = await post(`/ru/series/${series.slug}/reviews/${reviewId}/helpful`, { csrf, to: 'set', back });
      assert.equal(set.status, 303, 'успех — возврат на ту же страницу');
      assert.equal(set.headers.get('location'), back, 'фильтры адреса возврата сохранены');
      assert.equal(await votesInDb(reviewId), 1);

      const unset = await post(`/ru/series/${series.slug}/reviews/${reviewId}/helpful`, { csrf, to: 'unset', back });
      assert.equal(unset.status, 303);
      assert.equal(unset.headers.get('location'), back);
      assert.equal(await votesInDb(reviewId), 0);
    },
  });
});

test('повторное «поставить» не дублирует голос (идемпотентность через HTTP)', { skip }, async () => {
  const series = await seriesWith(13);
  const author = await viewer();
  const reader = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    user: reader,
    run: async ({ get, post, csrfOf }) => {
      const csrf = csrfOf(await (await get(`/ru/series/${series.slug}`)).text());
      const action = `/ru/series/${series.slug}/reviews/${reviewId}/helpful`;
      await post(action, { csrf, to: 'set' });
      await post(action, { csrf, to: 'set' });
      assert.equal(await votesInDb(reviewId), 1, 'одна пара пользователь–отзыв, не две');
    },
  });
});

test('снять голос, которого нет, — успех без изменений', { skip }, async () => {
  const series = await seriesWith(14);
  const author = await viewer();
  const reader = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    user: reader,
    run: async ({ get, post, csrfOf }) => {
      const csrf = csrfOf(await (await get(`/ru/series/${series.slug}`)).text());
      const res = await post(`/ru/series/${series.slug}/reviews/${reviewId}/helpful`, { csrf, to: 'unset' });
      assert.equal(res.status, 303, 'идемпотентность примитива, а не ошибка');
      assert.equal(await votesInDb(reviewId), 0);
    },
  });
});

test('свой отзыв не принимает голос (EC-V15): 403, состояние не меняется', { skip }, async () => {
  const series = await seriesWith(15);
  const author = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    user: author,
    run: async ({ get, post, csrfOf }) => {
      const csrf = csrfOf(await (await get(`/ru/series/${series.slug}`)).text());
      const res = await post(`/ru/series/${series.slug}/reviews/${reviewId}/helpful`, { csrf, to: 'set' });
      assert.equal(res.status, 403);
      assert.match(await res.text(), /Свой отзыв/);
      assert.equal(await votesInDb(reviewId), 0);
    },
  });
});

test('неподтверждённый аккаунт получает отказ сервера', { skip }, async () => {
  const series = await seriesWith(16);
  const author = await viewer();
  const newcomer = await viewer();
  const reviewId = await write({ user: author, series });

  await pool.query('UPDATE e_user SET email_confirmed = FALSE WHERE id = $1', [newcomer.id]);

  await withServer({
    user: newcomer,
    run: async ({ get, post, csrfOf }) => {
      const csrf = csrfOf(await (await get(`/ru/series/${series.slug}`)).text());
      const res = await post(`/ru/series/${series.slug}/reviews/${reviewId}/helpful`, { csrf, to: 'set' });
      assert.equal(res.status, 403);
      assert.match(await res.text(), /email/i);
      assert.equal(await votesInDb(reviewId), 0);
    },
  });
});

test('несуществующий отзыв и не тот сериал — 404, не ошибка сервера', { skip }, async () => {
  const series = await seriesWith(17);
  const author = await viewer();
  const reader = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    user: reader,
    run: async ({ get, post, csrfOf }) => {
      const csrf = csrfOf(await (await get(`/ru/series/${series.slug}`)).text());
      const noReview = await post(`/ru/series/${series.slug}/reviews/999000000/helpful`, { csrf, to: 'set' });
      assert.equal(noReview.status, 404);
      assert.match(await noReview.text(), /не найден/i);

      const noSeries = await post(`/ru/series/no-such-series-########/reviews/${reviewId}/helpful`, { csrf, to: 'set' });
      assert.equal(noSeries.status, 404);
      assert.equal(await votesInDb(reviewId), 0);
    },
  });
});

test('чужая цель (`to`) не проходит: 400', { skip }, async () => {
  const series = await seriesWith(18);
  const author = await viewer();
  const reader = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    user: reader,
    run: async ({ get, post, csrfOf }) => {
      const csrf = csrfOf(await (await get(`/ru/series/${series.slug}`)).text());
      const res = await post(`/ru/series/${series.slug}/reviews/${reviewId}/helpful`, { csrf, to: 'toggle' });
      assert.equal(res.status, 400, 'цель объявляет кнопка, не угадывается');
      assert.equal(await votesInDb(reviewId), 0);
    },
  });
});

test('без CSRF — 403', { skip }, async () => {
  const series = await seriesWith(19);
  const author = await viewer();
  const reader = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    user: reader,
    run: async ({ post }) => {
      const res = await post(`/ru/series/${series.slug}/reviews/${reviewId}/helpful`, { to: 'set' });
      assert.equal(res.status, 403);
      assert.match(await res.text(), /Сессия устарела/);
      assert.equal(await votesInDb(reviewId), 0);
    },
  });
});

test('потолок частоты: 429 с Retry-After', { skip }, async () => {
  const series = await seriesWith(20);
  const author = await viewer();
  const reader = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    user: reader,
    limiter: createRateLimiter({ limit: 1, windowMs: 60_000 }),
    run: async ({ get, post, csrfOf }) => {
      const csrf = csrfOf(await (await get(`/ru/series/${series.slug}`)).text());
      const action = `/ru/series/${series.slug}/reviews/${reviewId}/helpful`;
      await post(action, { csrf, to: 'set' });
      const again = await post(action, { csrf, to: 'unset' });
      assert.equal(again.status, 429);
      assert.ok(Number(again.headers.get('retry-after')) > 0, 'Retry-After назван секундами');
      assert.match(await again.text(), /Слишком часто/);
    },
  });
});

test('запрос из скрипта (Accept: application/json) получает JSON без перенаправления', { skip }, async () => {
  const series = await seriesWith(21);
  const author = await viewer();
  const reader = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    user: reader,
    run: async ({ get, post, csrfOf }) => {
      const csrf = csrfOf(await (await get(`/ru/series/${series.slug}`)).text());
      const action = `/ru/series/${series.slug}/reviews/${reviewId}/helpful`;
      const set = await post(action, { csrf, to: 'set' }, { headers: { accept: 'application/json' } });
      assert.equal(set.status, 200, 'скрипту не нужно следовать за редиректом');
      assert.deepEqual(await set.json(), { voted: true, count: 1 });

      const unset = await post(action, { csrf, to: 'unset' }, { headers: { accept: 'application/json' } });
      assert.deepEqual(await unset.json(), { voted: false, count: 0 });
    },
  });
});
