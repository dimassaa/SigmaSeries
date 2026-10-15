// Еженедельное обновление рейтингов (F-12-07 §4).
//
// Проверяется на живом файле датасета и живой базе: разбор потока — это ровно то
// место, где ошибка не видна на подставных данных. Заголовок, десятичная оценка
// и строка без пары в каталоге — каждый из этих случаев тихо испортил бы числа
// на карточках.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';

import { createPool } from '../src/db/pool.js';
import { refreshRatings } from '../src/services/import/ratings.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — обновление рейтингов не проверялось';

const FILE = '/tmp/opencode/ratings-fixture.tsv.gz';
const IN_CATALOGUE = 'tt8880001';
const NO_RATING_ROW = 'tt8880002';
const NOT_IN_CATALOGUE = 'tt8880003';

let pool;

/** Файл датасета: заголовок и строки, как их отдаёт IMDb. */
function writeDataset(rows) {
  const text = ['tconst\taverageRating\tnumVotes', ...rows].join('\n') + '\n';
  fs.writeFileSync(FILE, zlib.gzipSync(Buffer.from(text)));
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  await pool.query(
    `INSERT INTO e_series (slug, title_original, imdb_key, year_start, level, reasons)
     VALUES
       ('test-ratings-a', 'Ratings A', $1, 2010, 'full', '{}'),
       ('test-ratings-b', 'Ratings B', $2, 2015, 'full', '{}')
     ON CONFLICT (slug) DO NOTHING`,
    [IN_CATALOGUE, NO_RATING_ROW],
  );
  // Первый сериал уже имеет рейтинг — его числа обязаны перезаписаться.
  await pool.query(
    `INSERT INTO e_external_rating (series_id, platform, value, votes, measured_on)
     SELECT id, 'imdb', 1.0, 10, '2020-01-01' FROM e_series WHERE imdb_key = $1
     ON CONFLICT (series_id, platform) DO UPDATE SET value = 1.0, votes = 10, measured_on = '2020-01-01'`,
    [IN_CATALOGUE],
  );
});

test.after(async () => {
  if (!pool) return;
  await pool.query(
    'DELETE FROM e_series WHERE imdb_key = ANY($1)',
    [[IN_CATALOGUE, NO_RATING_ROW]],
  );
  await pool.end();
});

test('оценка, голоса и дата замера обновляются по каталогу', { skip }, async () => {
  writeDataset([
    `${IN_CATALOGUE}\t8.6\t900`,
    `${NO_RATING_ROW}\t7.4\t500`,
    `${NOT_IN_CATALOGUE}\t9.9\t1000000`,
  ]);

  const result = await refreshRatings({ pool, path: FILE, now: new Date('2026-10-19T12:00:00Z') });

  // Каталог живой: замер идёт по всей базе, а не по одним тестовым строкам,
  // поэтому «сколько нашли» проверяется по каталогу целиком, а «что записали» —
  // по своим двум ключам ниже.
  assert.ok(result.inCatalogue >= 2, 'в каталог попадают все сериалы с ключом IMDb');
  assert.equal(result.matched, 2, 'обе позиции каталога нашлись в датасете');

  const { rows } = await pool.query(
    `SELECT s.imdb_key, r.value::text AS value, r.votes, r.measured_on::text AS measured
       FROM e_external_rating r
       JOIN e_series s ON s.id = r.series_id
      WHERE r.platform = 'imdb' AND s.imdb_key = ANY($1)
      ORDER BY s.imdb_key`,
    [[IN_CATALOGUE, NO_RATING_ROW]],
  );
  assert.deepEqual(rows, [
    { imdb_key: IN_CATALOGUE, value: '8.6', votes: 900, measured: '2026-10-19' },
    { imdb_key: NO_RATING_ROW, value: '7.4', votes: 500, measured: '2026-10-19' },
  ]);
});

test('позиция без пары в каталоге ничего не создаёт', { skip }, async () => {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM e_series WHERE imdb_key = $1', [NOT_IN_CATALOGUE],
  );
  assert.equal(rows[0].n, 0, 'рейтинги не заводят сериалы — это дело отбора');
});

test('оценка сериала с одной оценкой остаётся строкой, а не числом', { skip }, async () => {
  // `NUMERIC(3,1)` отдаёт '8.6'; приведение к числу с плавающей точкой дало бы
  // 8.6, но на 7.0 — «7», и карточка показала бы оценку без десятой доли.
  const { rows } = await pool.query(
    `SELECT r.value::text AS value FROM e_external_rating r
       JOIN e_series s ON s.id = r.series_id
      WHERE s.imdb_key = $1 AND r.platform = 'imdb'`,
    [IN_CATALOGUE],
  );
  assert.match(rows[0].value, /^\d+\.\d$/, 'ровно одна цифра после точки');
});

test('изменившаяся схема датасета — громкая ошибка, а не тихий пропуск', { skip }, async () => {
  // Молча пропущенный файл выглядел бы как «рейтинги не изменились», и числа
  // на карточках остались бы прошлогодними до следующей недели.
  const text = 'tconst\taverageRating\tvotes\n' + `${IN_CATALOGUE}\t8.6\t900\n`;
  fs.writeFileSync(FILE, zlib.gzipSync(Buffer.from(text)));

  await assert.rejects(
    () => refreshRatings({ pool, path: FILE, now: new Date('2026-10-19T12:00:00Z') }),
    /схема изменилась/,
  );
});
