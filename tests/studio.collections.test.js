// Подборки студии и справочники (F-10-07, F-10-10).
//
// Проверяется то, что легко сломать: порядок сериалов, порог публикации и
// запрет менять шкалу платформы, у которой уже есть оценки.

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { pgStudioCollections, MIN_VISIBLE_SERIES } from '../src/services/studio/collections.js';
import { pgStudioDictionaries } from '../src/services/studio/dictionaries.js';

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

const skip = CONN ? false : 'нет подключения к базе — подборки не проверялись';

let pool;
let collections;
let dictionaries;
let slug;

test.before(async () => {
  if (!CONN) return;
  pool = new pg.Pool(CONN);
  await pool.query('select 1');
  collections = pgStudioCollections(pool);
  dictionaries = pgStudioDictionaries(pool);
  slug = `check-collection-${crypto.randomUUID().slice(0, 8)}`;
});

test.after(async () => {
  if (pool && slug) {
    await pool.query(
      `DELETE FROM e_collection_item WHERE collection_id = (SELECT id FROM e_collection WHERE slug = $1)`,
      [slug],
    );
    await pool.query('DELETE FROM e_collection WHERE slug = $1', [slug]);
  }
  if (pool) await pool.end();
});

test('подборка создаётся и видна в списке (F-10-07 §4)', { skip }, async () => {
  const saved = await collections.save({
    slug,
    title: 'Подборка для проверки',
    description: 'Описание подборки.',
    weight: 5,
    active: true,
    seriesIds: [],
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.slug, slug);

  const list = await collections.list();
  const found = list.find((item) => item.slug === slug);
  assert.ok(found, 'подборка в списке');
  assert.equal(found.weight, 5);
});

test('пустой подборке публиковаться нельзя (F-10-07 §5)', { skip }, async () => {
  const one = await collections.one(slug);
  assert.deepEqual(one.publishBlockers, ['few_series'],
    'при меньше шести видимых сериалов публикация закрыта');
});

test('порог публикации — шесть видимых сериалов', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT id FROM e_series
      WHERE publication_state = 'published' AND archived_at IS NULL
      ORDER BY id LIMIT $1`,
    [MIN_VISIBLE_SERIES],
  );
  const saved = await collections.save({
    slug, title: 'Подборка для проверки', weight: 5, active: true,
    seriesIds: rows.map((row) => row.id),
  });
  assert.equal(saved.ok, true);
  const one = await collections.one(slug);
  assert.equal(one.visibleSeries, MIN_VISIBLE_SERIES);
  assert.deepEqual(one.publishBlockers, [], 'при шести сериалах публикация открыта');
});

test('порядок меняется кнопками так же, как перетаскиванием (F-10-07 §18)', { skip }, async () => {
  const one = await collections.one(slug);
  const ids = one.items.map((item) => item.seriesId);
  const moved = await collections.reorder({
    collectionId: one.id, seriesId: ids[2], where: 'first',
  });
  assert.equal(moved, true, 'перестановка выполнена');
  const after = await collections.one(slug);
  assert.equal(after.items[0].seriesId, ids[2], 'сериал встал в начало');
});

test('вес подборки — целое от 0 до 999 (F-10-07 §9)', { skip }, async () => {
  const bad = await collections.save({ slug, title: 'Название', weight: 1000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'weight');
});

test('справочник жанров читается и правится (F-10-10 §4)', { skip }, async () => {
  const genres = await dictionaries.genres();
  assert.ok(genres.length > 0, 'жанры есть');
  const raw = genres.find((genre) => genre.raw);
  assert.ok(raw, 'сырые жанры импорта помечены');

  const saved = await dictionaries.saveGenre({
    code: 'check-genre', nameRu: 'Жанр для проверки', nameEn: 'Check genre', active: true,
  });
  assert.equal(saved.ok, true);
  const after = await dictionaries.genres();
  assert.ok(after.some((genre) => genre.code === 'check-genre'));

  await pool.query('DELETE FROM e_genre WHERE code = $1', ['check-genre']);
});

test('шкалу платформы с оценками менять нельзя (F-10-10 §8)', { skip }, async () => {
  const platforms = await dictionaries.platforms();
  const imdb = platforms.find((platform) => platform.code === 'imdb');
  assert.ok(imdb, 'платформа IMDb есть');
  if (!imdb.ratings) return;

  const result = await dictionaries.savePlatform({
    code: 'imdb', name: imdb.name, scaleMax: 100, priority: imdb.priority, active: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'scale_in_use', 'шкала защищена');
});
