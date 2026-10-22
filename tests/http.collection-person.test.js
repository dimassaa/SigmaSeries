// Подборка (F-02-05, S-05) и персона (F-02-09, S-15): адреса, индекс, ссылки.
//
// Поиск и карточка сериала предлагают эти адреса, поэтому проверка ссылок
// (`http.links`) тоже за них отвечает. Здесь — то, что видит человек: код
// ответа, `noindex` у человека с одним сериалом (F-02-09 §3) и то, что в «В
// ролях» имя ведёт на страницу человека.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { pgCatalogueList } from '../src/services/catalogue/list.js';
import { pgSeasons } from '../src/services/catalogue/season.js';
import { pgCollections } from '../src/services/catalogue/collection.js';
import { pgPerson } from '../src/services/catalogue/person.js';
import { stubData } from '../src/services/home/data.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — адреса подборки и персоны не проверялись';

const MIN_VISIBLE = 6;

let pool;
let server;
let baseUrl;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  const app = createApp({
    data: stubData(),
    series: pgSeries(pool),
    catalogue: pgCatalogueList(pool),
    seasons: pgSeasons(pool),
    collections: pgCollections(pool),
    person: pgPerson(pool),
    // Баннер подборки отдаётся маршрутом картинок — без подключения страница
    // ссылалась бы в пустоту.
    pool,
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve(undefined);
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
});

const get = (path) => fetch(`${baseUrl}${path}`);

async function sixVisibleSeries() {
  const { rows } = await pool.query(
    `SELECT id FROM e_series WHERE publication_state = 'published' AND archived_at IS NULL
      ORDER BY id LIMIT $1`,
    [MIN_VISIBLE],
  );
  return rows.map((row) => row.id);
}

/**
 * Подборка из шести видимых сериалов.
 *
 * Фикстура создаётся и убирается сама: чужие строки каталога не должны
 * появляться и исчезать из-за чужого теста.
 *
 * @returns {Promise<{slug: string, cleanup: () => Promise<void>}>}
 */
async function withCollection() {
  const series = await sixVisibleSeries();
  const { rows: [row] } = await pool.query(
    "INSERT INTO e_collection (slug, title_ru, description_ru, weight) VALUES ($1, $2, $3, 10) RETURNING id, slug",
    ['test-http-collection-page', 'Подборка для страницы', 'Описание подборки для проверки'],
  );
  for (const [index, id] of series.entries()) {
    await pool.query(
      'INSERT INTO e_collection_item (collection_id, series_id, ordinal) VALUES ($1, $2, $3)',
      [row.id, id, index],
    );
  }
  return {
    slug: row.slug,
    cleanup: async () => {
      await pool.query('DELETE FROM e_collection WHERE id = $1', [row.id]);
    },
  };
}

test('страница подборки открывается и показывает все шесть сериалов', { skip }, async () => {
  const fixture = await withCollection();
  try {
    const response = await get(`/ru/collections/${fixture.slug}`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /<link rel="canonical" href="\/ru\/collections\/[^"]+">/,
      'канонический адрес подборки — свой');
    assert.equal((body.match(/class="poster"/g) ?? []).length, MIN_VISIBLE,
      'в сетке все шесть постеров');
    assert.match(body, /Описание подборки для проверки/);
  } finally {
    await fixture.cleanup();
  }
});

test('подборка из пяти сериалов не открывается ни под своим адресом, ни ссылкой', { skip }, async () => {
  const series = await sixVisibleSeries();
  const { rows: [row] } = await pool.query(
    "INSERT INTO e_collection (slug, title_ru, weight) VALUES ($1, $2, 10) RETURNING id, slug",
    ['test-http-collection-thin-page', 'Тонкая подборка'],
  );
  for (const id of series.slice(0, MIN_VISIBLE - 1)) {
    await pool.query(
      'INSERT INTO e_collection_item (collection_id, series_id, ordinal) VALUES ($1, $2, 0)',
      [row.id, id],
    );
  }

  try {
    assert.equal((await get(`/ru/collections/${row.slug}`)).status, 404,
      'прямая ссылка на тонкую подборку — 404 (F-02-05 §5)');
    const home = await (await get('/ru/')).text();
    assert.ok(!home.includes(`/collections/${row.slug}`), 'на главной её тоже нет');
  } finally {
    await pool.query('DELETE FROM e_collection WHERE id = $1', [row.id]);
  }
});

test('неизвестная подборка — 404', { skip }, async () => {
  assert.equal((await get('/ru/collections/такой-подборки-нет')).status, 404);
});

test('баннер подборки отдаётся своим адресом и совпадает с тем, что в раскладке', { skip }, async () => {
  const fixture = await withCollection();
  try {
    const page = await (await get(`/ru/collections/${fixture.slug}`)).text();
    const asked = page.match(/\/ru\/collections\/[^"]+\/banner-(\d+)\.webp/);
    if (!asked) {
      // Фонов в базе нет — тогда и проверять нечего, но адрес обязан ответить
      // пустым, а не ошибкой: битая картинка в баннере заметна глазом.
      assert.equal((await get(`/ru/collections/${fixture.slug}/banner-1280.webp`)).status, 404);
      return;
    }

    const banner = await get(`/ru/collections/${fixture.slug}/banner-${asked[1]}.webp`);
    assert.equal(banner.status, 200);
    assert.equal(banner.headers.get('content-type'), 'image/webp');
    assert.ok(banner.headers.get('etag'), 'картинка отдаётся с ETag, иначе браузер тянет её заново');

    const bytes = Buffer.from(await banner.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), 'RIFF', 'пришли байты картинки, а не HTML');
  } finally {
    await fixture.cleanup();
  }
});

test('страница человека открывается, имя и сериалы на месте', { skip }, async () => {
  const series = await sixVisibleSeries();
  const { rows: [row] } = await pool.query(
    "INSERT INTO e_person (slug, name, kind) VALUES ('test-http-person-page', 'Проверочный Человек', 'actor') RETURNING id, slug",
  );
  for (const [index, id] of series.entries()) {
    await pool.query(
      'INSERT INTO e_series_person (series_id, person_id, role, ordinal) VALUES ($1, $2, $3, $4)',
      [id, row.id, 'actor', index],
    );
  }

  try {
    const response = await get(`/ru/people/${row.slug}`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Проверочный Человек/);
    assert.equal((body.match(/class="poster"/g) ?? []).length, MIN_VISIBLE);
    assert.match(body, /<link rel="canonical" href="\/ru\/people\/test-http-person-page">/);
  } finally {
    await pool.query('DELETE FROM e_series_person WHERE person_id = $1', [row.id]);
    await pool.query('DELETE FROM e_person WHERE id = $1', [row.id]);
  }
});

test('человек с одним сериалом не индексируется (F-02-09 §3)', { skip }, async () => {
  const series = await sixVisibleSeries();
  const { rows: [row] } = await pool.query(
    "INSERT INTO e_person (slug, name, kind) VALUES ('test-http-person-thin', 'Один Сериал', 'actor') RETURNING id, slug",
  );
  await pool.query(
    'INSERT INTO e_series_person (series_id, person_id, role, ordinal) VALUES ($1, $2, $3, $4)',
    [series[0], row.id, 'actor', 0],
  );

  try {
    const body = await (await get(`/ru/people/${row.slug}`)).text();
    assert.match(body, /<meta name="robots" content="noindex, follow">/,
      'человек с одним сериалом в индексе не нужен');
  } finally {
    await pool.query('DELETE FROM e_series_person WHERE person_id = $1', [row.id]);
    await pool.query('DELETE FROM e_person WHERE id = $1', [row.id]);
  }
});

test('человек с несколькими сериалами индексируется', { skip }, async () => {
  const series = await sixVisibleSeries();
  const { rows: [row] } = await pool.query(
    "INSERT INTO e_person (slug, name, kind) VALUES ('test-http-person-indexed', 'Два Сериала', 'actor') RETURNING id, slug",
  );
  for (const id of series.slice(0, 2)) {
    await pool.query(
      'INSERT INTO e_series_person (series_id, person_id, role, ordinal) VALUES ($1, $2, $3, $4)',
      [id, row.id, 'actor', 0],
    );
  }

  try {
    const body = await (await get(`/ru/people/${row.slug}`)).text();
    assert.ok(!body.includes('noindex'), 'человек с двумя сериалами индексируется');
  } finally {
    await pool.query('DELETE FROM e_series_person WHERE person_id = $1', [row.id]);
    await pool.query('DELETE FROM e_person WHERE id = $1', [row.id]);
  }
});

test('человек без видимых сериалов и несуществующий — 404', { skip }, async () => {
  const { rows: [row] } = await pool.query(
    "INSERT INTO e_person (slug, name, kind) VALUES ('test-http-person-alone-page', 'Ни с кем', 'actor') RETURNING id, slug",
  );
  try {
    assert.equal((await get(`/ru/people/${row.slug}`)).status, 404);
    assert.equal((await get('/ru/people/такого-человека-нет')).status, 404);
  } finally {
    await pool.query('DELETE FROM e_person WHERE id = $1', [row.id]);
  }
});

test('имя в «В ролях» ведёт на страницу человека, а не на пустую строку', { skip }, async () => {
  const series = await sixVisibleSeries();
  const { rows: [person] } = await pool.query(
    "INSERT INTO e_person (slug, name, kind) VALUES ('test-http-person-cast', 'Актёр В Ролях', 'actor') RETURNING id, slug",
  );
  await pool.query(
    'INSERT INTO e_series_person (series_id, person_id, role, ordinal) VALUES ($1, $2, $3, $4)',
    [series[0], person.id, 'actor', 0],
  );

  try {
    const { rows: [target] } = await pool.query(
      "SELECT slug FROM e_series WHERE id = $1",
      [series[0]],
    );
    const card = await (await get(`/ru/series/${target.slug}`)).text();

    assert.ok(card.includes(`/ru/people/${person.slug}`),
      'в «В ролях» имя должно быть ссылкой на страницу человека');

    const page = await get(`/ru/people/${person.slug}`);
    assert.equal(page.status, 200, 'ссылка ведёт на 200, а не в 404');
  } finally {
    await pool.query('DELETE FROM e_series_person WHERE person_id = $1', [person.id]);
    await pool.query('DELETE FROM e_person WHERE id = $1', [person.id]);
  }
});

test('английские адреса подборки и человека открываются', { skip }, async () => {
  const fixture = await withCollection();
  const series = await sixVisibleSeries();
  const { rows: [person] } = await pool.query(
    "INSERT INTO e_person (slug, name, kind) VALUES ('test-http-person-en', 'English Person', 'actor') RETURNING id, slug",
  );
  for (const id of series.slice(0, 2)) {
    await pool.query(
      'INSERT INTO e_series_person (series_id, person_id, role, ordinal) VALUES ($1, $2, $3, $4)',
      [id, person.id, 'actor', 0],
    );
  }

  try {
    const collection = await get(`/en/collections/${fixture.slug}`);
    assert.equal(collection.status, 200);
    assert.match(await collection.text(), /<html lang="en"/);

    const page = await get(`/en/people/${person.slug}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html lang="en"/);
  } finally {
    await pool.query('DELETE FROM e_series_person WHERE person_id = $1', [person.id]);
    await pool.query('DELETE FROM e_person WHERE id = $1', [person.id]);
    await fixture.cleanup();
  }
});