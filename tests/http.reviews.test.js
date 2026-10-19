// Отзыв через HTTP: отправка, правка, удаление, отказы (F-04-04).
//
// Проверяется то, что видно снаружи: коды ответов, куда ведёт возврат,
// что оказывается в базе и какие слова видит человек. Право и конвейер
// живут на сервере, поэтому заглушка здесь отвечала бы «да» на всё.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { pgRatings } from '../src/services/rating/store.js';
import { pgReviews } from '../src/services/reviews/store.js';
import { pgDictionary } from '../src/services/moderation/dictionary.js';
import { createRateLimiter } from '../src/services/limits.js';
import { REVIEW, HOUR } from '../src/config/settings.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';
const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — отзыв через HTTP не проверялся';

let pool;
const fixtures = [];
const BODY = 'Хороший сериал, пересматриваю второй раз и нахожу новое';

async function viewer() {
  const { hash } = makeToken();
  const email = `review-http-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const created = await pgAuthStore(pool).createUser({
    email,
    nickname: `review-http-${crypto.randomUUID().slice(0, 8)}`,
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

async function seriesWith(number) {
  fixtures.push(number);
  const { rows: [seriesRow] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Отзыв HTTP', 'Review HTTP', $2, 'published', 'airing', 2024) RETURNING id, slug`,
    [`review-http-${number}-${crypto.randomUUID().slice(0, 6)}`, 960_000_000 + number],
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
 * Сервер с настоящей базой и настоящим словарём.
 *
 * Словарь подставляется стабом, а не читается из общей таблицы: соседние
 * файлы пишут в неё параллельно, и проверка «чистый текст публикуется»
 * краснела бы от чужих слов.
 */
async function withServer({ user, run, limiter = null, dictionary = null, materialLimiter = null }) {
  const auth = stubAuthStore(user ? { [user.email]: user } : {});
  const app = createApp({
    data: stubData(),
    auth,
    series: pgSeries(pool),
    ratings: pgRatings(pool),
    reviews: pgReviews(pool),
    dictionary: dictionary ?? { load: async () => ({ block: [], allow: [], available: true }) },
    ratingLimiter: limiter,
    reviewIpLimiter: materialLimiter,
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
  const prefix = 'review-http-%';
  const ids = `SELECT id FROM e_series WHERE slug LIKE $1`;
  await pool.query(`DELETE FROM e_material WHERE series_id IN (${ids})`, [prefix]);
  await pool.query(`DELETE FROM e_rating WHERE series_id IN (${ids})`, [prefix]);
  await pool.query(`DELETE FROM e_watch_mark WHERE episode_id IN (
    SELECT e.id FROM e_episode e JOIN e_season s ON s.id = e.season_id WHERE s.series_id IN (${ids}))`, [prefix]);
  await pool.query(`DELETE FROM e_season WHERE series_id IN (${ids})`, [prefix]);
  await pool.query(`DELETE FROM e_series WHERE slug LIKE $1`, [prefix]);
  await pool.end();
});

test('отправка сохраняет оценку и отзыв и возвращает к блоку', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(1);
  await mark(user.id, series.id);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const res = await post(`/ru/series/${series.slug}/reviews`, {
        value: '8', body: BODY, spoiler: 'on', lang: 'ru', csrf: csrfOf(page),
      });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), `/ru/series/${series.slug}#h-reviews`);

      const own = await pgReviews(pool).ownReview(user.id, series.id);
      assert.equal(own.state, 'published');
      assert.equal(own.spoiler, true);
      assert.equal((await pgRatings(pool).ownRating(user.id, series.id)).value, 8);
    },
  });
});

test('пустой текст сохраняет только оценку', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(2);
  await mark(user.id, series.id);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const res = await post(`/ru/series/${series.slug}/reviews`, {
        value: '7', body: '   ', csrf: csrfOf(page),
      });
      assert.equal(res.status, 303);
      assert.equal(await pgReviews(pool).ownReview(user.id, series.id), null, 'отзыв не создан');
      assert.equal((await pgRatings(pool).ownRating(user.id, series.id)).value, 7);
    },
  });
});

test('короткий текст — ошибка с сохранённым вводом и оценкой', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(3);
  await mark(user.id, series.id);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const res = await post(`/ru/series/${series.slug}/reviews`, {
        value: '9', body: 'коротко', csrf: csrfOf(page),
      });
      assert.equal(res.status, 422);
      const html = await res.text();
      assert.match(html, /коротко/, 'введённый текст остался в форме');
      assert.match(html, /value="9"[^>]*checked|checked[^>]*value="9"/, 'оценка в форме осталась');
      assert.equal((await pgRatings(pool).ownRating(user.id, series.id)).value, 9, 'оценка сохранена');
      assert.equal(await pgReviews(pool).ownReview(user.id, series.id), null);
    },
  });
});

test('слово из словаря: пометка, фрагмент подсвечен, слово не показано', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(4);
  await mark(user.id, series.id);
  const dictionary = {
    load: async () => ({ block: [{ word: 'запрещено', category: 'profanity' }], allow: [], available: true }),
  };

  await withServer({
    user,
    dictionary,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const text = 'Здесь запрещено писать такое, но текст длинный';
      const res = await post(`/ru/series/${series.slug}/reviews`, {
        value: '8', body: text, csrf: csrfOf(page),
      });
      assert.equal(res.status, 303, 'пометка не ошибка формы: материал сохранён');

      const html = await (await get(`/ru/series/${series.slug}`)).text();
      assert.match(html, /<mark[^>]*>запрещено<\/mark>/, 'фрагмент подсвечен');
      assert.match(html, /недопустимая лексика/i, 'категория названа');
      assert.ok(!/ugc\.flagged/.test(html), 'ключ не просочился в разметку');
    },
  });
});

test('словарь недоступен — отзыв ждёт проверки и не публикуется', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(5);
  await mark(user.id, series.id);

  await withServer({
    user,
    dictionary: { load: async () => ({ block: [], allow: [], available: false }) },
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const res = await post(`/ru/series/${series.slug}/reviews`, {
        value: '8', body: BODY, csrf: csrfOf(page),
      });
      assert.equal(res.status, 303);
      assert.equal((await pgReviews(pool).ownReview(user.id, series.id)).state, 'checking');
      const html = await (await get(`/ru/series/${series.slug}`)).text();
      assert.match(html, /проверк/i, 'человек видит, что текст ждёт проверки');
    },
  });
});

test('правка раньше пяти минут отклоняется с объяснением', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(6);
  await mark(user.id, series.id);
  const dictionary = {
    load: async () => ({ block: [{ word: 'запрещено', category: 'profanity' }], allow: [], available: true }),
  };

  await withServer({
    user,
    dictionary,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(page);
      await post(`/ru/series/${series.slug}/reviews`, {
        value: '8', body: 'Тут запрещено, но текст достаточно длинный', csrf,
      });
      const res = await post(`/ru/series/${series.slug}/reviews`, {
        value: '8', body: 'Исправленный текст, теперь без плохих слов', csrf,
      });
      assert.equal(res.status, 422);
      const html = await res.text();
      assert.match(html, /мин/i, 'сказано, сколько ждать');
      const own = await pgReviews(pool).ownReview(user.id, series.id);
      assert.match(own.body, /запрещено/, 'текст не заменён');
    },
  });
});

test('удаление отзыва оставляет оценку', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(7);
  await mark(user.id, series.id);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(page);
      await post(`/ru/series/${series.slug}/reviews`, { value: '6', body: BODY, csrf });
      const res = await post(`/ru/series/${series.slug}/reviews/delete`, { csrf });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), `/ru/series/${series.slug}#h-reviews`);
      assert.equal(await pgReviews(pool).ownReview(user.id, series.id), null);
      assert.equal((await pgRatings(pool).ownRating(user.id, series.id)).value, 6);
    },
  });
});

test('снятие оценки удаляет отзыв (H-75)', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(8);
  await mark(user.id, series.id);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(page);
      await post(`/ru/series/${series.slug}/reviews`, { value: '6', body: BODY, csrf });
      const res = await post(`/ru/series/${series.slug}/rating`, { value: '0', csrf });
      assert.equal(res.status, 303);
      assert.equal(await pgReviews(pool).ownReview(user.id, series.id), null, 'отзыв удалён вместе с оценкой');
      assert.equal(await pgRatings(pool).ownRating(user.id, series.id), null);
    },
  });
});

test('гость отправляется во вход, ничего не пишется (R-SEC-08)', { skip }, async () => {
  const series = await seriesWith(9);

  await withServer({
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const res = await post(`/ru/series/${series.slug}/reviews`, {
        value: '8', body: BODY, csrf: csrfOf(page),
      });
      assert.equal(res.status, 303);
      assert.match(res.headers.get('location'), /^\/ru\/login\?next=/);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM e_material WHERE series_id = $1', [series.id])).rows[0].n, 0);
    },
  });
});

test('без токена отзыв не принимается (R-SEC-23)', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(10);
  await mark(user.id, series.id);

  await withServer({
    user,
    run: async ({ post }) => {
      const res = await post(`/ru/series/${series.slug}/reviews`, { value: '8', body: BODY });
      assert.equal(res.status, 403);
      assert.equal(await pgReviews(pool).ownReview(user.id, series.id), null);
    },
  });
});

test('потолок по IP отвечает 429 и говорит, когда повторить (R-MOD-10)', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(11);
  await mark(user.id, series.id);

  await withServer({
    user,
    materialLimiter: createRateLimiter({ limit: 1, windowMs: HOUR }),
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(page);
      const first = await post(`/ru/series/${series.slug}/reviews`, { value: '8', body: BODY, csrf });
      assert.equal(first.status, 303);
      const second = await post(`/ru/series/${series.slug}/reviews`, { value: '8', body: BODY, csrf });
      assert.equal(second.status, 429);
      assert.ok(Number(second.headers.get('retry-after')) > 0);
    },
  });
});

test('отзыв виден в блоке «Ваш отзыв» и после перезагрузки', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(12);
  await mark(user.id, series.id);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      assert.match(page, /Ваш отзыв/);
      await post(`/ru/series/${series.slug}/reviews`, { value: '8', body: BODY, csrf: csrfOf(page) });

      const html = await (await get(`/ru/series/${series.slug}`)).text();
      assert.match(html, /Опубликован/);
      assert.match(html, new RegExp(BODY.slice(0, 30)));
      assert.match(html, /Изменить/);
      assert.match(html, /Удалить отзыв/);
    },
  });
});

test('английская страница показывает блок по-английски', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(13);
  await mark(user.id, series.id);

  await withServer({
    user,
    run: async ({ get }) => {
      const html = await (await get(`/en/series/${series.slug}`)).text();
      assert.match(html, /Your review/);
      assert.ok(!/Ваш отзыв/.test(html));
    },
  });
});

test('мьют: отправка отклоняется, причина и срок показаны', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(14);
  await mark(user.id, series.id);
  await pool.query(
    `INSERT INTO e_restriction (user_id, kind, reason, set_by, expires_at)
     VALUES ($1, 'mute', 'несколько сообщений подряд', $1, now() + interval '2 days')`,
    [user.id],
  );

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      assert.match(page, /Отправка недоступна/, 'причина видна ещё до отправки');
      const res = await post(`/ru/series/${series.slug}/reviews`, {
        value: '8', body: BODY, csrf: csrfOf(page),
      });
      assert.equal(res.status, 303);
      assert.equal(await pgReviews(pool).ownReview(user.id, series.id), null, 'во время мьюта не пишется');
      assert.equal(await pgRatings(pool).ownRating(user.id, series.id), null, 'оценка тоже не сохраняется');
      const html = await (await get(`/ru/series/${series.slug}`)).text();
      assert.match(html, /несколько сообщений подряд/, 'сказана причина');
    },
  });
});

test('текст без оценки не публикуется: оценка — часть отзыва', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(15);
  await mark(user.id, series.id);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}`)).text();
      const res = await post(`/ru/series/${series.slug}/reviews`, {
        body: BODY, csrf: csrfOf(page),
      });
      assert.equal(res.status, 422);
      const html = await res.text();
      assert.match(html, /Поставьте оценку/, 'сказано, чего не хватает');
      assert.match(html, new RegExp(BODY.slice(0, 30)), 'текст не потерян');
      assert.equal(await pgReviews(pool).ownReview(user.id, series.id), null);
    },
  });
});
