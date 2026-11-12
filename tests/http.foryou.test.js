// S-34 — страница «Для вас» (/for-you).
//
// Здесь проверяются частые провалы персональной строки: причина обязана быть
// названа, конкретно (M11 §0); список между двумя заходами не мелькает (§8е);
// отметка обновляет строку сразу — кэш не живёт десять минут со старым
// списком (EC-M2); страница в индексе не нужна (R-SEO-06). Отметки делаются
// через настоящий HTTP-маршрут: это проверяет и сцепку отметки с кэшем.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { pgData } from '../src/services/home/data.js';
import { pgRecommendations } from '../src/services/recommendations/reco.js';
import { pgMarks } from '../src/services/tracking/marks.js';
import { stubAuthStore, pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { pgCatalogueList } from '../src/services/catalogue/list.js';
import { pgSeasons } from '../src/services/catalogue/season.js';
import { pgCollections } from '../src/services/catalogue/collection.js';
import { pgPerson } from '../src/services/catalogue/person.js';
import { pgCalendar } from '../src/services/catalogue/calendar.js';
import { pgWatchStatus } from '../src/services/tracking/status.js';
import { pgLibrary } from '../src/services/tracking/library.js';
import { RECO } from '../src/config/settings.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — «для вас» не проверялись';

let pool;
/** @type {Record<string, any>} */
let users = {};
/** @type {{code: string, name_ru: string, name_en: string}} */
let genre = /** @type {any} */ (null);
/** @type {any[]} */
let candidates = [];
/** @type {any[]} */
let watched = [];
/** @type {Record<string, number>} */
let episodeIds = {};

/**
 * Адреса карточек в порядке показа: `data-poster-card` ставится ровно один
 * раз на карточку, так что совокупность значений — это и есть строка.
 *
 * @param {string} body
 * @returns {string[]}
 */
const slugsOf = (body) => [...body.matchAll(/data-poster-card="([^"]+)"/g)].map((m) => m[1]);

test.before(async () => {
  if (!available) return;
  pool = createPool();

  const store = pgAuthStore(pool);
  const make = async (prefix, over = {}) => {
    const { hash } = makeToken();
    void hash;
    const nickname = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
    const user = await store.createUser({
      email: `${nickname}@example.com`,
      nickname,
      passwordHash: await hashPassword(PASSWORD),
      tokenHash: hash,
      timezone: 'Europe/Minsk',
      locale: 'ru',
      theme: 'dark',
    });
    const row = {
      id: user.id,
      email: `${nickname}@example.com`,
      password_hash: await hashPassword(PASSWORD),
      nickname,
      status: 'active',
      email_confirmed: true,
      locale: 'ru',
      theme: 'dark',
      timezone: 'Europe/Minsk',
      recs_enabled: true,
      profile_public: false,
      stats_public: false,
      ...over,
    };
    if (Object.keys(over).length) {
      const keys = Object.keys(over);
      await pool.query(
        `UPDATE e_user SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`,
        [...keys.map((k) => row[k]), row.id],
      );
    }
    return row;
  };

  // Отдельный зритель на каждое поведение: мутации в одном тесте не
  // перекраивают список другому (§8е сравнивает два захода подряд).
  users.main = await make('foryou-main');
  users.marks = await make('foryou-marks');
  users.dismiss = await make('foryou-dismiss');
  users.off = await make('foryou-off', { recs_enabled: false });
  users.few = await make('foryou-few');

  // Свой жанр без сериалов в справочнике: кандидаты рекомендаций — только
  // фикстуры, кем что угодно ещё в базе — сид, другие тесты — не мешает.
  // Жанр настоящий (NOT is_raw): подбор вкуса совпадает только по настоящим
  // жанрам (№260). От меню его прячет `show_in_menu = FALSE`, а не `is_raw`,
  // как раньше: роль `is_raw` — внутренние коды импорта, а не укрытие.
  const tags = `test-foryou-${crypto.randomUUID().slice(0, 8)}`;
  const { rows: [genreRow] } = await pool.query(
    `INSERT INTO e_genre (code, name_ru, name_en, active, is_raw, show_in_menu)
     VALUES ($1, $2, $3, TRUE, FALSE, FALSE) RETURNING code, name_ru, name_en`,
    [tags, `Почерк ${tags}`, `Fixture ${tags}`],
  );
  genre = genreRow;

  const makeSeries = async (slug, title) => {
    const { rows: [row] } = await pool.query(
      `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
       VALUES ($1, $2, $3, $4, 'published', 'airing', 2021) RETURNING id, slug`,
      [slug, title, `Fixture ${title}`, 995000000 + Math.floor(Math.random() * 900000)],
    );
    await pool.query(
      'INSERT INTO e_series_genre (series_id, genre_code) VALUES ($1, $2)',
      [row.id, genre.code],
    );
    return row;
  };

  // Сезон с тремя вышедшими сериями: отметка «серия вышла» проходит проверку
  // not-aired (F-03-02 §4), поэтому у кандидата тоже есть сезон с выходами.
  const addSeason = async (seriesRow) => {
    const { rows: [season] } = await pool.query(
      'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [seriesRow.id],
    );
    let first = 0;
    const ids = [];
    for (const n of [1, 2, 3]) {
      const { rows: [episode] } = await pool.query(
        'INSERT INTO e_episode (season_id, number, title_ru) VALUES ($1, $2, $3) RETURNING id',
        [season.id, n, `Серия ${n}`],
      );
      ids.push(episode.id);
      if (!first) first = episode.id;
    }
    // Весь сезон вышел одной датой: на дату сезона — одна строка выхода,
    // состав задаётся связями (EC-D11), иначе `uq_release_season_date` бранится.
    const { rows: [release] } = await pool.query(
      `INSERT INTO e_release (season_id, release_date, precision, state, covers_season)
       VALUES ($1, CURRENT_DATE - 30, 'date', 'aired', TRUE) RETURNING id`, [season.id],
    );
    for (const id of ids) {
      await pool.query(
        'INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)', [release.id, id],
      );
    }
    episodeIds[seriesRow.slug] = first;
  };

  const rand = crypto.randomUUID().slice(0, 8);
  for (let i = 0; i < 4; i += 1) {
    // Отметки на четырёх сериалах жанра: точная история >= minHistoryMarks.
    const row = await makeSeries(`foryou-w${i}-${rand}`, `История ${i}`);
    await addSeason(row);
    watched.push(row);
  }
  for (let i = 1; i <= 7; i += 1) {
    // Семь кандидатов: показано homeCount, седьмой — на смену отметленному.
    const row = await makeSeries(`foryou-c0${i}-${rand}`, `Рекомендация ${i}`);
    await addSeason(row);
    candidates.push(row);
  }

  // Точным отметкам полагается precision 'exact' — ретро в рекомендации не ходят.
  const markAll = (userId) => pool.query(
    `INSERT INTO e_watch_mark (user_id, episode_id, precision)
     SELECT $1, e.id, 'exact' FROM e_episode e
      JOIN e_season sn ON sn.id = e.season_id
      JOIN e_series s ON s.id = sn.series_id
     WHERE s.slug LIKE 'foryou-w%'
     ON CONFLICT DO NOTHING`, [userId],
  );
  for (const name of ['main', 'marks', 'dismiss', 'off']) await markAll(users[name].id);
  // Мало истории (EC-M1): две точные отметки — причина была бы преувеличением.
  await pool.query(
    `INSERT INTO e_watch_mark (user_id, episode_id, precision)
     VALUES ($1, $2, 'exact'), ($1, $3, 'exact')`,
    [users.few.id, episodeIds[watched[0].slug], episodeIds[watched[1].slug]],
  );
});

test.after(async () => {
  if (!pool) return;
  const ids = Object.values(users).map((u) => u.id);
  if (ids.length) {
    await pool.query('DELETE FROM e_watch_mark WHERE user_id = ANY($1::bigint[])', [ids]);
    await pool.query('DELETE FROM e_reco_dismiss WHERE user_id = ANY($1::bigint[])', [ids]);
  }
  // Сезон удаляется раньше сериала: `e_season.series_id` — RESTRICT.
  await pool.query(
    `DELETE FROM e_season WHERE series_id IN
       (SELECT id FROM e_series WHERE slug LIKE 'foryou-%')`,
  );
  await pool.query('DELETE FROM e_series WHERE slug LIKE $1', ['foryou-%']);
  const { rows: [genreRow] } = await pool.query(
    'DELETE FROM e_genre WHERE code = $1 RETURNING code', [genre?.code ?? ''],
  );
  void genreRow;
  if (ids.length) await pool.query('DELETE FROM e_user WHERE id = ANY($1::bigint[])', [ids]);
  await pool.end();
});

/**
 * Запускает приложение на живом порту: источник данных настоящий
 * (`pgData` с движком рекомендаций), авторизация — по фикстурным строкам,
 * как во всех HTTP-тестах проекта.
 *
 * @param {{user?: any, run: (h: any) => Promise<void>}} args
 */
async function withServer({ user = null, run }) {
  const recommendations = pgRecommendations(pool);
  const app = createApp({
    data: pgData(pool, { recommendations }),
    recommendations,
    marks: pgMarks(pool),
    series: pgSeries(pool),
    catalogue: pgCatalogueList(pool),
    seasons: pgSeasons(pool),
    collections: pgCollections(pool),
    person: pgPerson(pool),
    calendar: pgCalendar(pool),
    watchStatus: pgWatchStatus(pool),
    library: pgLibrary(pool),
    pool,
    auth: stubAuthStore(user ? { [user.email]: user } : {}),
    // createApp объявляет middleware сессий функцией, а модуль отдаёт
    // обработчик или их пару — Express принимает и то и другое.
    sessionMw: /** @type {any} */ (createSessionMiddleware(
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

  if (user) {
    const page = await (await get('/ru/login')).text();
    await post('/ru/login', { email: user.email, password: PASSWORD, csrf: csrfOf(page) });
  }

  try {
    await run({ get, post, csrfOf });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('гостю — «Популярное», страница в индексе не нужна', { skip }, async () => {
  await withServer({
    run: async ({ get }) => {
      const res = await get('/ru/for-you');
      const body = await res.text();

      assert.equal(res.status, 200);
      assert.match(body, /Популярное/, 'гостю показывается популярное (F-11-01 §2)');
      assert.ok(!body.includes('poster__reason'), 'причин у гостя нет — объяснять нечего');
      assert.ok(!body.includes('posters__dismiss'), 'и кнопок «Не интересно» тоже нет');
      assert.match(body, /<meta name="robots" content="noindex, follow">/, 'персональная страница вне индекса');
      assert.match(body, /<link rel="canonical" href="\/ru\/for-you">/, 'канонический адрес один');
    },
  });
});

test('зрителю с историей — «Для вас»: шесть позиций с причиной (F-11-01 §8б)', { skip }, async () => {
  await withServer({
    user: users.main,
    run: async ({ get }) => {
      const res = await get('/ru/for-you');
      const body = await res.text();

      assert.equal(res.status, 200);
      assert.match(body, /Для вас/, 'заголовок персональной строки');
      assert.equal(slugsOf(body).length, RECO.homeCount, 'позиций ровно столько, сколько в настройках модуля');
      assert.deepEqual(
        slugsOf(body),
        candidates.slice(0, RECO.homeCount).map((c) => c.slug),
        'порядок в расчёте определён: жанр → рейтинг → адрес (§8е)',
      );
      assert.ok(body.includes(`потому что жанр «${genre.name_ru}»`), 'причина названа конкретно, не «похожие»');
      assert.match(body, /<form class="posters__dismiss" method="post" action="\/ru\/reco\/dismiss">/,
        'у рекомендации есть «Не интересно»');
      assert.match(body, /name="back" value="\/ru\/for-you"/, 'скрытие возвращает на эту же страницу');
      assert.match(body, /name="csrf"/, 'форма несёт CSRF-токен');

      // §8е: два захода подряд — один и тот же список, а не пересчёт
      // на глазах (F-11-01 §8е).
      const again = await (await get('/ru/for-you')).text();
      assert.equal(again, body, 'список между двумя заходами не меняется');
    },
  });
});

test('английская страница переводит формулировку причины (M11 §11)', { skip }, async () => {
  await withServer({
    user: users.main,
    run: async ({ get }) => {
      const res = await get('/en/for-you');
      const body = await res.text();

      assert.equal(res.status, 200);
      assert.match(body, /For you/, 'заголовок на языке интерфейса');
      assert.ok(body.includes(`because you like “${genre.name_en}”`), 'причина тоже переводима');
      assert.match(body, /<link rel="canonical" href="\/en\/for-you">/);
    },
  });
});

test('малая история — «Популярное» без причин и кнопок (EC-M1)', { skip }, async () => {
  await withServer({
    user: users.few,
    run: async ({ get }) => {
      const body = await (await get('/ru/for-you')).text();

      assert.match(body, /Популярное/, 'двух отметок мало — причина была бы преувеличением (EC-M1)');
      assert.ok(!body.includes('poster__reason'));
      assert.ok(!body.includes('posters__dismiss'));
    },
  });
});

test('выключенные рекомендации — «Популярное» (F-11-01 §5)', { skip }, async () => {
  await withServer({
    user: users.off,
    run: async ({ get }) => {
      const body = await (await get('/ru/for-you')).text();

      assert.match(body, /Популярное/, 'выключили — строка не обижается, просто популярное');
      assert.ok(!body.includes('poster__reason'), 'объяснений у популярного нет');
    },
  });
});

test('неизвестная локаль — 404', { skip }, async () => {
  await withServer({
    run: async ({ get }) => {
      assert.equal((await get('/xx/for-you')).status, 404);
    },
  });
});

test('отметка обновляет «для вас» сразу, а не через десять минут (EC-M2)', { skip }, async () => {
  await withServer({
    user: users.marks,
    run: async ({ get, post, csrfOf }) => {
      const before = await (await get('/ru/for-you')).text();
      const target = candidates.find((c) => slugsOf(before).includes(c.slug));
      assert.ok(target, 'кандидат был среди рекомендаций');

      const res = await post(`/ru/series/${target.slug}/mark`, {
        action: 'episode',
        episodeId: String(episodeIds[target.slug]),
        on: '1',
        season: '1',
        csrf: csrfOf(before),
      });
      assert.equal(res.status, 303, 'отметка прошла через настоящий маршрут');
      assert.equal(res.headers.get('location'), `/ru/series/${target.slug}/seasons/1?mark=ok`);

      const after = await (await get('/ru/for-you')).text();
      assert.ok(!slugsOf(after).includes(target.slug),
        'отмеченный сериал исчез из рекомендаций тотчас, без ожидания кэша');
      assert.ok(slugsOf(after).includes(candidates[RECO.homeCount].slug),
        'и на его место пришёл следующий кандидат — список пересчитался');
    },
  });
});

test('«Не интересно» со страницы «для вас» возвращает на неё (F-11-03 §3)', { skip }, async () => {
  await withServer({
    user: users.dismiss,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/for-you')).text();
      const target = candidates.find((c) => slugsOf(page).includes(c.slug));
      assert.ok(target, 'кандидат был среди рекомендаций');

      const res = await post('/ru/reco/dismiss', { series: target.slug, back: '/ru/for-you', csrf: csrfOf(page) });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/ru/for-you', 'кнопка вернула на «для вас», а не на главную');

      const after = await (await get('/ru/for-you')).text();
      assert.ok(!slugsOf(after).includes(target.slug), 'скрытый сериал исчез из рекомендаций');
    },
  });
});
