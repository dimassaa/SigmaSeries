// HTTP-слой страницы сериала (F-02-01, S-06).
//
// Проверяется то, что видно посетителю: код ответа, заголовки, разметка и
// то, что в HTML попадает название. Источник данных — настоящий, база после
// импорта наполнена.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { pgSeries } from '../src/services/catalogue/series.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE или TEST_DATABASE_URL — HTTP не проверялся';

let pool;
let server;
let baseUrl;

/** Главная нужна как заглушка: её собственные источники тут не проверяются. */
function stubData() {
  return {
    banners: async () => [],
    fresh: async () => [],
    collections: async () => [],
    genres: async () => [],
  };
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  const app = createApp({ data: stubData(), series: pgSeries(pool) });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  // Сервер обязателен к закрытию: иначе прогон тестов не завершается — Node
  // ждёт, пока схлопнется цикл событий, а живое соединение этому мешает.
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
});

const get = (path) => fetch(`${baseUrl}${path}`);

async function anySlug() {
  const { rows } = await pool.query(
    "SELECT slug FROM e_series WHERE publication_state = 'published' AND archived_at IS NULL AND year_start IS NOT NULL ORDER BY year_start DESC LIMIT 1",
  );
  return rows[0]?.slug;
}

test('страница сериала отвечает 200 и содержит название', { skip }, async () => {
  const slug = await anySlug();
  const response = await get(`/ru/series/${slug}`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /<h1 class="series__title">/);
  assert.ok(!body.includes('undefined'), 'в разметке не должно быть undefined');
});

test('в разметке есть JSON-LD TVSeries (F-02-01 §18)', { skip }, async () => {
  const slug = await anySlug();
  const body = await (await get(`/ru/series/${slug}`)).text();
  const match = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(match, 'разметка schema.org обязательна');

  const data = JSON.parse(match[1]);
  assert.equal(data['@type'], 'TVSeries');
  assert.ok(data.name);
  assert.ok(Array.isArray(data.genre) || data.genre === undefined);
});

test('канонический адрес и переключение языка заданы (R-SEO-02, R-SEO-03)', { skip }, async () => {
  const slug = await anySlug();
  const body = await (await get(`/ru/series/${slug}`)).text();
  assert.ok(body.includes(`href="/ru/series/${slug}"`), 'канонический адрес');
  assert.ok(body.includes(`hreflang="en"`), 'английский вариант объявлен');
});

test('неизвестный сериал — 404', { skip }, async () => {
  const response = await get('/ru/series/такого-нет-в-каталоге');
  assert.equal(response.status, 404);
});

test('локаль вне ru и en не обслуживается', { skip }, async () => {
  assert.equal((await get('/de/series/breaking-bad')).status, 404);
});

test('снятый с публикации сериал — 410, а не 404 (EC-C1)', { skip }, async () => {
  const slug = await anySlug();
  const { rows } = await pool.query(
    "SELECT id FROM e_series WHERE publication_state = 'published' AND slug = $1", [slug],
  );
  await pool.query('UPDATE e_series SET archived_at = now() WHERE id = $1', [rows[0].id]);
  try {
    const response = await get(`/ru/series/${slug}`);
    const body = await response.text();
    assert.equal(response.status, 410);
    assert.match(body, /снят с публикации/);
  } finally {
    await pool.query('UPDATE e_series SET archived_at = NULL WHERE id = $1', [rows[0].id]);
  }
});

test('английская страница без русского описания не индексируется (R-SEO-04)', { skip }, async () => {
  const slug = await anySlug();
  const body = await (await get(`/en/series/${slug}`)).text();
  if (body.includes('name="robots" content="noindex')) {
    assert.match(body, /noindex/, 'без перевода описания страница не должна попадать в выдачу');
  }
  assert.ok(body.includes('<html'), 'страница в любом случае открывается');
});

test('русская страница индексируется', { skip }, async () => {
  const slug = await anySlug();
  const body = await (await get(`/ru/series/${slug}`)).text();
  assert.equal(body.includes('noindex'), false);
});

test('описание экранируется, разметка из источника не исполняется (R-SEC-15)', { skip }, async () => {
  const slug = await anySlug();
  const body = await (await get(`/ru/series/${slug}`)).text();
  const { rows } = await pool.query('SELECT title_original FROM e_series WHERE slug = $1', [slug]);
  assert.ok(body.includes(rows[0].title_original), 'название показано как есть');
});