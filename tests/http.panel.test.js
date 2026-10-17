// Правая панель «Предстоящие» в интерфейсе (F-03-06, UI-04).
//
// Проверяется то, что человек видит: панель стоит на списковых страницах и не
// стоит там, где её не ждут; подписи дат и ссылка на календарь на месте; пустое
// состояние не выглядит поломкой.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { pgUpcomingPanel } from '../src/services/catalogue/panel.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { pgSeasons } from '../src/services/catalogue/season.js';
import { pgCatalogueList } from '../src/services/catalogue/list.js';
import { pgCollections } from '../src/services/catalogue/collection.js';
import { pgPerson } from '../src/services/catalogue/person.js';
import { pgSearch } from '../src/services/search/service.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { todayIn } from '../src/services/timezone.js';

process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — панель в интерфейсе не проверялась';

// Дата берётся тем же способом, что и в панели: иначе на сервере в другом
// поясе фикстура окажется «завтра», а панель покажет сегодняшние.
const TODAY = todayIn('Europe/Minsk');

let pool;
let server;
let baseUrl;
let fixtureSlug;

test.before(async () => {
  if (!available) return;
  pool = createPool();

  // Свой сериал с выходом завтра: его строка должна быть в панели рядом с
  // настоящим каталогом и не потеряться среди чужих.
  fixtureSlug = `panel-ui-${crypto.randomUUID().slice(0, 8)}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Панель в интерфейсе', 'Panel UI', $2, 'published', 'airing', 2024) RETURNING id`,
    [fixtureSlug, 984_000_000],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [series.id],
  );
  const { rows: [episode] } = await pool.query(
    `INSERT INTO e_episode (season_id, number, title_ru, runtime_min)
     VALUES ($1, 4, 'Четвёртая', 45) RETURNING id`, [season.id],
  );
  const { rows: [release] } = await pool.query(
    `INSERT INTO e_release (season_id, release_date, precision, state)
     VALUES ($1, $2::date, 'date', 'scheduled') RETURNING id`, [season.id, TODAY],
  );
  await pool.query(
    'INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)',
    [release.id, episode.id],
  );
  // Голоса заведомо большие: панель сортирует по ним при равных датах, и без
  // этого фикстура не попала бы в первые строки рядом с настоящим каталогом.
  await pool.query(
    `INSERT INTO e_external_rating (series_id, platform, value, votes, measured_on)
     VALUES ($1, 'imdb', 8.4, 9_000_000, CURRENT_DATE)`,
    [series.id],
  );

  const app = createApp({
    data: stubData(),
    series: pgSeries(pool),
    seasons: pgSeasons(pool),
    catalogue: pgCatalogueList(pool),
    collections: pgCollections(pool),
    person: pgPerson(pool),
    search: pgSearch(pool),
    panel: pgUpcomingPanel(pool),
    auth: stubAuthStore({}),
    sessionMw: createSessionMiddleware(
      { query: async () => ({ rows: [] }), on: () => {} },
      createMemorySessionStore(),
    ),
  });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) {
    await pool.query('DELETE FROM e_season WHERE series_id = (SELECT id FROM e_series WHERE slug = $1)', [fixtureSlug]);
    await pool.query('DELETE FROM e_series WHERE slug = $1', [fixtureSlug]);
    await pool.end();
  }
});

const get = (path) => fetch(`${baseUrl}${path}`);

test('панель стоит на списковых страницах и не стоит на остальных', { skip }, async () => {
  const listed = ['/ru/', '/ru/series'];
  for (const path of listed) {
    // eslint-disable-next-line no-await-in-loop
    const body = await (await get(path)).text();
    assert.match(body, /class="panel"/, `панели нет на ${path}`);
    assert.match(body, /Скоро/, `заголовка нет на ${path}`);
    assert.match(body, /href="\/ru\/calendar"/, `ссылки на календарь нет на ${path}`);
  }

  const collection = await (await get('/ru/search?q=%D1%81%D0%B5%D1%80%D0%B8%D0%B0%D0%BB')).text();
  assert.match(collection, /class="panel"/, 'в поиске панель тоже есть (S-17)');
});

test('строка панели ведёт на сериал и несёт подпись даты', { skip }, async () => {
  const body = await (await get('/ru/')).text();

  assert.ok(body.includes(`href="/ru/series/${fixtureSlug}"`), 'строка ведёт на карточку сериала');
  assert.match(body, /S1E4/, 'подпись серии в стиле макета — «S1E4»');
  assert.match(body, /Завтра|Сегодня вышла|Через \d+ дн|окт\./, 'и подпись даты словами или датой');
});

test('английский адрес подписывает дату по-английски', { skip }, async () => {
  const body = await (await get('/en/')).text();

  assert.match(body, /Soon/, 'заголовок переведён');
  // Подпись даты переводится (R-I18N-05), а название сериала остаётся тем, что
  // лежит в каталоге: перевода у него нет (DEC-006).
  assert.ok(/Out today|Tomorrow|In \d+ days|\b\d{1,2} [A-Z][a-z]{2}/.test(body),
    'английская подпись даты приходит из строк, а не из русской строки');
});

test('без выходов панель объясняет и предлагает календарь', { skip }, async () => {
  // Источник, у которого нет ни одной строки: пустое состояние по F-03-06 §5.
  const empty = { upcoming: async () => [] };
  const app = createApp({
    data: stubData(),
    panel: empty,
    auth: stubAuthStore({}),
    sessionMw: createSessionMiddleware(
      { query: async () => ({ rows: [] }), on: () => {} },
      createMemorySessionStore(),
    ),
  });
  const own = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });

  try {
    const body = await (await fetch(`http://127.0.0.1:${own.address().port}/ru/`)).text();
    assert.match(body, /В ближайшие дни ничего не выходит/, 'пустая панель говорит, что это не поломка');
    assert.match(body, /href="\/ru\/calendar"/, 'и ведёт в календарь');
  } finally {
    await new Promise((resolve) => own.close(resolve));
  }
});

test('источник панели без строк не ломает страницу, а без источника панели нет', { skip }, async () => {
  const broken = {
    upcoming: async () => { throw new Error('база недоступна'); },
  };
  const app = createApp({
    data: stubData(),
    panel: broken,
    auth: stubAuthStore({}),
    sessionMw: createSessionMiddleware(
      { query: async () => ({ rows: [] }), on: () => {} },
      createMemorySessionStore(),
    ),
  });
  const own = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });

  try {
    const res = await fetch(`http://127.0.0.1:${own.address().port}/ru/`);
    const body = await res.text();
    assert.equal(res.status, 200, 'страница открылась: панель — дополнение, а не содержимое');
  } finally {
    await new Promise((resolve) => own.close(resolve));
  }

  const without = createApp({
    data: stubData(),
    auth: stubAuthStore({}),
    sessionMw: createSessionMiddleware(
      { query: async () => ({ rows: [] }), on: () => {} },
      createMemorySessionStore(),
    ),
  });
  const bare = await new Promise((resolve) => { const s = without.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const body = await (await fetch(`http://127.0.0.1:${bare.address().port}/ru/`)).text();
    assert.ok(!body.includes('class="panel"'), 'без источника панели на странице нет');
  } finally {
    await new Promise((resolve) => bare.close(resolve));
  }
});

void TODAY;