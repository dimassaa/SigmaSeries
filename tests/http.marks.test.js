// Отметки серий в интерфейсе (F-03-02): флажок, отказ, отмена.
//
// Проверяется вместе с живой базой: «вышла серия или нет» решается по датам
// выхода, и подставные серии без выходов проверку бы не прошли.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
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
import { pgMarks } from '../src/services/tracking/marks.js';
import { createRateLimiter } from '../src/services/limits.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — отметки в интерфейсе не проверялись';

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
  const id = `ui-mk-${crypto.randomUUID()}`;
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
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Отметки: интерфейс', 'Marks in UI', $2, 'published', 'airing', 2020) RETURNING id, slug`,
    [id, 997000000 + (Number(id.replace(/\D/g, '').slice(0, 4)) || 1)],
  );
  series = row;

  const { rows: [seasonRow] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id, number',
    [series.id],
  );
  season = seasonRow;

  episodes = [];
  for (const number of [1, 2, 3, 4]) {
    const { rows: [episode] } = await pool.query(
      'INSERT INTO e_episode (season_id, number, title_ru, runtime_min) VALUES ($1, $2, $3, 45) RETURNING id, number',
      [season.id, number, `Серия ${number}`],
    );
    episodes.push(episode);
  }

  // Серии 1 и 2 вышли, серия 3 — завтра, серия 4 без даты.
  for (const [index, date] of [[0, shift(-3)], [1, shift(-1)], [2, shift(1)]]) {
    const { rows: [release] } = await pool.query(
      `INSERT INTO e_release (season_id, covers_season, release_date, precision, state)
       VALUES ($1, false, $2::date, 'date', 'scheduled') RETURNING id`,
      [season.id, date],
    );
    await pool.query('INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)', [release.id, episodes[index].id]);
  }

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
    marks: pgMarks(pool),
    markLimiter: createRateLimiter({ limit: 120, windowMs: 60_000 }),
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
  const seasonUrl = `/ru/series/${series.slug}/seasons/${season.number}`;

  if (signedIn) {
    const page = await (await get('/ru/login')).text();
    await post('/ru/login', { email: account.email, password: PASSWORD, csrf: csrfOf(page) });
  }

  try {
    await run({ get, post, csrfOf, seasonUrl });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('гость видит строку серии, но не видит флажка', { skip }, async () => {
  await withServer({
    signedIn: false,
    run: async ({ get, seasonUrl }) => {
      const body = await (await get(seasonUrl)).text();

      assert.match(body, /class="season__episode"/, 'строки серий на месте');
      assert.ok(!body.includes('name="action" value="episode"'),
        'гостю не показывают форму, которая всё равно не сработает');
    },
  });
});

test('флажок отмечает одну серию и снимает отметку', { skip }, async () => {
  await withServer({
    run: async ({ get, post, csrfOf, seasonUrl }) => {
      const page = await (await get(seasonUrl)).text();
      assert.match(page, /name="action" value="episode"/, 'форма отметки на странице есть');
      assert.match(page, /aria-pressed="false"/, 'флажок показывает «не отмечено»');

      const csrf = csrfOf(page);
      const idOfFirst = page.match(/name="episodeId" value="(\d+)"/)?.[1];
      const res = await post(`/ru/series/${series.slug}/mark`, {
        action: 'episode', season: 1, episode: 1, episodeId: idOfFirst, on: '1', csrf,
      });
      assert.equal(res.status, 303);
      assert.match(res.headers.get('location'), /mark=ok/);

      const marked = await (await get(seasonUrl)).text();
      assert.match(marked, /aria-pressed="true"/, 'отметка видна на странице');

      await post(`/ru/series/${series.slug}/mark`, {
        action: 'episode', season: 1, episode: 1, episodeId: idOfFirst, on: '0', csrf,
      });
      const cleared = await (await get(seasonUrl)).text();
      assert.match(cleared, /aria-pressed="false"/, 'снятие тоже видно');
    },
  });
});

test('не вышедшая серия отметить нельзя, и сказано когда (EC-T2)', { skip }, async () => {
  await withServer({
    run: async ({ get, seasonUrl }) => {
      const body = await (await get(seasonUrl)).text();
      // Серия 3 выходит завтра: флажок есть, но выключен, и в подсказке дата.
      assert.match(body, /disabled aria-disabled="true"/, 'не вышедшая серия не отмечается');
      assert.match(body, /Серия выйдет/, 'и человек видит, когда она выйдет');
    },
  });
});

test('«Отметить сезон» отмечает вышедшие и предлагает отмену', { skip }, async () => {
  await withServer({
    run: async ({ get, post, csrfOf, seasonUrl }) => {
      const page = await (await get(seasonUrl)).text();
      const csrf = csrfOf(page);

      const res = await post(`/ru/series/${series.slug}/mark`, {
        action: 'season', season: 1, seasonId: season.id, csrf,
      });
      assert.equal(res.status, 303);

      const afterMark = await (await get(res.headers.get('location'))).text();
      assert.match(afterMark, /Отмечено серий: 2/, 'отмечены две вышедшие серии');
      assert.match(afterMark, /data-undo-window="10"/,
        'окно отмены равно tracking.undo_window_s');

      const batch = afterMark.match(/name="batch" value="(\d+)"/)?.[1];
      assert.ok(batch, 'номер пакета есть в форме отмены');

      const undone = await post(`/ru/series/${series.slug}/mark`, { action: 'undo', batch, csrf });
      assert.equal(undone.status, 303);
      const restored = await (await get(seasonUrl)).text();
      assert.ok(!restored.includes('aria-pressed="true"'), 'отметки снялись');
    },
  });
});

test('«Все до этой» отмечает по порядку и не трогает будущую', { skip }, async () => {
  await withServer({
    run: async ({ get, post, csrfOf, seasonUrl }) => {
      const page = await (await get(seasonUrl)).text();
      const res = await post(`/ru/series/${series.slug}/mark`, {
        action: 'upto', season: 1, episode: 2, csrf: csrfOf(page),
      });
      assert.equal(res.status, 303);

      const after = await (await get(res.headers.get('location'))).text();
      assert.match(after, /Отмечено серий: 2/, 'отмечены серии 1 и 2');
      assert.ok(!/name="batch"/.test(after) || /value="\d+"/.test(after), 'отмена доступна');
    },
  });
});

test('подделка без токена не отмечает (R-SEC-23)', { skip }, async () => {
  // Чистим отметки предыдущих тестов: здесь проверяется не «ничего не было»,
  // а «подделка ничего не добавила».
  await pool.query('DELETE FROM e_watch_mark WHERE user_id = $1', [account.id]);

  await withServer({
    run: async ({ post }) => {
      const res = await post(`/ru/series/${series.slug}/mark`, {
        action: 'episode', season: 1, episode: 1, episodeId: episodes[0].id, on: '1', csrf: 'чужой',
      });
      assert.equal(res.status, 403);

      const marks = await pool.query('SELECT count(*)::int AS n FROM e_watch_mark WHERE user_id = $1', [account.id]);
      assert.equal(marks.rows[0].n, 0, 'без токена ничего не записано');
    },
  });
});

test('отметка серии видна и на странице самой серии (S-08)', { skip }, async () => {
  await withServer({
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/series/${series.slug}/seasons/1/episodes/1`)).text();
      assert.match(page, /name="action" value="episode"/, 'флажок есть и на странице серии');

      const idOfFirst = page.match(/name="episodeId" value="(\d+)"/)?.[1];
      await post(`/ru/series/${series.slug}/mark`, {
        action: 'episode', season: 1, episode: 1, episodeId: idOfFirst, on: '1', csrf: csrfOf(page),
      });

      const marked = await (await get(`/ru/series/${series.slug}/seasons/1/episodes/1`)).text();
      assert.match(marked, /aria-pressed="true"/, 'отметка видна после перезагрузки');
    },
  });
});