// Прогресс в интерфейсе (F-03-03): путь «отметил → увидел прогресс →
// продолжил». Проверяется вместе с живой базой: даты выходов, отметки и кэш
// должны сойтись, иначе человек увидит «12 из 24» там, где отмечено три.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore, pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { createRateLimiter } from '../src/services/limits.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { pgSeasons } from '../src/services/catalogue/season.js';
import { pgCatalogueList } from '../src/services/catalogue/list.js';
import { pgCollections } from '../src/services/catalogue/collection.js';
import { pgPerson } from '../src/services/catalogue/person.js';
import { pgCalendar } from '../src/services/catalogue/calendar.js';
import { pgWatchStatus } from '../src/services/tracking/status.js';
import { pgLibrary } from '../src/services/tracking/library.js';
import { pgMarks } from '../src/services/tracking/marks.js';
import { pgProgress } from '../src/services/tracking/progress.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — прогресс в интерфейсе не проверялся';

let pool;
let account;
let series;
let season;
let episodes;

function shift(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  const { token, hash } = makeToken();
  const id = `pr-${crypto.randomUUID()}`;
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

  const { rows: [seriesRow] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Прогресс: интерфейс', 'Progress in UI', $2, 'published', 'airing', 2020) RETURNING id, slug`,
    [id, 995000000 + (Number(id.replace(/\D/g, '').slice(0, 4)) || 1)],
  );
  series = seriesRow;

  const { rows: [seasonRow] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id, number',
    [series.id],
  );
  season = seasonRow;

  episodes = [];
  for (const number of [1, 2, 3, 4, 5]) {
    const { rows: [episode] } = await pool.query(
      'INSERT INTO e_episode (season_id, number, title_ru, runtime_min) VALUES ($1, $2, $3, 45) RETURNING id, number',
      [season.id, number, `Серия ${number}`],
    );
    episodes.push(episode);
  }

  // Четыре серии вышли, пятая — через три дня.
  for (let index = 0; index < 4; index += 1) {
    const { rows: [release] } = await pool.query(
      `INSERT INTO e_release (season_id, covers_season, release_date, precision, state)
       VALUES ($1, false, $2::date, 'date', 'aired') RETURNING id`,
      [season.id, shift(-(4 - index))],
    );
    await pool.query('INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)', [release.id, episodes[index].id]);
  }
  const { rows: [next] } = await pool.query(
    `INSERT INTO e_release (season_id, covers_season, release_date, precision, state)
     VALUES ($1, false, $2::date, 'date', 'scheduled') RETURNING id`,
    [season.id, shift(3)],
  );
  await pool.query('INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)', [next.id, episodes[4].id]);

  await pool.query(
    "INSERT INTO e_watch_status (user_id, series_id, status) VALUES ($1, $2, 'watching')",
    [created.id, series.id],
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
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_watch_mark WHERE user_id = $1', [account.id]);
  await pool.query('DELETE FROM e_mark_batch WHERE user_id = $1', [account.id]);
  await pool.query('DELETE FROM e_progress WHERE user_id = $1', [account.id]);
  await pool.query('DELETE FROM e_watch_status WHERE user_id = $1', [account.id]);
  await pool.query('DELETE FROM e_subscription WHERE user_id = $1', [account.id]);
  await pool.query('DELETE FROM e_release WHERE season_id = $1', [season.id]);
  await pool.query('DELETE FROM e_episode WHERE season_id = $1', [season.id]);
  await pool.query('DELETE FROM e_season WHERE id = $1', [season.id]);
  await pool.query('DELETE FROM e_series WHERE id = $1', [series.id]);
  await pool.query('DELETE FROM e_user WHERE id = $1', [account.id]);
  await pool.end();
});

async function withServer({ run }) {
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
    marks: pgMarks(pool),
    progress: pgProgress(pool),
    markLimiter: createRateLimiter({ limit: 120, windowMs: 60_000 }),
    pool,
    auth: stubAuthStore({ [account.email]: account }),
    // createApp объявляет middleware сессий функцией, а модуль отдаёт обработчик
    // или их пару — Express принимает и то и другое.
    sessionMw: /** @type {Function} */ (createSessionMiddleware(
      { query: async () => ({ rows: [] }), on: () => {} },
      createMemorySessionStore(),
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
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

  const page = await (await get('/ru/login')).text();
  await post('/ru/login', { email: account.email, password: PASSWORD, csrf: csrfOf(page) });

  try {
    await run({ get, post, csrfOf });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('гость не видит ни прогресса, ни «продолжить»', { skip }, async () => {
  const app = createApp({
    data: stubData(),
    series: pgSeries(pool),
    watchStatus: pgWatchStatus(pool),
    progress: pgProgress(pool),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/ru/series/${series.slug}`)).text();
    assert.ok(!body.includes('class="progress"'), 'гостю незачем видеть чужой прогресс и «продолжить»');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('после отметки карточка показывает прогресс и «продолжить» (OP-10)', { skip }, async () => {
  await withServer({
    run: async ({ get, post, csrfOf }) => {
      const card = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(card);

      const seasonPage = await (await get(`/ru/series/${series.slug}/seasons/${season.number}`)).text();
      const ids = [...seasonPage.matchAll(/name="episodeId" value="(\d+)"/g)].map((m) => Number(m[1]));
      await post(`/ru/series/${series.slug}/mark`, {
        action: 'episode', season: 1, episode: 1, episodeId: ids[0], on: '1', csrf,
      });

      const after = await (await get(`/ru/series/${series.slug}`)).text();
      assert.match(after, /class="progress__numbers">1 \/ 4/, 'одна из четырёх вышедших отмечена');
      assert.match(after, /Продолжить: S1E2/, 'продолжить — со второй серии');

      const marked = await (await get(`/ru/series/${series.slug}/seasons/${season.number}`)).text();
      await post(`/ru/series/${series.slug}/mark`, {
        action: 'episode', season: 1, episode: 3, episodeId: ids[2], on: '1', csrf,
      });

      const withGap = await (await get(`/ru/series/${series.slug}`)).text();
      assert.match(withGap, /class="progress__numbers">2 \/ 4/);
      assert.match(withGap, /Продолжить: S1E4/,
        'после третьей отмеченной следующая — четвёртая, а не вторая');
      assert.match(withGap, /Пропущено серий: 1/, 'вторая помечена пропущенной');
      void marked;
    },
  });
});

test('всё вышедшее отмечено — «ждём серию», а не «продолжить» (EC-T10)', { skip }, async () => {
  await withServer({
    run: async ({ get, post, csrfOf }) => {
      const card = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(card);

      const seasonPage = await (await get(`/ru/series/${series.slug}/seasons/${season.number}`)).text();
      const ids = [...seasonPage.matchAll(/name="episodeId" value="(\d+)"/g)].map((m) => Number(m[1]));

      for (const number of [1, 2, 3, 4]) {
        await post(`/ru/series/${series.slug}/mark`, {
          action: 'episode', season: 1, episode: number, episodeId: ids[number - 1], on: '1', csrf,
        });
      }

      const after = await (await get(`/ru/series/${series.slug}`)).text();
      assert.match(after, /class="progress__numbers">4 \/ 4/);
      assert.ok(!after.includes('Продолжить:'), 'продолжать нечего');
      assert.match(after, /Всё вышедшее просмотрено/, 'и сказано, когда ждать');
    },
  });
});

test('в закладках тот же прогресс и кнопка «Продолжить» (F-03-03 §3)', { skip }, async () => {
  await withServer({
    run: async ({ get }) => {
      const body = await (await get('/ru/library')).text();

      assert.match(body, /class="library__progress-text">4 из 4/, 'прогресс виден в карточке закладки');
      assert.match(body, /Всё вышедшее просмотрено/, 'состояние «всё отмечено» тоже');
    },
  });
});

test('бейдж «новые серии» у «Просмотрено», когда есть неотмеченная вышедшая (EC-T10)', { skip }, async () => {
  // Бейдж появляется, когда после последней отмеченной вышла серия и человек её
  // ещё не отметил: пока все четыре отмечены, предлагать нечего.
  //
  // Отметка снимается через интерфейс, а не прямо в базе: кэш прогресса
  // пересчитывается вместе с отметкой, и правка в обход службы оставила бы
  // карточке старые числа.
  await withServer({
    run: async ({ get, post, csrfOf }) => {
      const card = await (await get(`/ru/series/${series.slug}`)).text();
      const csrf = csrfOf(card);
      const seasonPage = await (await get(`/ru/series/${series.slug}/seasons/${season.number}`)).text();
      const ids = [...seasonPage.matchAll(/name="episodeId" value="(\d+)"/g)].map((m) => Number(m[1]));

      await post(`/ru/series/${series.slug}/mark`, {
        action: 'episode', season: 1, episode: 4, episodeId: ids[3], on: '0', csrf,
      });
      await pool.query(
        "UPDATE e_watch_status SET status = 'watched' WHERE user_id = $1 AND series_id = $2",
        [account.id, series.id],
      );

      try {
        const body = await (await get('/ru/library')).text();
        assert.match(body, /library__badge[^>]*>Новые серии/,
          'у «Просмотрено» с неотмеченной вышедшей серией есть что предложить');
        assert.match(body, /3 из 4/, 'и прогресс показывает правду: 3 из 4');
      } finally {
        await pool.query(
          "UPDATE e_watch_status SET status = 'watching' WHERE user_id = $1 AND series_id = $2",
          [account.id, series.id],
        );
      }
    },
  });
});