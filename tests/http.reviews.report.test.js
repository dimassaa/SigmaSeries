// Жалоба на отзыв по HTTP (F-04-07, S-06/S-09).
//
// Проверяется маршрут и порядок отказов: вход, CSRF, потолок частоты,
// причина и длина, права сервиса, формы состояний возврата (отправлено /
// уже подано / ошибка формы). Приёмка «трое разных — материал скрыт до
// решения» и «повтор без записи» — на уровне сервиса
// (`reviews.reports.test.js`): маршрут не добавляет к ней новых правил.
// Разметку меню и диалога проверяет вид в `http.reviews.list.test.js`.

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
import { pgReviewReports } from '../src/services/reviews/reports.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';
const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — жалоба по HTTP не проверялась';
const PREFIX = 'review-report-http-%';

let pool;
let ratings;
let reviews;

/**
 * Человек со статусом: подтверждённый — «Зритель» и взрослый аккаунт,
 * иначе подтверждение остаётся снять.
 */
async function viewer({ confirmed = true } = {}) {
  const { hash } = makeToken();
  const email = `review-report-http-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const nickname = `review-report-http-${crypto.randomUUID().slice(0, 8)}`;
  const passwordHash = await hashPassword(PASSWORD);
  const created = await pgAuthStore(pool).createUser({
    email,
    nickname,
    passwordHash,
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed,
  });
  if (confirmed) {
    // Взрослый аккаунт: оценка фикстуры не должна упираться в EC-V4.
    await pool.query(
      `UPDATE e_user SET email_confirmed = TRUE, registered_at = now() - interval '30 days' WHERE id = $1`,
      [created.id],
    );
  } else {
    await pool.query(`UPDATE e_user SET email_confirmed = FALSE WHERE id = $1`, [created.id]);
  }
  return {
    id: created.id,
    email,
    nickname,
    email_enc: null,
    password_hash: passwordHash,
    status: 'active',
    email_confirmed: confirmed,
    locale: 'ru',
    theme: 'dark',
    timezone: 'Europe/Minsk',
  };
}

async function seriesWith(number) {
  const { rows: [seriesRow] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Жалоба HTTP', 'Report HTTP', $2, 'published', 'airing', 2024) RETURNING id, slug`,
    [`review-report-http-${number}-${crypto.randomUUID().slice(0, 6)}`, 976_000_000 + number],
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

const CLEAN = { block: [], allow: [], available: true };

/** Отзыв от имени человека: отметка, оценка и текст одним действием. */
async function write({ user, series, text = 'Отзыв жалобы: текст длиннее двадцати знаков.' }) {
  await pool.query(
    `INSERT INTO e_watch_mark (user_id, episode_id, precision)
     SELECT $1, e.id, 'exact' FROM e_episode e
       JOIN e_season s ON s.id = e.season_id
      WHERE s.series_id = $2 ORDER BY e.id LIMIT 1
     ON CONFLICT DO NOTHING`,
    [user.id, series.id],
  );
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

const reportsInDb = async (materialId) => {
  const { rows: [row] } = await pool.query(
    'SELECT count(*)::int AS n FROM e_report WHERE material_id = $1', [materialId],
  );
  return row.n;
};

/** Сервер: настоящий список и жалобы; узкий лимит подставляется для 429. */
async function withServer({ user = null, limiter = null, run }) {
  const app = createApp({
    data: stubData(),
    auth: stubAuthStore(user ? { [user.email]: user } : {}),
    series: pgSeries(pool),
    ratings: pgRatings(pool),
    reviews: pgReviews(pool),
    reviewList: pgReviewList(pool),
    reports: pgReviewReports(pool),
    reportLimiter: limiter,
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
    await /** @type {Promise<void>} */ (new Promise((r) => server.close(r)));
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
  await pool.query(`DELETE FROM e_report WHERE material_id IN (SELECT id FROM e_material WHERE series_id IN (${ids}))`, [PREFIX]);
  await pool.query(`DELETE FROM e_helpful_vote WHERE material_id IN (SELECT id FROM e_material WHERE series_id IN (${ids}))`, [PREFIX]);
  await pool.query(`DELETE FROM e_material WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_rating WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_restriction WHERE user_id IN (
    SELECT id FROM e_user WHERE nickname LIKE 'review-report-http-%')`);
  await pool.query(`DELETE FROM e_watch_mark WHERE episode_id IN (
    SELECT e.id FROM e_episode e JOIN e_season s ON s.id = e.season_id WHERE s.series_id IN (${ids}))`, [PREFIX]);
  await pool.query(`DELETE FROM e_season WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_series WHERE slug LIKE $1`, [PREFIX]);
  await pool.end();
});

test('гость по прямому POST уходит на вход, жалоба не записывается', { skip }, async () => {
  const series = await seriesWith(1);
  const author = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    run: async ({ post }) => {
      const res = await post(`/ru/series/${series.slug}/reviews/${reviewId}/report`, { reason: 'spam' });
      assert.equal(res.status, 303, 'гость получает вход, а не ошибку');
      assert.match(res.headers.get('location') ?? '', /^\/ru\/login\?next=/, 'R-SEC-08: вход с возвратом');
      assert.equal(await reportsInDb(reviewId), 0, 'жалобы нет');
    },
  });
});

test('чужой CSRF-токен — 403, жалоба не записывается', { skip }, async () => {
  const series = await seriesWith(2);
  const author = await viewer();
  const reader = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    user: reader,
    run: async ({ post }) => {
      const res = await post(`/ru/series/${series.slug}/reviews/${reviewId}/report`, {
        reason: 'spam', csrf: 'неверный-токен',
      });
      assert.equal(res.status, 403, 'CSRF отклоняет запрос без токена сессии');
      assert.equal(await reportsInDb(reviewId), 0);
    },
  });
});

test('потолок суток: сверхлимитный запрос — 429 с Retry-After по окну дня', { skip }, async () => {
  const series = await seriesWith(3);
  const author = await viewer();
  const reader = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    user: reader,
    limiter: createRateLimiter({ limit: 1, windowMs: 24 * 60 * 60 * 1000 }),
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(page);
      const first = await post(`/ru/series/${series.slug}/reviews/${reviewId}/report`, {
        reason: 'spam', csrf,
      }, { headers: { Accept: 'application/json' } });
      assert.equal(first.status, 200, `первая жалоба проходит: ${first.status}`);

      const second = await post(`/ru/series/${series.slug}/reviews/${reviewId}/report`, {
        reason: 'spam', csrf,
      });
      assert.equal(second.status, 429, `вторым же запросом: ${second.status}`);
      assert.equal(second.headers.get('retry-after'), '86400', 'окно суток названо в секундах');
      assert.equal(await reportsInDb(reviewId), 1, 'лимит отсекает запись, а не портит её');
    },
  });
});

test('причина вне списка и комментарий длиннее 300 — 400; ровно 300 проходит', { skip }, async () => {
  const series = await seriesWith(4);
  const author = await viewer();
  const reader = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    user: reader,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(page);
      const json = { headers: { Accept: 'application/json' } };

      const badReason = await post(`/ru/series/${series.slug}/reviews/${reviewId}/report`, {
        reason: 'свой-список', comment: '', csrf,
      }, json);
      assert.equal(badReason.status, 400, `причина должна быть из списка: ${badReason.status}`);
      const badReasonBody = await badReason.json();
      assert.deepEqual(badReasonBody, { error: 'reason' });
      assert.equal(await reportsInDb(reviewId), 0);

      const badComment = await post(`/ru/series/${series.slug}/reviews/${reviewId}/report`, {
        reason: 'other', comment: 'х'.repeat(301), csrf,
      }, json);
      assert.equal(badComment.status, 400);
      assert.deepEqual(await badComment.json(), { error: 'comment' });
      assert.equal(await reportsInDb(reviewId), 0, 'длинный комментарий жалобы не пишет');
    },
  });

  await withServer({
    user: reader,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(page);
      const edge = await post(`/ru/series/${series.slug}/reviews/${reviewId}/report`, {
        reason: 'other', comment: 'х'.repeat(300), csrf,
      }, { headers: { Accept: 'application/json' } });
      assert.equal(edge.status, 200, 'ровно 300 знаков проходит (граница, не «примерно»)');
      assert.deepEqual(await edge.json(), { reported: true });
      assert.equal(await reportsInDb(reviewId), 1);
    },
  });
});

test('свой отзыв — 403; чужая витрина и несуществующий отзыв — 404', { skip }, async () => {
  const series = await seriesWith(5);
  const other = await seriesWith(6);
  const author = await viewer();
  const reader = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    user: author,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(page);
      // Автор жалуется на свой отзыв напрямую, без формы в меню: у
      // собственного отзыва меню не рисуется вовсе, токен — с формы
      // «Удалить» собственной карточки.
      const own = await post(`/ru/series/${series.slug}/reviews/${reviewId}/report`, {
        reason: 'other', comment: '', csrf,
      }, { headers: { Accept: 'application/json' } });
      assert.equal(own.status, 403, `жалоба на свой отзыв не проходит (own): ${own.status}`);
      assert.equal(await reportsInDb(reviewId), 0);
    },
  });

  await withServer({
    user: reader,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(page);
      const wrongSeries = await post(`/ru/series/${other.slug}/reviews/${reviewId}/report`, {
        reason: 'other', csrf,
      });
      assert.equal(wrongSeries.status, 404, 'отзыв чужой витрины из адреса недоступен');

      const missing = await post(`/ru/series/${other.slug}/reviews/999999/report`, {
        reason: 'other', csrf,
      });
      assert.equal(missing.status, 404, 'несуществующий отзыв');
    },
  });
});

test('неподтверждённый аккаунт не жалуется — не «Зритель» (403)', { skip }, async () => {
  const series = await seriesWith(7);
  const author = await viewer();
  const stranger = await viewer({ confirmed: false });
  const reviewId = await write({ user: author, series });

  await withServer({
    user: stranger,
    run: async ({ get, post, csrfOf }) => {
      // У неподтверждённого нет формы голоса: токен берётся из формы выхода
      // в шапке — она есть у любого вошедшего.
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(page);
      const res = await post(`/ru/series/${series.slug}/reviews/${reviewId}/report`, {
        reason: 'other', csrf,
      }, { headers: { Accept: 'application/json' } });
      assert.equal(res.status, 403, `сервис называет право, а не молчит: ${res.status}`);
      assert.equal(await reportsInDb(reviewId), 0);
    },
  });
});

test('повторная жалоба: формой — возврат «уже подано», JSON — 409 без второй строки', { skip }, async () => {
  const series = await seriesWith(8);
  const author = await viewer();
  const reader = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    user: reader,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(page);
      const json = { headers: { Accept: 'application/json' } };

      const first = await post(`/ru/series/${series.slug}/reviews/${reviewId}/report`, {
        reason: 'spoiler', comment: 'Спойлер в заголовке', csrf,
      }, json);
      assert.equal(first.status, 200, `первая жалоба принята: ${first.status}`);
      assert.deepEqual(await first.json(), { reported: true });
      assert.equal(await reportsInDb(reviewId), 1);

      const againJson = await post(`/ru/series/${series.slug}/reviews/${reviewId}/report`, {
        reason: 'spam', comment: '', csrf,
      }, json);
      assert.equal(againJson.status, 409, 'повторная жалоба — уже подано');
      assert.deepEqual(await againJson.json(), { already: true });

      const againForm = await post(`/ru/series/${series.slug}/reviews/${reviewId}/report`, {
        reason: 'spam', comment: '', csrf, back: '/ru/series/x',
      });
      assert.equal(againForm.status, 303);
      assert.match(againForm.headers.get('location') ?? '', /reported=\d+&again=1$/);
      assert.equal(await reportsInDb(reviewId), 1, 'вторая строка не пишется (EC-V16)');
    },
  });
});

test('ошибка формы без скрипта: возврат в состояние формы с названной ошибкой', { skip }, async () => {
  const series = await seriesWith(9);
  const author = await viewer();
  const reader = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    user: reader,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(page);
      const res = await post(`/ru/series/${series.slug}/reviews/${reviewId}/report`, {
        reason: 'придумано', comment: 'текст с комментарием', csrf,
        back: `/ru/series/${series.slug}`,
      });
      assert.equal(res.status, 303, 'браузерная форма возвращается в диалог, а не в текст ошибки');
      const where = res.headers.get('location') ?? '';
      assert.match(where, /\?report=\d+&err=reason&c=/, 'ошибка названа, комментарий придёт с собой');
      assert.match(where, /c=%D1%82%D0%B5%D0%BA%D1%81%D1%82%20%D1%81/, 'URL-encoded comment');
      assert.equal(await reportsInDb(reviewId), 0);

      const json = await post(`/ru/series/${series.slug}/reviews/${reviewId}/report`, {
        reason: 'other', comment: 'х'.repeat(301), csrf,
      }, { headers: { Accept: 'application/json' } });
      assert.equal(json.status, 400, 'скрипт берёт 400 и показывает ошибку в диалоге сам');
    },
  });
});

test('успех формой: возврат на страницу с фильтрами в состоянии «отправлено»', { skip }, async () => {
  const series = await seriesWith(10);
  const author = await viewer();
  const reader = await viewer();
  const reviewId = await write({ user: author, series });

  await withServer({
    user: reader,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(page);
      const res = await post(`/ru/series/${series.slug}/reviews/${reviewId}/report`, {
        reason: 'offtopic', comment: '', csrf,
        back: `/ru/series/${series.slug}/reviews?group=long&page=2`,
      });
      assert.equal(res.status, 303);
      const where = res.headers.get('location') ?? '';
      assert.match(where, /group=long&page=2&reported=\d+$/, 'состояние дописывается к запросу, не ломая его');
      assert.equal(await reportsInDb(reviewId), 1);
    },
  });
});
