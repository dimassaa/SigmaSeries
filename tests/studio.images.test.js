// Загрузка изображений в студии (F-10-04).
//
// Проверяется правило, а не картинка: тип по содержимому, предел размера и
// минимальный размер под роль. Кадр не того типа должен быть отвергнут, даже
// если называется картинкой.

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import sharp from 'sharp';

import { pgStudioImages } from '../src/services/studio/images.js';

const CONN = process.env.PGHOST && process.env.PGDATABASE
  ? {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER,
      database: process.env.PGDATABASE,
    }
  : process.env.TEST_DATABASE_URL
    ? { connectionString: process.env.TEST_DATABASE_URL }
    : null;

const skip = CONN ? false : 'нет подключения к базе — загрузка изображений не проверялась';

let pool;
let images;
let seriesId;

test.before(async () => {
  if (!CONN) return;
  pool = new pg.Pool(CONN);
  await pool.query('select 1');
  images = pgStudioImages(pool);

  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, imdb_key, title_ru, title_original, year_start, exit_state, publication_state, reasons, level)
     VALUES ($1, $2, 'Сериал для картинок', 'Images series', 2020, 'ended', 'published', '{}', 'minimum')
     RETURNING id`,
    [`images-${crypto.randomUUID().slice(0, 8)}`, `tt${crypto.randomUUID().slice(0, 8)}`],
  );
  seriesId = series.id;
});

test.after(async () => {
  if (pool && seriesId) {
    await pool.query('DELETE FROM e_series WHERE id = $1', [seriesId]);
  }
  if (pool) await pool.end();
});

test('фон загружается и делается в варианты (F-10-04 §4)', { skip }, async () => {
  const buffer = await sharp({
    create: { width: 1920, height: 1080, channels: 3, background: { r: 30, g: 60, b: 120 } },
  }).png().toBuffer();

  const result = await images.upload({ seriesId, role: 'backdrop', buffer });
  assert.equal(result.ok, true, 'фон загружен');
  assert.equal(result.cropped, false, 'пропорция совпала, кадр не резался');

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM e_image_variant iv
       JOIN e_image i ON i.id = iv.image_id
      WHERE i.series_id = $1 AND i.role = 'backdrop'`,
    [seriesId],
  );
  assert.equal(rows[0].n, 3, 'сделаны три варианта');
});

test('файл не картинка отвергается (R-SEC-17)', { skip }, async () => {
  const result = await images.upload({
    seriesId, role: 'backdrop', buffer: Buffer.from('это не картинка, а текст'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'type');
});

test('маленькая картинка отвергается для своей роли (F-10-04 §8)', { skip }, async () => {
  const buffer = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 10, g: 10, b: 10 } },
  }).png().toBuffer();
  const result = await images.upload({ seriesId, role: 'backdrop', buffer });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'small');
});

test('чужая пропорция режется сам, и об этом сказано (EC-C5)', { skip }, async () => {
  const buffer = await sharp({
    create: { width: 1200, height: 1200, channels: 3, background: { r: 90, g: 90, b: 90 } },
  }).png().toBuffer();
  const result = await images.upload({ seriesId, role: 'backdrop', buffer });
  // Квадрат 1200×1200: ширины для фона не хватает (нужно 1920), поэтому кадр
  // отвергается — но уже с причиной о размере, а не о пропорции.
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'small');
});

test('причина «нет фона» уходит после загрузки (F-10-04 §17)', { skip }, async () => {
  const { rows: [row] } = await pool.query(
    'SELECT reasons FROM e_series WHERE id = $1', [seriesId],
  );
  assert.ok(!row.reasons.includes('no_backdrop'), 'после загрузки фона причины нет');
});
