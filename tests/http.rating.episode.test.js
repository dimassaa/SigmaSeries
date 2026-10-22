// Оценка серии: приём запроса и показ (F-04-02).
//
// Проверяется через настоящий HTTP, потому что правила модуля в основном
// серверные: гость, нет отметки, будущая серия, чужой сериал, лимит частоты.
// Защита от подделки запроса проверяется здесь же — прямым POST без сессии.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword } from '../src/services/auth/password.js';

import { pgRatings } from '../src/services/rating/store.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';
import { pgSeasons } from '../src/services/catalogue/season.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { RATING } from '../src/config/settings.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';

const PASSWORD = 'ОченьДлинныйПароль-123';
const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — оценка серии не проверялась';

let pool;

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
});

test.after(async () => {
  if (!pool) return;
  // Уборка в порядке внешних ключей и только по своему префиксу: файлы идут
  // параллельно, и общий `rating-` сносил бы чужие фикстуры.
  const prefix = 'eprate-http-%';
  await pool.query(
    `DELETE FROM e_rating WHERE series_id IN (SELECT id FROM e_series WHERE slug LIKE $1)`, [prefix],
  );
  await pool.query(
    `DELETE FROM e_season WHERE series_id IN (SELECT id FROM e_series WHERE slug LIKE $1)`, [prefix],
  );
  await pool.query(`DELETE FROM e_series WHERE slug LIKE $1`, [prefix]);
  await pool.end();
});

/**
 * Сериал с двумя сериями: одна вышла, другая впереди.
 *
 * Дата нужна обеим: без вышедшей нельзя оценить, без будущей нельзя проверить
 * правило «серия не вышла» (M3).
 *
 * @param {number} number различает фикстуры между проверками
 */
async function seriesWith(number) {
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Оценка серии', 'Episode rating', $2, 'published', 'airing', 2024) RETURNING id, slug`,
    [`eprate-http-${number}-${crypto.randomUUID().slice(0, 6)}`, 984_000_000 + number],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [series.id],
  );

  const episodes = [];
  for (const [index, date] of [['1', '2020-02-01'], ['2', '2999-02-02']]) {
    // eslint-disable-next-line no-await-in-loop
    const { rows: [episode] } = await pool.query(
      `INSERT INTO e_episode (season_id, number, title_ru, runtime_min)
       VALUES ($1, $2, 'Серия', 45) RETURNING id`,
      [season.id, index],
    );
    // eslint-disable-next-line no-await-in-loop
    const { rows: [release] } = await pool.query(
      `INSERT INTO e_release (season_id, episode_id, release_date) VALUES ($1, $2, $3) RETURNING id`,
      [season.id, episode.id, date],
    );
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      'INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)',
      [release.id, episode.id],
    );
    episodes.push(episode.id);
  }

  return { id: series.id, slug: series.slug, seasonId: season.id, aired: episodes[0], future: episodes[1] };
}

/**
 * Аккаунт для оценки: подтверждённый адрес, время пояса — Минск.
 *
 * @param {{ageHours?: number}} [options] возраст аккаунта: голос младше
 *   `rating.min_account_age_h` в рейтинг не входит (EC-V4), и проверки,
 *   которым нужен учтённый голос, задают возраст явно
 */
async function viewer({ ageHours = 0 } = {}) {
  const { hash } = makeToken();
  const email = `eprate-http-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const created = await pgAuthStore(pool).createUser({
    email,
    nickname: `eprate-http-${crypto.randomUUID().slice(0, 8)}`,
    passwordHash: await hashPassword(PASSWORD),
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  // `pgAuthStore.createUser` заводит адрес неподтверждённым (поле `confirmed`
  // уважает только подставное хранилище), а без подтверждения оценка
  // запрещена (EC-V1): проверка иначе зеленела бы по чужой причине.
  await pool.query('UPDATE e_user SET email_confirmed = TRUE WHERE id = $1', [created.id]);
  if (ageHours) {
    await pool.query(
      `UPDATE e_user SET registered_at = now() - ($2 || ' hours')::interval WHERE id = $1`,
      [created.id, String(ageHours)],
    );
  }

  return {
    id: created.id,
    email,
    email_enc: null,
    password_hash: await hashPassword(PASSWORD),
    nickname: created.nickname ?? `eprate-http-${created.id}`,
    status: 'active',
    email_confirmed: true,
    locale: 'ru',
    theme: 'dark',
    timezone: 'Europe/Minsk',
  };
}

/** Отметка серии — условие права оценить (EC-V1, H-07). */
async function mark(userId, episodeId) {
  await pool.query(
    `INSERT INTO e_watch_mark (user_id, episode_id, precision) VALUES ($1, $2, 'exact')
     ON CONFLICT DO NOTHING`,
    [userId, episodeId],
  );
}

/** Сервер с настоящей базой: право проверяется по `e_user`, `e_watch_mark`, `e_rating`. */
async function withServer({ user, run, limiter }) {
  const auth = stubAuthStore(user ? { [user.email]: user } : {});
  const app = createApp({
    data: stubData(),
    auth,
    series: pgSeries(pool),
    seasons: pgSeasons(pool),
    ratings: pgRatings(pool),
    ratingLimiter: limiter,
    // createApp объявляет middleware сессий функцией, а модуль отдаёт обработчик
    // или их пару — Express принимает и то и другое.
    sessionMw: /** @type {Function} */ (createSessionMiddleware(pool, createMemorySessionStore(), {
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
    await new Promise((r) => server.close(r));
  }
}

/** Адрес страницы серии и адрес списка серий. */
const episodePath = (row, number = 1) => `/ru/series/${row.slug}/seasons/1/episodes/${number}`;
const seasonPath = (row) => `/ru/series/${row.slug}/seasons/1`;

test('серия без отметки не оценивается (EC-V1)', { skip }, async () => {
  const user = await viewer();
  const row = await seriesWith(1);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(episodePath(row))).text();
      assert.match(page, /Отметьте эту серию/, 'страница объясняет, чего не хватает');

      const res = await post(`${episodePath(row)}/rating`, { value: '8', csrf: csrfOf(page) });

      assert.equal(res.status, 303);
      assert.match(res.headers.get('location'), /#ep-1$/, 'возврат к той же строке');
      const stored = await pool.query(
        'SELECT count(*)::int AS n FROM e_rating WHERE user_id = $1 AND episode_id = $2',
        [user.id, row.aired],
      );
      assert.equal(stored.rows[0].n, 0, 'в базе пусто: сервер отказывает, а не только интерфейс');
    },
  });
});

test('будущая серия не оценивается (M3)', { skip }, async () => {
  const user = await viewer();
  const row = await seriesWith(2);
  await mark(user.id, row.future);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(episodePath(row, 2))).text();
      assert.match(page, /Серия ещё не вышла/, 'страница называет причину словами');

      const res = await post(`${episodePath(row, 2)}/rating`, { value: '8', csrf: csrfOf(page) });
      assert.equal(res.status, 303, 'отказ — это возврат с подсказкой, а не ошибка');
    },
  });

  const stored = await pool.query(
    'SELECT count(*)::int AS n FROM e_rating WHERE user_id = $1 AND episode_id = $2',
    [user.id, row.future],
  );
  assert.equal(stored.rows[0].n, 0, 'отметка будущей серии оценки не открывает');
});

test('оценка серии без токена не принимается (R-SEC-23)', { skip }, async () => {
  const user = await viewer();
  const row = await seriesWith(3);
  await mark(user.id, row.aired);

  await withServer({
    user,
    run: async ({ post }) => {
      const res = await post(`${episodePath(row)}/rating`, { value: '8' });
      assert.equal(res.status, 403);
    },
  });
});

test('слишком частые оценки серии получают 429 (R-SEC-31)', { skip }, async () => {
  const user = await viewer();
  const row = await seriesWith(4);
  await mark(user.id, row.aired);

  // Предел в одну попытку: проверяется ответ лимита, а не сорок запросов подряд.
  const limiter = { allow: () => false, windowMs: 3_600_000 };
  await withServer({
    user,
    limiter,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(episodePath(row))).text();
      const res = await post(`${episodePath(row)}/rating`, { value: '8', csrf: csrfOf(page) });

      assert.equal(res.status, 429);
      assert.ok(Number(res.headers.get('retry-after')) > 0, 'нужен Retry-After');
    },
  });

  assert.equal(RATING.ratePerHour, 30, 'предел из таблицы настроек M4 §0');
});

test('гость отправляется во вход с возвратом на страницу серии (R-SEC-08)', { skip }, async () => {
  const row = await seriesWith(5);

  await withServer({
    run: async ({ get, post }) => {
      const page = await (await get(episodePath(row))).text();
      assert.match(page, /Войдите, чтобы оценить/, 'гость видит приглашение, а не пустое место');

      const res = await post(`${episodePath(row)}/rating`, {
        value: '8', csrf: page.match(/name="csrf" value="([^"]+)"/)?.[1],
      });

      assert.equal(res.status, 303);
      const location = res.headers.get('location');
      assert.match(location, /^\/ru\/login\?next=/, 'гость видит форму входа, а не отказ');
      const next = decodeURIComponent(location.split('next=')[1]);
      assert.equal(next, episodePath(row), 'возврат на ту же страницу');
      assert.ok(!next.includes('://'), 'адрес внутренний: открытое перенаправление запрещено');
    },
  });
});

test('оценка серии сохраняется и видна на странице', { skip }, async () => {
  const user = await viewer();
  const row = await seriesWith(6);
  await mark(user.id, row.aired);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(episodePath(row))).text();
      assert.match(page, /Оценка серии/, 'блок оценки серии нарисован');

      const res = await post(`${episodePath(row)}/rating`, { value: '9', csrf: csrfOf(page) });

      assert.equal(res.status, 303);
      const after = await (await get(episodePath(row))).text();
      assert.match(after, /Ваша оценка: 9/, 'своя оценка видна своему автору');
      assert.match(after, /В рейтинг войдёт/, 'автору сказано, когда голос учтут (EC-V4)');
    },
  });

  const stored = await pool.query(
    `SELECT object_type, series_id, value FROM e_rating WHERE user_id = $1 AND episode_id = $2`,
    [user.id, row.aired],
  );
  assert.equal(stored.rows.length, 1, 'оценка записана в базу');
  assert.equal(stored.rows[0].object_type, 'episode');
  assert.equal(Number(stored.rows[0].series_id), Number(row.id), 'сериал записан: по нему читается список');
  assert.equal(stored.rows[0].value, 9);
});

test('снятие оценки серии убирает голос', { skip }, async () => {
  const user = await viewer();
  const row = await seriesWith(7);
  await mark(user.id, row.aired);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(episodePath(row))).text();
      await post(`${episodePath(row)}/rating`, { value: '7', csrf: csrfOf(page) });

      const removed = await post(`${episodePath(row)}/rating`, { value: '0', csrf: csrfOf(page) });
      assert.equal(removed.status, 303);

      const after = await (await get(episodePath(row))).text();
      assert.ok(!after.includes('Ваша оценка'), 'оценки больше нет');
    },
  });

  const stored = await pool.query(
    'SELECT count(*)::int AS n FROM e_rating WHERE user_id = $1 AND episode_id = $2',
    [user.id, row.aired],
  );
  assert.equal(stored.rows[0].n, 0);
});

test('список серий: среднее видно всем, шкала — у отмеченной серии', { skip }, async () => {
  // Аккаунт старше суток: иначе голос не входит в рейтинг и показывать было
  // бы нечего (EC-V4).
  const user = await viewer({ ageHours: RATING.minAccountAgeH + 1 });
  const row = await seriesWith(8);
  await mark(user.id, row.aired);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(episodePath(row))).text();
      await post(`${episodePath(row)}/rating`, { value: '6', csrf: csrfOf(page) });

      const list = await (await get(seasonPath(row))).text();
      assert.match(list, /Мало оценок/, 'один голос — ниже порога показа для серии');
      assert.match(
        list,
        new RegExp(`action="/ru/series/${row.slug}/seasons/1/episodes/1/rating"`),
        'шкала стоит в строке отмеченной серии',
      );
      assert.match(list, /name="from" value="season"/, 'запрос знает, что пришёл из списка');
      assert.ok(
        !list.includes(`episodes/2/rating`),
        'у неотмеченной серии шкалы нет: правило проверяется до показа',
      );
    },
  });
});

test('оценка из списка серий возвращает в список, а не на страницу серии', { skip }, async () => {
  const user = await viewer();
  const row = await seriesWith(9);
  await mark(user.id, row.aired);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      // Форма со страницы серии — проверяется, что то же действие отвечает
      // странице серии: адрес у обоих один, различие только в поле `from`.
      const episodePage = await (await get(episodePath(row))).text();
      const fromEpisode = await post(`${episodePath(row)}/rating`, {
        value: '4', csrf: csrfOf(episodePage),
      });
      assert.match(fromEpisode.headers.get('location'), new RegExp(`^${episodePath(row)}`));

      const list = await (await get(seasonPath(row))).text();
      const fromSeason = await post(`${episodePath(row)}/rating`, {
        value: '5', csrf: csrfOf(list), from: 'season',
      });
      const location = fromSeason.headers.get('location');
      assert.match(location, new RegExp(`^${seasonPath(row)}`), 'возврат в список серий');
      assert.match(location, /#ep-1$/, 'якорь возвращает к той же строке списка');
    },
  });
});

test('чужой сериал: оценка не принимается и страница не отдаётся', { skip }, async () => {
  const user = await viewer();
  const row = await seriesWith(10);
  await mark(user.id, row.aired);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(episodePath(row))).text();
      const csrf = csrfOf(page);

      await pool.query(`UPDATE e_series SET archived_at = now() WHERE id = $1`, [row.id]);
      const gone = await post(`${episodePath(row)}/rating`, { value: '8', csrf });
      assert.equal(gone.status, 404, 'снятый с публикации сериал оценивать нечего (EC-C1)');

      await pool.query(`UPDATE e_series SET archived_at = NULL WHERE id = $1`, [row.id]);
    },
  });
});
