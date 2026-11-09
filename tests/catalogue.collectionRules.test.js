// Подборки по правилам (OP-18, F-02-05 §3).
//
// Проверяется главное: правило действительно отбирает сериалы, несколько
// правил складываются по «И», старые позиции заменяются целиком, а неполное
// или неподдерживаемое правило не стирает подборку. Последнее — самая
// дорогая ошибка: молча опустевшая подборка выглядит как «правило ничего не
// нашло», и восстановить её ручной труд уже нельзя.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

import { pgCollectionRules, RULE_LIMIT } from '../src/services/catalogue/collectionRules.js';
import { pgCollections } from '../src/services/catalogue/collection.js';

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

const skip = CONN ? false : 'нет подключения к базе — правила подборок не проверялись';

const PREFIX = `check-op18-${crypto.randomUUID().slice(0, 8)}`;
const GENRE = `${PREFIX}-genre`;
const SMALL_GENRE = `${PREFIX}-small`;
const LIMIT_GENRE = `${PREFIX}-limit`;

const MAIN_SLUG = `${PREFIX}-main`;
const PLAIN_SLUG = `${PREFIX}-plain`;
const MANUAL_SLUG = `${PREFIX}-manual`;
const SMALL_SLUG = `${PREFIX}-small`;
const LIMIT_SLUG = `${PREFIX}-limit`;

/** @type {pg.Pool} */
let pool;
/** @type {any} */
let rules;
/** @type {any} */
let collections;

/** @type {Record<string, number>} */
const ids = {};
let tmdbSeed = 970_000_000;

/**
 * Сериал для проверки.
 *
 * @param {object} options
 * @param {string} options.key
 * @param {string|null} [options.genre]
 * @param {number} [options.year]
 * @param {number|null} [options.rating]
 * @param {number|null} [options.votes]
 * @param {string} [options.state]
 * @param {boolean} [options.archived]
 * @returns {Promise<number>}
 */
async function makeSeries({
  key, genre = null, year = 1801, rating = null, votes = null,
  state = 'published', archived = false,
}) {
  tmdbSeed += 1;
  const { rows: [row] } = await pool.query(
    `INSERT INTO e_series
       (slug, title_original, year_start, tmdb_id, publication_state, archived_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      `${PREFIX}-${key}`, `OP18 ${key}`, year, tmdbSeed, state,
      archived ? new Date() : null,
    ],
  );
  if (genre) {
    await pool.query(
      'INSERT INTO e_series_genre (series_id, genre_code) VALUES ($1, $2)',
      [row.id, genre],
    );
  }
  if (rating !== null) {
    await pool.query(
      `INSERT INTO e_external_rating
         (series_id, platform, value, votes, measured_on)
       VALUES ($1, 'imdb', $2, $3, current_date)`,
      [row.id, rating, votes],
    );
  }
  return row.id;
}

/**
 * Подборка с правилами.
 *
 * @param {string} slug
 * @param {Array<{kind: string, params: any, active?: boolean}>} ruleRows
 * @returns {Promise<number>}
 */
async function makeCollection(slug, ruleRows = []) {
  const { rows: [collection] } = await pool.query(
    `INSERT INTO e_collection (slug, title_ru, description_ru, weight, active, is_demo)
     VALUES ($1, $2, 'Описание.', 1, TRUE, FALSE)
     RETURNING id`,
    [slug, `Подборка ${slug}`],
  );
  for (const rule of ruleRows) {
    await pool.query(
      `INSERT INTO e_collection_rule (collection_id, kind, params, active)
       VALUES ($1, $2, $3, $4)`,
      [collection.id, rule.kind, JSON.stringify(rule.params), rule.active ?? true],
    );
  }
  return collection.id;
}

/**
 * Позиции подборки по порядку.
 *
 * @param {string} slug
 * @returns {Promise<Array<{series_id: number, ordinal: number}>>}
 */
async function items(slug) {
  const { rows } = await pool.query(
    `SELECT ci.series_id, ci.ordinal
       FROM e_collection_item ci
       JOIN e_collection c ON c.id = ci.collection_id
      WHERE c.slug = $1
      ORDER BY ci.ordinal`,
    [slug],
  );
  return rows;
}

/**
 * Добавить сериал в подборку вручную.
 *
 * @param {string} slug
 * @param {number} seriesId
 * @param {number} ordinal
 * @returns {Promise<void>}
 */
async function addItem(slug, seriesId, ordinal) {
  await pool.query(
    `INSERT INTO e_collection_item (collection_id, series_id, ordinal)
     SELECT id, $2, $3 FROM e_collection WHERE slug = $1`,
    [slug, seriesId, ordinal],
  );
}

test.before(async () => {
  if (!CONN) return;
  pool = new pg.Pool(CONN);
  await pool.query('select 1');
  rules = pgCollectionRules(pool);
  collections = pgCollections(pool);

  for (const code of [GENRE, SMALL_GENRE, LIMIT_GENRE]) {
    await pool.query(
      `INSERT INTO e_genre (code, name_ru, name_en) VALUES ($1, 'Проверка OP-18', 'OP-18 check')`,
      [code],
    );
  }

  // A, B, C, D, H — подходят по жанру; E — тот же год, но без жанра;
  // F и G — с жанром, но невидимы: черновик и архив.
  ids.A = await makeSeries({ key: 'a', genre: GENRE, year: 1801, rating: 9.0, votes: 100 });
  ids.B = await makeSeries({ key: 'b', genre: GENRE, year: 1802, rating: 9.0, votes: 200 });
  ids.C = await makeSeries({ key: 'c', genre: GENRE, year: 1803, rating: 8.5, votes: 500 });
  ids.D = await makeSeries({ key: 'd', genre: GENRE, year: 1804 });
  ids.E = await makeSeries({ key: 'e', year: 1801, rating: 9.5, votes: 900 });
  ids.F = await makeSeries({ key: 'f', genre: GENRE, year: 1801, state: 'imported' });
  ids.G = await makeSeries({ key: 'g', genre: GENRE, year: 1801, archived: true });
  ids.H = await makeSeries({ key: 'h', genre: GENRE, year: 1810, rating: 7.0, votes: 50 });

  await makeCollection(MAIN_SLUG, [{ kind: 'by_genre', params: { genre: GENRE } }]);
  // Ручная позиция до первого пересчёта: правило обязано её заменить, а не
  // дополнить — иначе подборка с правилом со временем превращается в свалку.
  await addItem(MAIN_SLUG, ids.E, 1);

  await makeCollection(PLAIN_SLUG);
  await addItem(PLAIN_SLUG, ids.H, 1);

  // Активное правило `manual` — не фильтр: подборка остаётся ручной.
  await makeCollection(MANUAL_SLUG, [{ kind: 'manual', params: {} }]);
  await addItem(MANUAL_SLUG, ids.A, 1);

  await makeCollection(SMALL_SLUG, [{ kind: 'by_genre', params: { genre: SMALL_GENRE } }]);
  for (let i = 1; i <= 5; i += 1) {
    ids[`S${i}`] = await makeSeries({
      key: `small-${i}`, genre: SMALL_GENRE, year: 1900 + i, rating: 5 + i / 10,
    });
  }

  await makeCollection(LIMIT_SLUG, [{ kind: 'by_genre', params: { genre: LIMIT_GENRE } }]);
  await pool.query(
    `WITH inserted AS (
       INSERT INTO e_series
         (slug, title_original, year_start, tmdb_id, publication_state)
       SELECT $1 || '-limit-' || g, 'OP18 limit ' || g, 1950, $2 + g, 'published'
         FROM generate_series(1, $3::int) AS g
       RETURNING id
     )
     INSERT INTO e_series_genre (series_id, genre_code)
     SELECT id, $4 FROM inserted`,
    [PREFIX, tmdbSeed, RULE_LIMIT + 5, LIMIT_GENRE],
  );
});

test.after(async () => {
  if (pool) {
    await pool.query(
      'DELETE FROM e_collection WHERE slug = ANY($1::text[])',
      [[MAIN_SLUG, PLAIN_SLUG, MANUAL_SLUG, SMALL_SLUG, LIMIT_SLUG]],
    );
    await pool.query('DELETE FROM e_series WHERE slug LIKE $1', [`${PREFIX}-%`]);
    await pool.query(
      'DELETE FROM e_genre WHERE code = ANY($1::text[])',
      [[GENRE, SMALL_GENRE, LIMIT_GENRE]],
    );
    await pool.end();
  }
});

test('правило по жанру отбирает видимые сериалы и задаёт порядок', { skip }, async () => {
  const result = await rules.apply();
  assert.ok(result.collections >= 1, 'пересчёт затронул подборки');

  const rows = await items(MAIN_SLUG);
  assert.deepEqual(
    rows.map((row) => row.series_id),
    [ids.B, ids.A, ids.C, ids.H, ids.D],
    'рейтинг по убыванию, при равенстве — голоса, затем название; без рейтинга — в конце',
  );
  assert.deepEqual(
    rows.map((row) => row.ordinal),
    [1, 2, 3, 4, 5],
    'порядок записан явно: страница читает ordinal, а не порядок вставки',
  );
  assert.ok(!rows.some((row) => row.series_id === ids.E), 'ручная позиция заменена, а не дополнена');
  assert.ok(!rows.some((row) => row.series_id === ids.F), 'неопубликованный сериал не попал');
  assert.ok(!rows.some((row) => row.series_id === ids.G), 'архивный сериал не попал');
});

test('годы включаются в диапазон, несколько правил складываются по «И»', { skip }, async () => {
  await pool.query(
    `INSERT INTO e_collection_rule (collection_id, kind, params)
     SELECT id, 'by_year', '{"from":1801,"to":1803}'::jsonb FROM e_collection WHERE slug = $1`,
    [MAIN_SLUG],
  );
  await pool.query(
    `INSERT INTO e_collection_rule (collection_id, kind, params)
     SELECT id, 'by_rating', '{"min":8.7}'::jsonb FROM e_collection WHERE slug = $1`,
    [MAIN_SLUG],
  );

  await rules.apply();

  const rows = await items(MAIN_SLUG);
  assert.deepEqual(
    rows.map((row) => row.series_id),
    [ids.B, ids.A],
    'жанр, годы 1801–1803 и рейтинг от 8,7 выполняются одновременно; границы года включительны',
  );
  assert.deepEqual(rows.map((row) => row.ordinal), [1, 2], 'ordinal пересчитан с единицы');
});

test('невалидное или неподдерживаемое активное правило не стирает подборку', { skip }, async () => {
  const before = await items(MAIN_SLUG);

  await pool.query(
    `UPDATE e_collection_rule SET params = '{"from":"две тысячи","to":1803}'::jsonb
      WHERE collection_id = (SELECT id FROM e_collection WHERE slug = $1)
        AND kind = 'by_year'`,
    [MAIN_SLUG],
  );
  const bad = await rules.apply();
  assert.deepEqual(await items(MAIN_SLUG), before, 'битые параметры — подборка осталась как была');
  assert.ok(bad.skipped.some((row) => row.slug === MAIN_SLUG), 'пропуск назван в отчёте');

  await pool.query(
    `UPDATE e_collection_rule SET params = '{"from":1801,"to":1803}'::jsonb
      WHERE collection_id = (SELECT id FROM e_collection WHERE slug = $1)
        AND kind = 'by_year'`,
    [MAIN_SLUG],
  );
  await pool.query(
    `INSERT INTO e_collection_rule (collection_id, kind, params)
     SELECT id, 'by_platform', '{"platform":"netflix"}'::jsonb FROM e_collection WHERE slug = $1`,
    [MAIN_SLUG],
  );
  const unsupported = await rules.apply();
  assert.deepEqual(await items(MAIN_SLUG), before,
    'неподдерживаемое правило пропускает подборку целиком, а не отбрасывает условие');
  assert.ok(unsupported.skipped.some((row) => row.slug === MAIN_SLUG));
});

test('подборки без правил и с одним ручным правилом не трогаются', { skip }, async () => {
  await rules.apply();
  assert.deepEqual((await items(PLAIN_SLUG)).map((row) => row.series_id), [ids.H],
    'подборка без правил остаётся ручной');
  assert.deepEqual((await items(MANUAL_SLUG)).map((row) => row.series_id), [ids.A],
    'active = manual — не фильтр, состав не пересобирается');
});

test('меньше шести видимых — подборка остаётся в базе, но публично скрыта', { skip }, async () => {
  await rules.apply();
  const five = await items(SMALL_SLUG);
  assert.equal(five.length, 5, 'позиции записаны: порог — не повод стирать подборку');
  assert.equal(await collections.collection(SMALL_SLUG), null,
    'публичная видимость сама скрывает подборку из пяти сериалов');

  ids.S6 = await makeSeries({
    key: 'small-6', genre: SMALL_GENRE, year: 1906, rating: 5.6,
  });
  await rules.apply();

  const six = await items(SMALL_SLUG);
  assert.equal(six.length, 6);
  const visible = await collections.collection(SMALL_SLUG);
  assert.ok(visible, 'шесть видимых — подборка появилась');
  assert.equal(visible.total, 6);
});

test('правило ставит не больше ста позиций', { skip }, async () => {
  await rules.apply();
  const rows = await items(LIMIT_SLUG);
  assert.equal(rows.length, RULE_LIMIT, `лимит ${RULE_LIMIT} соблюдён`);
  assert.equal(rows[0].ordinal, 1);
  assert.equal(rows.at(-1)?.ordinal, RULE_LIMIT, 'ordinal заканчивается на лимите, а не на числе совпадений');
});
