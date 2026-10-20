// Проверки шага 3 регистрации через настоящий HTTP (F-01-01 §4).
//
// Правила живут на сервере, поэтому и проверяются через запрос: сетка на
// странице отключает «Готово», но человек может отправить форму и руками.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore, pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { pgTaste } from '../src/services/recommendations/taste.js';
import { pgSearch } from '../src/services/search/service.js';
import { pgCatalogueList } from '../src/services/catalogue/list.js';
import { createPool } from '../src/db/pool.js';
import { acquireImportLock } from './helpers/import-lock.js';


process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';
const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — шаг 3 регистрации не проверялся';

let pool;
let unlockImport;
const fixtures = { series: [], users: [] };
/** Заготовленные сериалы по жанрам: хватает на все правила сразу. */
const stock = {};

test.before(async () => {
  if (!available) return;
  pool = createPool();
// Пока файлы идут параллельно, а база одна, фикстуры шага 3 двигают каталог, и
// проверки постраничности не могут устоять. Та же сессионная блокировка, что и у
// них: обе стороны берут её на время работы файла.
  unlockImport = await acquireImportLock(pool);
  // Фикстуры заводятся одним заходом, а не по мере надобности: пока файлы
  // прогона идут параллельно, каталог должен быть неподвижен — иначе
  // проверки постраничности не могут устоять и уходят в пропуск.
  stock.drama = await seriesOf('drama', 4);
  stock.comedy = await seriesOf('comedy', 3);
  stock.sci = await seriesOf('sci-fi', 3);
  // Отдельное название: по нему проверяется строка поиска, и оно не должно
  // совпадать ни с чем, что ищут другие проверки общей базы.
  stock.searchable = await seriesOf('documentary', 1, 'Поисковыйобразецтаст');
});

test.after(async () => {
  if (!pool) return;
  if (fixtures.series.length) {
    await pool.query('DELETE FROM e_taste_seed WHERE series_id = ANY($1::bigint[])', [fixtures.series]);
    await pool.query('DELETE FROM e_season WHERE series_id = ANY($1::bigint[])', [fixtures.series]);
    await pool.query('DELETE FROM e_series WHERE id = ANY($1::bigint[])', [fixtures.series]);
  }
  await unlockImport?.();
  await pool.end();
});

/** Сериалы жанра: нужно минимум четыре, чтобы проверить запрет третьего. */
async function seriesOf(genre, count, title = 'Любимый') {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const slug = `taste3-${genre}-${crypto.randomUUID().slice(0, 8)}`;
    // eslint-disable-next-line no-await-in-loop
    const { rows: [row] } = await pool.query(
      `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
       VALUES ($1, $3, 'Favourite', $2, 'published', 'airing', 2024) RETURNING id, slug`,
      [slug, 970_000_000 + fixtures.series.length, title],
    );
    // eslint-disable-next-line no-await-in-loop
    const { rows: [season] } = await pool.query(
      'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [row.id],
    );
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      "INSERT INTO e_episode (season_id, number, title_ru, runtime_min) VALUES ($1, 1, 'Серия', 45)",
      [season.id],
    );
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      'INSERT INTO e_series_genre (series_id, genre_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [row.id, genre],
    );
    fixtures.series.push(row.id);
    ids.push(row.id);
  }
  return ids;
}

async function viewer() {
  const id = `t3-${crypto.randomUUID().slice(0, 8)}`;
  const { hash } = makeToken();
  const created = await pgAuthStore(pool).createUser({
    email: `${id}@example.com`,
    nickname: id,
    passwordHash: await hashPassword(PASSWORD),
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  fixtures.users.push(created.id);
  return {
    id: created.id,
    email: `${id}@example.com`,
    email_enc: null,
    password_hash: await hashPassword(PASSWORD),
    nickname: id,
    status: 'active',
    email_confirmed: true,
    locale: 'ru',
    theme: 'dark',
    timezone: 'Europe/Minsk',
  };
}

async function withServer({ user, run }) {
  const auth = stubAuthStore({ [user.email]: user });
  const app = createApp({
    data: stubData(),
    auth,
    catalogue: pgCatalogueList(pool),
    taste: pgTaste(pool),
    search: pgSearch(pool),
    sessionMw: createSessionMiddleware(pool, createMemorySessionStore(), {
      account: async (u) => ({ nickname: u.nickname, unread: 0, pollSeconds: 0 }),
    }),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let jar = '';

  const get = async (path, init = {}) => {
    const res = await fetch(base + path, {
      redirect: 'manual', ...init, headers: { cookie: jar, ...(init.headers ?? {}) },
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) jar = set.map((c) => c.split(';')[0]).join('; ');
    return res;
  };
  /**
   * Форма с повторяющимися полями.
   *
   * `new URLSearchParams({series: ['1','2']})` склеил бы значения через запятую,
   * а браузер шлёт отдельное поле на каждую галочку — и проверка прошла бы мимо
   * настоящего запроса.
   */
  const body = (fields) => {
    const encoded = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
      for (const item of [].concat(value)) encoded.append(name, String(item));
    }
    return encoded;
  };
  const post = (path, fields) => get(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body(fields),
  });
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

  const form = await (await get('/ru/login')).text();
  await post('/ru/login', { email: user.email, password: PASSWORD, csrf: csrfOf(form) });

  try {
    await run({ get, post, csrfOf });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('шаг 3 рисует сетку и правило выбора', { skip }, async () => {
  const user = await viewer();
  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/register/taste')).text();
      assert.match(page, /Шаг 3/, 'индикатор показывает третий шаг');
      assert.match(page, /name="series"/, 'сетка отдаёт поля выбора');
      assert.match(page, /value="skip"/, '«Пропустить» доступен всегда');

      // Счётчик выбора назван словами, а не только включением кнопки: без
      // скрипта браузер всё равно отправит пустую форму, и человек должен
      // понимать правило до отказа, а не после.
      assert.match(page, /от 3 до 5/, 'границы выбора названы текстом');

      const res = await post('/ru/register/taste', {
        series: ['1', '2'], csrf: csrfOf(page), action: 'save',
      });
      assert.match(res.headers.get('location') ?? '', /taste=too-few|too-few/,
        'меньше трёх — отказ с причиной, а не молчаливое сохранение');
    },
  });
});

test('подсказка о выборе названа числами, а не плейсхолдерами', { skip }, async () => {
  // Проверка появилась после находки в браузере: в подсказке печаталось
  // «Отметьте {min}–{max} сериалов» — ключ звали без параметров, и
  // подстановка не срабатывала.
  const user = await viewer();
  await withServer({
    user,
    run: async ({ get }) => {
      const page = await (await get('/ru/register/taste')).text();
      assert.ok(!/\{min\}|\{max\}/.test(page), 'в подсказке нет незаполненных плейсхолдеров');
      assert.match(page, /Отметьте 3–5 сериалов/, 'границы выбора названы числами');
    },
  });
});

test('выбор из трёх сохраняется и ведёт на главную', { skip }, async () => {
  const user = await viewer();
  const drama = stock.drama.slice(0, 2);
  const comedy = stock.comedy.slice(0, 1);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/register/taste')).text();
      const res = await post('/ru/register/taste', {
        series: [...drama, ...comedy].map(String), csrf: csrfOf(page), action: 'save',
      });

      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/ru/', 'после выбора — главная, а не кружок по кругу');

      const rows = await pool.query(
        'SELECT series_id, source FROM e_taste_seed WHERE user_id = $1', [user.id],
      );
      assert.equal(rows.rowCount, 3, 'три зерна записаны');
      assert.ok(rows.rows.every((r) => r.source === 'signup'));
    },
  });
});

test('больше трёх из одного жанра не принимается', { skip }, async () => {
  // Три из одного жанра — можно: правило «не более трёх» отсекает четвёртого,
  // а не третьего.
  const user = await viewer();
  const drama = stock.drama;
  const comedy = stock.comedy.slice(0, 1);

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/register/taste')).text();
      const res = await post('/ru/register/taste', {
        series: [...drama, ...comedy].map(String), csrf: csrfOf(page), action: 'save',
      });

      assert.match(res.headers.get('location') ?? '', /genre/,
        'отказ называет причину: слишком много одного жанра');
      const rows = await pool.query('SELECT series_id FROM e_taste_seed WHERE user_id = $1', [user.id]);
      assert.equal(rows.rowCount, 0, 'половина выбора не сохраняется');
    },
  });
});

test('больше пяти не принимается', { skip }, async () => {
  const user = await viewer();
  // Шесть, разложенные по жанрам законно: отказ обязан прийти именно по числу,
  // а не по жанру — иначе проверка ловила бы соседнее правило.
  const tooMany = [...stock.drama.slice(0, 3), ...stock.sci.slice(0, 3)];

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/register/taste')).text();
      const res = await post('/ru/register/taste', {
        series: tooMany.map(String), csrf: csrfOf(page), action: 'save',
      });

      assert.match(res.headers.get('location') ?? '', /too-many/);
    },
  });
});

test('строка поиска ищет, а не показывает всё подряд', { skip }, async () => {
  // Строка поиска уходила в каталог, который искать по тексту не умеет: запрос
  // молча возвращал всю выдачу, и поиск был украшением — «ничего не нашлось»
  // было недостижимым состоянием.
  const user = await viewer();
  await withServer({
    user,
    run: async ({ get }) => {
      const found = await (await get(`/ru/register/taste?q=${encodeURIComponent('Поисковыйобразецтаст')}`)).text();
      assert.match(found, /Поисковыйобразецтаст/, 'найденный сериал показан');

      const empty = await (await get(`/ru/register/taste?q=${encodeURIComponent('Заведомонесуществующийзапрос')}`)).text();
      assert.match(empty, /Ничего не нашлось/, 'несуществующий запрос даёт пустую сетку');
      assert.doesNotMatch(empty, /name="series"/, 'и ни одной карточки для выбора');
    },
  });
});

test('«Пропустить» ведёт на главную и ничего не пишет', { skip }, async () => {
  const user = await viewer();
  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/register/taste')).text();
      const res = await post('/ru/register/taste', {
        csrf: csrfOf(page), action: 'skip',
      });

      assert.equal(res.headers.get('location'), '/ru/');
      const rows = await pool.query('SELECT series_id FROM e_taste_seed WHERE user_id = $1', [user.id]);
      assert.equal(rows.rowCount, 0, 'пропуск не оставляет зёрен');
    },
  });
});

test('гостя на шаг не пускают', { skip }, async () => {
  const app = createApp({
    data: stubData(),
    auth: stubAuthStore({}),
    catalogue: pgCatalogueList(pool),
    taste: pgTaste(pool),
    search: pgSearch(pool),
    sessionMw: createSessionMiddleware(pool, createMemorySessionStore()),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/ru/register/taste`,
      { redirect: 'manual' });
    assert.notEqual(res.status, 200, 'шаг регистрации без сессии недоступен');
    assert.match(res.headers.get('location') ?? '', /login/, 'и предлагает войти');
  } finally {
    await new Promise((r) => server.close(r));
  }
});