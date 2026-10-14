// Отдача картинок из базы (F-12-05, требование Бланка 3.3.1).
//
// Проверяется на живых данных: после загрузки в базе лежат настоящие JPEG,
// перекодированные в WebP, и маршрут обязан отдать их с правильными
// заголовками — иначе браузер перезапросит картинку при каждом заходе.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE или TEST_DATABASE_URL — картинки не проверялись';

let pool;
let server;
let baseUrl;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  const app = createApp({ data: stubData(), pool });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
});

function stubData() {
  return { banners: async () => [], fresh: async () => [], collections: async () => [], genres: async () => [] };
}

/** Сериал с загруженным постером, либо null. */
async function withPoster() {
  const { rows } = await pool.query(
    `SELECT s.slug, iv.width
       FROM e_series s
       JOIN e_image i ON i.series_id = s.id AND i.role = 'poster'
       JOIN e_image_variant iv ON iv.image_id = i.id
      ORDER BY s.slug, iv.width
      LIMIT 1`,
  );
  return rows[0] ?? null;
}

test('картинка отдаётся с типом и бессрочным кэшем', { skip }, async () => {
  const found = await withPoster();
  if (!found) return; // картинки ещё не загружены — не дефект маршрута

  const response = await fetch(`${baseUrl}/ru/images/${found.slug}/poster-${found.width}.webp`);
  const body = Buffer.from(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/webp');
  assert.ok(response.headers.get('etag'), 'ETag обязателен: адрес содержит не хэш');
  assert.match(response.headers.get('cache-control'), /immutable/);
  assert.ok(body.length > 0);
});

test('ETag стабилен между запросами', { skip }, async () => {
  const found = await withPoster();
  if (!found) return;
  const url = `${baseUrl}/ru/images/${found.slug}/poster-${found.width}.webp`;
  const first = await fetch(url);
  const second = await fetch(url);
  assert.equal(first.headers.get('etag'), second.headers.get('etag'));
});

test('несуществующая картинка — 404 без страницы', { skip }, async () => {
  const response = await fetch(`${baseUrl}/ru/images/nesushchestvuyushchiy/poster-342.webp`);
  assert.equal(response.status, 404);
  assert.equal((await response.text()).trim(), '', 'битая картинка не должна показывать чужой текст');
});

test('выдуманная роль и ширина не отдаются', { skip }, async () => {
  const found = await withPoster();
  const slug = found?.slug ?? 'breaking-bad';
  assert.equal((await fetch(`${baseUrl}/ru/images/${slug}/sekret-342.webp`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/ru/images/${slug}/poster-99999.webp`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/ru/images/${slug}/poster-abc.webp`)).status, 404);
});

test('путь без локали не обслуживается', { skip }, async () => {
  const found = await withPoster();
  const slug = found?.slug ?? 'breaking-bad';
  assert.equal((await fetch(`${baseUrl}/images/${slug}/poster-342.webp`)).status, 404);
});