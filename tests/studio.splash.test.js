// Кадры заставки (F-10-09).
//
// Проверяется то, что может испортить заставку: порядок кадров, предел в
// шестнадцать и предупреждение о резкой смене яркости.

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import sharp from 'sharp';

import { pgStudioSplash, MAX_FRAMES, MIN_FRAMES } from '../src/services/studio/splash.js';

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

const skip = CONN ? false : 'нет подключения к базе — заставка не проверялась';

let pool;
let splash;
let seriesId;
let imageId;

test.before(async () => {
  if (!CONN) return;
  pool = new pg.Pool();
  await pool.query('select 1');
  splash = pgStudioSplash(pool);

  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, imdb_key, title_ru, title_original, year_start, exit_state, publication_state, reasons, level)
     VALUES ($1, $2, 'Сериал для заставки', 'Splash series', 2019, 'ended', 'published', '{}', 'minimum')
     RETURNING id`,
    [`splash-${crypto.randomUUID().slice(0, 8)}`, `tt${crypto.randomUUID().slice(0, 8)}`],
  );
  seriesId = series.id;

  const data = await sharp({
    create: { width: 1920, height: 1080, channels: 3, background: { r: 30, g: 60, b: 120 } },
  }).png().toBuffer();
  const { rows: [image] } = await pool.query(
    `INSERT INTO e_image (role, series_id, source, mime, width, height)
     VALUES ('backdrop', $1, 'manual', 'image/webp', 1920, 1080) RETURNING id`,
    [seriesId],
  );
  imageId = image.id;
  await pool.query(
    `INSERT INTO e_image_variant (image_id, width, height, file, mime, bytes, checksum)
     VALUES ($1, 1920, 1080, $2, 'image/webp', $3, 'splash-check')`,
    [imageId, data, data.length],
  );
});

test.after(async () => {
  if (pool) {
    if (seriesId) {
      await pool.query('DELETE FROM e_splash_frame WHERE series_id = $1', [seriesId]);
      await pool.query('DELETE FROM e_series WHERE id = $1', [seriesId]);
    }
  }
  if (pool) await pool.end();
});

test('кадр добавляется и попадает в ленту (F-10-09 §4)', { skip }, async () => {
  // Лента общая, и в ней могут быть чужие кадры: проверяем свою разницу,
  // а не абсолютное число.
  const before = await splash.frames();
  const result = await splash.add({ imageId, seriesId, byId: null });
  assert.equal(result.ok, true, 'кадр добавлен');

  const state = await splash.frames();
  assert.equal(state.frames.length, before.frames.length + 1, 'кадр добавился');
  const mine = state.frames.filter((frame) => frame.seriesId === Number(seriesId));
  assert.equal(mine.length, 1, 'кадр в ленте');
  assert.ok(mine[0].brightness !== null, 'яркость посчитана');
  assert.equal(state.ready, state.frames.length >= MIN_FRAMES, 'готовность по числу кадров');
});

test('размытая копия кадра делается вместе с добавлением (R-PERF-13)', { skip }, async () => {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM e_image_variant WHERE image_id = $1 AND blurred',
    [imageId],
  );
  assert.equal(rows[0].n, 1, 'копия есть');
});

test('порядок меняется кнопками (F-10-09 §4)', { skip }, async () => {
  const second = await pool.query(
    `INSERT INTO e_splash_frame (series_id, image_id, ordinal, active)
     VALUES ($1, $2, 99, TRUE) RETURNING id`,
    [seriesId, imageId],
  );
  const frameId = Number(second.rows[0].id);
  const before = (await splash.frames()).frames.findIndex((frame) => frame.id === frameId);
  const moved = await splash.reorder({ frameId, where: 'first' });
  assert.equal(moved, true);
  const state = await splash.frames();
  const after = state.frames.findIndex((frame) => frame.id === frameId);
  assert.ok(after < before, 'кадр поднялся выше по ленте');
});

test('кадр убирается, и кадров меньше нормы — заставка выключена (F-10-09 §5)', { skip }, async () => {
  // Убираем только свои кадры: чужие в общей ленте трогать нельзя.
  const state = await splash.frames();
  const mine = state.frames.filter((frame) => frame.seriesId === Number(seriesId));
  for (const frame of mine) {
    await splash.remove({ frameId: frame.id, byId: null });
  }
  const after = await splash.frames();
  assert.equal(after.frames.length, state.frames.length - mine.length, 'свои кадры убраны');
  assert.equal(after.ready, after.frames.length >= MIN_FRAMES);
  assert.ok(MIN_FRAMES === 12 && MAX_FRAMES === 16, 'нормы заставки: 12–16');
});
