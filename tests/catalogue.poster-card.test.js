// Слой подробной карточки постера (F-02-07, UI-10).
//
// Проверяется на живой базе: слой собирается из нескольких таблиц, и подменять
// их заглушкой значило бы проверить пересказ правил, а не сами правила.

import test from 'node:test';
import assert from 'node:assert/strict';

import express from 'express';

import { createPool } from '../src/db/pool.js';
import { pgPosterCard } from '../src/services/catalogue/card.js';
import { posterCardView } from '../src/view/posterCard.js';
import { createPosterCardRoutes } from '../src/routes/posterCard.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — слой карточки не проверялся';

const TCONST = 'tt7770001';
const SLUG = 'test-poster-card';
const GENRE = 'test-poster-card-genre';

let pool;
let card;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  card = pgPosterCard(pool);
  await pool.query('DELETE FROM e_series WHERE slug = $1', [SLUG]);
  await pool.query('DELETE FROM e_genre WHERE code = $1', [GENRE]);
  await pool.query(
    `INSERT INTO e_genre (code, name_ru, name_en) VALUES ($1, 'Тестовый жанр', 'Test genre')`,
    [GENRE],
  );
  await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, year_start, description_ru,
                           exit_state, publication_state, level, reasons, imdb_key)
     VALUES ($1, 'Тестовый сериал', 'Test Series', 2019, 'Описание для слоя', 'airing',
             'published', 'full', '{}', $2)`,
    [SLUG, TCONST],
  );
  const { rows } = await pool.query('SELECT id FROM e_series WHERE slug = $1', [SLUG]);
  const seriesId = rows[0].id;
  await pool.query('INSERT INTO e_series_genre (series_id, genre_code) VALUES ($1, $2)', [seriesId, GENRE]);
  await pool.query(
    `INSERT INTO e_external_rating (series_id, platform, value, scale_max, votes, measured_on)
     VALUES ($1, 'imdb', 8.7, 10, 1000, CURRENT_DATE), ($1, 'tmdb', 8.2, 10, 500, CURRENT_DATE)`,
    [seriesId],
  );
  await pool.query(
    `INSERT INTO e_series_rating_stat (series_id, sum_value, votes, prior_weight, prior_mean)
     VALUES ($1, 430, 60, 10, 7.0)`,
    [seriesId],
  );
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_series WHERE slug = $1', [SLUG]);
  await pool.query('DELETE FROM e_genre WHERE code = $1', [GENRE]);
  await pool.end();
});

test('источник отдаёт жанры, рейтинги, людей и состояние выхода', { skip }, async () => {
  const data = await card.forSlug(SLUG);
  assert.ok(data, 'сериал найден');
  assert.equal(data.titleRu, 'Тестовый сериал');
  assert.equal(data.yearStart, 2019);
  assert.equal(data.exitState, 'airing');
  assert.deepEqual(data.genres.map((genre) => genre.code), [GENRE]);
  assert.equal(data.ratings.imdb.value, 8.7);
  assert.equal(data.ratings.tmdb.value, 8.2);
  assert.ok(data.ratings.site, 'рейтинг сайта посчитан');
  assert.equal(data.descriptionRu, 'Описание для слоя');
});

test('неопубликованного сериала слой не показывает', { skip }, async () => {
  const { rows } = await pool.query('SELECT id FROM e_series WHERE slug = $1', [SLUG]);
  await pool.query(
    `UPDATE e_series SET publication_state = 'imported' WHERE id = $1`, [rows[0].id],
  );
  assert.equal(await card.forSlug(SLUG), null);
  await pool.query(
    `UPDATE e_series SET publication_state = 'published' WHERE id = $1`, [rows[0].id],
  );
});

test('слой показывает данные и не пускает их в разметку как код', { skip }, async () => {
  const { rows } = await pool.query('SELECT id FROM e_series WHERE slug = $1', [SLUG]);
  await pool.query(
    `UPDATE e_series SET description_ru = '<script>alert(1)</script> Описание' WHERE id = $1`,
    [rows[0].id],
  );
  const data = await card.forSlug(SLUG);
  const markup = posterCardView({ locale: 'ru', data }).__raw;

  assert.match(markup, /Тестовый сериал/);
  assert.match(markup, /Тестовый жанр/);
  assert.match(markup, /IMDb/);
  assert.ok(!markup.includes('<script>'), 'чужой текст не стал разметкой');
  assert.match(markup, /&lt;script&gt;/);

  await pool.query(
    `UPDATE e_series SET description_ru = 'Описание для слоя' WHERE id = $1`, [rows[0].id],
  );
});

test('адрес слоя отдаёт фрагмент и весит не больше трёх килобайт', { skip }, async () => {
  const app = express();
  app.use(createPosterCardRoutes({
    card,
    sessionMw: createSessionMiddleware(pool, createMemorySessionStore()),
  }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/ru/series/${SLUG}/card`);
    assert.equal(res.status, 200);
    const markup = await res.text();
    assert.match(markup, /poster-card/);
    assert.ok(Buffer.byteLength(markup) <= 3072, `ответ ${Buffer.byteLength(markup)} байт`);

    const missing = await fetch(`${base}/ru/series/no-such-series/card`);
    assert.equal(missing.status, 404);
  } finally {
    await /** @type {Promise<void>} */ (new Promise((r) => server.close(r)));
  }
});
