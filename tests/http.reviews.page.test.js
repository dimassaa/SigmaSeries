// Страница отзыва по HTTP (F-04-09, S-10).
//
// Проверяется то, что видно снаружи: код ответа, полный текст (в списке он
// обрезан), шапка с сериалом, `noindex`, язык текста и права на действия.
// Выборка проверяется отдельно, в `reviews.list.test.js`; здесь — маршрут и
// разметка.
//
// Фикстуры настоящие: страница читает базу, и заглушка отвечала бы «да» на
// всё и скрыла бы расхождение прав и показа (EC-V1).

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore, pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { pgRatings } from '../src/services/rating/store.js';
import { pgReviews } from '../src/services/reviews/store.js';
import { pgReviewList } from '../src/services/reviews/list.js';
import { pgReviewVotes } from '../src/services/reviews/votes.js';
import { pgReviewReports } from '../src/services/reviews/reports.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';
const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — страница отзыва по HTTP не проверялась';
const PREFIX = 'review-page-http-%';

let pool;
let reviews;
let ratings;

const CLEAN = { block: [], allow: [], available: true };
const DOWN = { block: [], allow: [], available: false };

/** Человек: взрослый подтверждённый аккаунт — оценка сразу входит в рейтинг (EC-V4). */
async function viewer() {
  const { hash } = makeToken();
  const email = `review-page-http-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const nickname = `review-page-http-${crypto.randomUUID().slice(0, 8)}`;
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
     VALUES ($1, 'Сериал страницы', 'Review page', $2, 'published', 'airing', 2024) RETURNING id, slug`,
    [`review-page-http-${number}-${crypto.randomUUID().slice(0, 6)}`, 973_000_000 + number],
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

/** Отзыв от имени человека: отметка, оценка и текст одним действием. */
async function write({ user, series, text, spoiler = false, lang = 'ru', rating = 8, dictionary = CLEAN }) {
  await mark(user.id, series.id);
  const rated = await ratings.setSeriesRating({ userId: user.id, seriesId: series.id, value: rating });
  assert.equal(rated.ok, true, `оценка должна записаться: ${rated.reason ?? ''}`);
  const res = await reviews.submit({
    userId: user.id, seriesId: series.id, body: text, spoiler, lang, dictionary,
  });
  assert.equal(res.ok, true, `отзыв должен записаться: ${res.reason ?? ''}`);
  const { rows: [row] } = await pool.query(
    `SELECT id FROM e_material WHERE author_id = $1 AND series_id = $2 ORDER BY id DESC LIMIT 1`,
    [user.id, series.id],
  );
  return Number(row.id);
}

/** Сервер с настоящей базой; вход настоящий, пароль проверяется как обычно. */
async function withServer({ user = null, run }) {
  const app = createApp({
    data: stubData(),
    auth: stubAuthStore(user ? { [user.email]: user } : {}),
    series: pgSeries(pool),
    ratings: pgRatings(pool),
    reviews: pgReviews(pool),
    reviewList: pgReviewList(pool),
    votes: pgReviewVotes(pool),
    reports: pgReviewReports(pool),
    dictionary: { load: async () => CLEAN },
    // createApp объявляет middleware сессий функцией, а модуль отдаёт обработчик
    // или их пару — Express принимает и то и другое.
    sessionMw: /** @type {any} */ (createSessionMiddleware(pool, createMemorySessionStore(), {
      account: async (u) => ({ nickname: u.nickname, unread: 0, pollSeconds: 0 }),
    })),
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
  reviews = pgReviews(pool);
  ratings = pgRatings(pool);
});

test.after(async () => {
  if (!pool) return;
  const ids = `SELECT id FROM e_series WHERE slug LIKE $1`;
  await pool.query(`DELETE FROM e_helpful_vote WHERE material_id IN (SELECT id FROM e_material WHERE series_id IN (${ids}))`, [PREFIX]);
  await pool.query(`DELETE FROM e_material WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_rating WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_watch_mark WHERE episode_id IN (
    SELECT e.id FROM e_episode e JOIN e_season s ON s.id = e.season_id WHERE s.series_id IN (${ids}))`, [PREFIX]);
  await pool.query(`DELETE FROM e_season WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_series WHERE slug LIKE $1`, [PREFIX]);
  await pool.end();
});

test('страница отзыва: полный текст, шапка с сериалом, noindex (F-04-09 §18)', { skip }, async () => {
  const series = await seriesWith(1);
  const author = await viewer();
  // Текст длиннее `review.read_more_chars`: в списке он обрезан, здесь — нет.
  const long = `Отзыв целиком, без обрезки. ${'Подробности серии, о которых стоит сказать. '.repeat(20)}КОНЕЦ-ХВОСТА`;
  const id = await write({ user: author, series, text: long });

  await withServer({
    run: async ({ get }) => {
      const res = await get(`/ru/reviews/${id}`);
      assert.equal(res.status, 200);
      const html = await res.text();

      assert.match(html, /КОНЕЦ-ХВОСТА/, 'страница показывает текст целиком, а не начало');
      assert.match(html, /<meta name="robots" content="noindex, follow">/, 'страница не индексируется');
      assert.match(html, /lang="ru"/, 'у текста отзыва свой язык');
      assert.match(html, new RegExp(`href="/ru/series/${series.slug}"`), 'шапка ведёт на карточку сериала');
      assert.match(html, /Оценка автора/, 'оценка автора названа');
      assert.match(html, new RegExp(author.nickname), 'ник автора на странице');
    },
  });
});

test('нет отзыва — 404; чужой язык адреса — тоже 404 (F-04-09 §5)', { skip }, async () => {
  const series = await seriesWith(2);
  const author = await viewer();
  const id = await write({ user: author, series, text: 'Отзыв, которого нет на странице' });

  await withServer({
    run: async ({ get }) => {
      const missing = await get('/ru/reviews/987654321');
      assert.equal(missing.status, 404, 'несуществующий отзыв — 404');

      const broken = await get('/xx/reviews/1');
      assert.equal(broken.status, 404, 'неизвестный язык адреса — 404');
    },
  });
});

test('неопубликованный отзыв — 404 (F-04-09 §5)', { skip }, async () => {
  const series = await seriesWith(3);
  const author = await viewer();
  const id = await write({
    user: author, series, text: 'Отзыв, который ждёт проверки словаря', dictionary: DOWN,
  });

  await withServer({
    run: async ({ get }) => {
      const res = await get(`/ru/reviews/${id}`);
      assert.equal(res.status, 404, 'неопубликованный отзыв читателю не виден');
    },
  });
});

test('сериал снят с публикации — 410 (EC-V14)', { skip }, async () => {
  const series = await seriesWith(4);
  const author = await viewer();
  const id = await write({ user: author, series, text: 'Отзыв о сериале, который сняли' });
  await pool.query(`UPDATE e_series SET archived_at = now() WHERE id = $1`, [series.id]);

  await withServer({
    run: async ({ get }) => {
      const res = await get(`/ru/reviews/${id}`);
      assert.equal(res.status, 410, 'снятый с публикации сериал — 410, а не 404');
    },
  });
});

test('гость: счётчик и предложение войти, без формы (F-04-06 §6)', { skip }, async () => {
  const series = await seriesWith(5);
  const author = await viewer();
  const id = await write({ user: author, series, text: 'Отзыв, который гость читает' });

  await withServer({
    run: async ({ get }) => {
      const html = await (await get(`/ru/reviews/${id}`)).text();
      assert.match(html, /Войдите/, 'гостю предлагают войти');
      assert.ok(!html.includes('data-review-vote'), 'у гостя нет формы голоса');
    },
  });
});

test('зритель: форма «Полезно» с токеном (R-SEC-23)', { skip }, async () => {
  const series = await seriesWith(6);
  const author = await viewer();
  const reader = await viewer();
  const id = await write({ user: author, series, text: 'Отзыв, которому читатель помогает' });

  await withServer({
    user: reader,
    run: async ({ get }) => {
      const html = await (await get(`/ru/reviews/${id}`)).text();
      assert.match(html, /data-review-vote/, 'у зрителя есть форма голоса');
      assert.match(html, new RegExp(`action="/ru/series/${series.slug}/reviews/${id}/helpful"`), 'форма ведёт на действие');
      assert.match(html, /name="csrf" value="[^"]+"/, 'у формы есть токен');
    },
  });
});

test('автору кнопка «Полезно» неактивна (EC-V15)', { skip }, async () => {
  const series = await seriesWith(7);
  const author = await viewer();
  const id = await write({ user: author, series, text: 'Отзыв, который читает его автор' });

  await withServer({
    user: author,
    run: async ({ get }) => {
      const html = await (await get(`/ru/reviews/${id}`)).text();
      assert.match(html, /aria-disabled="true"/, 'автору кнопка неактивна');
      assert.ok(!html.includes('data-review-vote'), 'у автора нет формы голоса');
    },
  });
});

test('текст отзыва не исполняется (R-SEC-14)', { skip }, async () => {
  const series = await seriesWith(8);
  const author = await viewer();
  // Без ссылки: отзыв со ссылкой модерация отправляет в очередь (DEC-015),
  // и до решения он читателю не виден — проверять было бы нечего.
  const id = await write({
    user: author, series, text: 'Текст с <script>alert(1)</script> внутри и <b>жирным</b>',
  });

  await withServer({
    run: async ({ get }) => {
      const res = await get(`/ru/reviews/${id}`);
      assert.equal(res.status, 200, 'отзыв без ссылки публикуется и открывается');
      const html = await res.text();
      assert.ok(!html.includes('<script>alert(1)</script>'), 'скрипт из отзыва не попал в разметку');
      assert.match(html, /&lt;script&gt;/, 'теги показаны текстом');
      assert.ok(!html.includes('<b>жирным</b>'), 'чужие теги не стали разметкой');
    },
  });
});

test('спойлер свёрнут целиком (M4 §8д)', { skip }, async () => {
  const series = await seriesWith(9);
  const author = await viewer();
  const id = await write({
    user: author, series, text: 'В отзыве спойлер к финалу второго сезона', spoiler: true,
  });

  await withServer({
    run: async ({ get }) => {
      const html = await (await get(`/ru/reviews/${id}`)).text();
      assert.match(html, /<details class="review-page__spoiler"|<details class="reviews__spoiler"/, 'спойлер свёрнут');
      assert.match(html, /data-nosnippet/, 'спойлер не попадает в сниппеты');
    },
  });
});
