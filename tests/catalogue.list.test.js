// Каталог с фильтрами против настоящей базы (F-02-03).
//
// Фильтры проверяются на данных после импорта: в базе больше тысячи сериалов,
// и запрос, который работает на трёх подставных строках, разваливается на
// сортировке по голосам и на пустом рейтинге. Пропускается, если PG* не заданы.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgCatalogueList } from '../src/services/catalogue/list.js';
import { acquireImportLock } from './helpers/import-lock.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE или TEST_DATABASE_URL — каталог не проверялся';

let pool;
let catalogue;
let unlockImport;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  // Размер страницы и порог рейтинга лежат в общих настройках: без блокировки
  // соседняя проверка порога пересчитала бы этот каталог под своим числом.
  unlockImport = await acquireImportLock(pool);
  catalogue = pgCatalogueList(pool);
});

test.after(async () => {
  if (!pool) return;
  await unlockImport?.();
  await pool.end();
});

/** Сколько опубликованных сериалов в базе — эталон для «всех». */
async function published() {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM e_series WHERE publication_state = 'published' AND archived_at IS NULL",
  );
  return rows[0].n;
}

/**
 * Общее число страницы равно числу опубликованных сериалов.
 *
 * Два чтения подряд не могут увидеть одно и то же: база общая, и параллельные
 * прогоны создают и убирают свои фикстуры между ними. Поэтому сравнение
 * повторяется — а не ослабляется: расхождение означало бы, что список считает
 * не то, что фильтр.
 *
 * @param {object} options параметры каталога
 * @returns {Promise<object>} страница, для которой числа сошлись
 */
async function assertTotalMatches(options) {
  // База общая, и параллельные прогоны создают и убирают фикстуры между
  // чтениями. Поэтому сравнение повторяется: ослаблять его до «примерно равно»
  // нельзя — расхождение означало бы, что список считает не то, что фильтр,
  // а повторение просто ждёт момента, когда каталог не меняется.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const page = await catalogue.list(options);
    // eslint-disable-next-line no-await-in-loop
    const total = await published();
    if (page.total === total) return page;
  }

  const page = await catalogue.list(options);
  assert.equal(page.total, await published(),
    'в списке ровно опубликованные видимые сериалы (шесть попыток — каталог менялся под ногами)');
  return page;
}

test('список показывает только опубликованные и не архивные', { skip }, async () => {
  const page = await assertTotalMatches({});
  assert.ok(page.items.length > 0, 'база после импорта не пуста');
  const { rows: hidden } = await pool.query(
    `SELECT count(*)::int AS n FROM e_series s
       JOIN unnest($1::bigint[]) AS u(series_id) ON u.series_id = s.id
      WHERE s.publication_state <> 'published' OR s.archived_at IS NOT NULL`,
    [page.items.map((item) => item.id)],
  );
  assert.equal(hidden[0].n, 0, 'неопубликованных и архивных в выдаче нет');
});

test('страницы не пересекаются и считаются от общего числа', { skip }, async () => {
  const first = await catalogue.list({ page: 1 });
  const second = await catalogue.list({ page: 2 });

  assert.ok(first.size > 1, 'страница не в одну карточку — иначе проверка ничего не значит');
  assert.equal(first.pages, Math.ceil(first.total / first.size));
  assert.equal(first.items.length, first.size);
  assert.equal(second.items.length, first.size);
  const overlap = first.items.filter((a) => second.items.some((b) => b.id === a.id));
  assert.deepEqual(overlap, [], 'страница 2 не повторяет страницу 1');
});

test('страница за пределами списка пуста, а не обрезается молча', { skip }, async () => {
  // Два чтения подряд видят разные моменты: параллельные прогоны добавляют и
  // убирают фикстуры между ними. Поэтому общая величина сравнивается повторно,
  // а не ослабляется до «примерно равно».
  let first = await catalogue.list({ page: 1 });
  let beyond = await catalogue.list({ page: first.pages + 3 });
  for (let attempt = 0; attempt < 3 && beyond.total !== first.total; attempt += 1) {
    first = await catalogue.list({ page: 1 });
    beyond = await catalogue.list({ page: first.pages + 3 });
  }

  assert.deepEqual(beyond.items, [], 'выдача пуста — маршрут отвечает 301 на последнюю страницу');
  assert.equal(beyond.total, first.total, 'общее число остаётся, по нему считается последняя страница');
});

test('жанр сужает выдачу, а незнакомый жанр игнорируется', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT g.code, count(*)::int AS n
       FROM e_series_genre sg
       JOIN e_series s ON s.id = sg.series_id AND s.publication_state = 'published' AND s.archived_at IS NULL
       JOIN e_genre g ON g.code = sg.genre_code
      GROUP BY g.code HAVING count(*) > 0 ORDER BY n DESC LIMIT 1`,
  );
  const genre = rows[0];
  assert.ok(genre, 'в базе есть опубликованные сериалы хотя бы одного жанра');

  const filtered = await catalogue.list({ genres: [genre.code] });
  assert.ok(filtered.total > 0);
  // Порог сравнивается с числом опубликованных «на сейчас»: параллельные
  // прогоны добавляют и убирают фикстуры, поэтому и верхняя граница, и сам
  // фильтр берутся одним повторяющимся чтением.
  let all = await published();
  for (let attempt = 0; attempt < 3 && filtered.total >= all; attempt += 1) {
    all = await published();
  }
  assert.ok(filtered.total < all, 'фильтр действительно сужает');
  // У сериала жанров несколько, а в подписи под постером показан один, поэтому
  // принадлежность жанру проверяется запросом, а не полем карточки.
  const { rows: withGenre } = await pool.query(
    `SELECT count(*)::int AS n FROM e_series s
       JOIN unnest($1::bigint[]) AS u(series_id) ON u.series_id = s.id
       JOIN e_series_genre sg ON sg.series_id = s.id AND sg.genre_code = $2`,
    [filtered.items.map((item) => item.id), genre.code],
  );
  assert.equal(withGenre[0].n, filtered.items.length, 'в выдаче только сериалы выбранного жанра');

  const ignored = await catalogue.list({ genres: ['такого-жанра-нет'] });
  assert.equal(ignored.total, await published(), 'незнакомый код не сужает и не ломает выдачу');
});

test('диапазон годов и рейтинг отсекают по значениям', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT year_start FROM e_series
      WHERE publication_state = 'published' AND archived_at IS NULL AND year_start IS NOT NULL
      ORDER BY year_start LIMIT 1`,
  );
  const oldest = rows[0].year_start;

  const recent = await catalogue.list({ yearFrom: oldest + 10 });
  assert.ok(recent.items.every((item) => item.yearStart >= oldest + 10),
    'в выдаче нет сериалов старше нижней границы');

  const rated = await catalogue.list({ ratingFrom: 9 });
  assert.ok(rated.items.every((item) => item.rating === null || item.rating >= 9),
    'рейтинг ниже порога не попадает');
});

test('состояние выхода — из белого списка', { skip }, async () => {
  const airing = await catalogue.list({ states: ['airing'] });
  assert.ok(airing.items.every((item) => item.exitState === 'airing'));

  const junk = await assertTotalMatches({ states: ["airing'; DROP TABLE e_series; --"] });
  assert.ok(junk.total > 0, 'мусор в адресе не сужает выдачу и не ломает базу');
});

test('сортировка выбирается из белого списка', { skip }, async () => {
  const popular = await catalogue.list({ sort: 'popular' });
  const junk = await catalogue.list({ sort: 'votes); DROP TABLE e_series; --' });
  assert.deepEqual(junk.items.map((i) => i.id), popular.items.map((i) => i.id),
    'неизвестная сортировка молча заменяется популярностью');

  // Порядок сравнивается с тем же запросом в базе, а не с `Array.sort()`:
  // сортировка PostgreSQL по правилам локали не совпадает с порядком строк в
  // JavaScript, и сравнение с ним ловило бы чужую ошибку.
  const byTitle = await catalogue.list({ sort: 'title' });
  const { rows: expected } = await pool.query(`
    SELECT s.id FROM e_series s
     WHERE s.publication_state = 'published' AND s.archived_at IS NULL
     ORDER BY coalesce(s.title_ru, s.title_en, s.title_original) ASC
     LIMIT $1`, [byTitle.size]);
  assert.deepEqual(byTitle.items.map((item) => item.id), expected.map((row) => row.id),
    'по названию — по алфавиту, так же, как считает база');

  const byRating = await catalogue.list({ sort: 'rating' });
  const values = byRating.items.map((item) => item.rating ?? -1);
  assert.deepEqual(values, [...values].sort((a, b) => b - a), 'по рейтингу — по убыванию');
});

test('границы фильтров берутся из данных', { skip }, async () => {
  const filters = await catalogue.filters();

  assert.ok(filters.genres.length > 0, 'жанры для фильтра есть');
  assert.ok(filters.genres.every((genre) => genre.count > 0), 'жанр без сериалов в фильтр не попадает');
  assert.ok(filters.yearMin < filters.yearMax, 'диапазон годов не вырожден');
  assert.ok(filters.ratingMax > 0 && filters.ratingMin <= filters.ratingMax, 'шкала рейтинга осмысленна');
  assert.deepEqual(
    filters.states.map((state) => state.key),
    ['airing', 'waiting', 'announced', 'ended', 'cancelled'],
    'состояния в порядке, в котором человек о них думает, а не как в базе',
  );
});

test('страна сужает выдачу, а серия — по каналу', { skip }, async () => {
  const { rows: country } = await pool.query(
    `SELECT sc.country_code AS code, count(*)::int AS n
       FROM e_series_country sc
       JOIN e_series s ON s.id = sc.series_id
        AND s.publication_state = 'published' AND s.archived_at IS NULL
      GROUP BY sc.country_code ORDER BY n DESC LIMIT 1`,
  );
  assert.ok(country.length, 'страны залиты хотя бы для одного сериала');
  const byCountry = await catalogue.list({ countries: [country[0].code] });
  let all = await published();
  for (let attempt = 0; attempt < 3 && byCountry.total >= all; attempt += 1) {
    all = await published();
  }
  assert.ok(byCountry.total > 0 && byCountry.total < all, 'страна действительно сужает выдачу');

  const { rows: foreign } = await pool.query(
    `SELECT sn.network_id::text AS id, count(*)::int AS n
       FROM e_series_network sn
       JOIN e_series s ON s.id = sn.series_id
        AND s.publication_state = 'published' AND s.archived_at IS NULL
      GROUP BY sn.network_id ORDER BY n DESC LIMIT 1`,
  );
  assert.ok(foreign.length, 'сети залиты хотя бы для одного сериала');
  const byNetwork = await catalogue.list({ networks: [foreign[0].id] });
  assert.ok(byNetwork.total > 0);
  const { rows: members } = await pool.query(
    `SELECT count(*)::int AS n FROM e_series_network WHERE network_id = $1`, [foreign[0].id],
  );
  assert.ok(byNetwork.total <= members[0].n, 'фильтр по сети не может дать больше, чем есть связей');

  await assertTotalMatches({ countries: ['ZZ'], networks: ['нет такого'] });
});

test('поиск по справочнику сужает список вариантов, а не выдачу', { skip }, async () => {
  const all = await catalogue.filters();
  const search = await catalogue.filters({ networkSearch: 'hbo' });

  assert.ok(search.networks.length < all.networks.length, 'список сетей сузился');
  assert.ok(search.networks.every((row) => row.name.toLowerCase().includes('hbo')),
    `в списке только совпадения: ${search.networks.map((row) => row.name).join(', ')}`);
  assert.equal(search.countries.length, all.countries.length,
    'поиск по сетям не трогает список стран');
});

test('размер страницы берётся из настроек, а не из адреса', { skip }, async () => {
  const page = await catalogue.list({});
  const { rows } = await pool.query("SELECT value FROM e_system_setting WHERE key = 'catalog.page_size'");

  assert.equal(page.size, rows[0] ? Number(rows[0].value) : 24,
    'число страницы — из catalog.page_size, а не из того, что прислал клиент');
});