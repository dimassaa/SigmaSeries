// Порог голосов внешнего рейтинга (M2 §0, `external_rating.min_votes_display`).
//
// Проверяется на подставных строках, потому что в живом каталоге такого случая
// нет: у всех 987 сериалов с рейтингом IMDb минимум 34 тысячи голосов, и порог
// в 10 на них не срабатывает никогда. Чтобы правило было проверено, а не
// «случайно прошло», строки заводятся здесь и убираются за собой.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgCatalogueList } from '../src/services/catalogue/list.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { DEFAULT_RATING_FLOOR } from '../src/services/catalogue/settings.js';
import { acquireImportLock } from './helpers/import-lock.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — порог рейтинга не проверялся';

const THIN = 'tt7780001';
const SOLID = 'tt7780002';

let pool;
let catalogue;
let series;
let unlockImport;
let savedFloor = null;

/** Порог голосов на время проверки. */
async function setFloor(value) {
  await pool.query(
    `INSERT INTO e_system_setting (key, value) VALUES ('external_rating.min_votes_display', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(value)],
  );
}

/** Сериал с заданным рейтингом IMDb: голоса задаются напрямую. */
async function makeSeries(imdbKey, slug, votes, value) {
  const { rows } = await pool.query(
    `INSERT INTO e_series (slug, title_original, imdb_key, year_start, exit_state,
                           publication_state, level, reasons)
     VALUES ($1, $2, $3, 2019, 'waiting', 'published', 'full', '{}')
     RETURNING id`,
    [slug, slug, imdbKey],
  );
  await pool.query(
    `INSERT INTO e_external_rating (series_id, platform, value, votes, measured_on)
     VALUES ($1, 'imdb', $2, $3, CURRENT_DATE)`,
    [rows[0].id, value, votes],
  );
  return rows[0].id;
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  // Настройки и справочники читаются всеми проверками каталога: без блокировки
  // соседний файл мог бы подменить порог под ногами.
  unlockImport = await acquireImportLock(pool);
  catalogue = pgCatalogueList(pool);
  series = pgSeries(pool);

  const { rows } = await pool.query(
    "SELECT value FROM e_system_setting WHERE key = 'external_rating.min_votes_display'",
  );
  savedFloor = rows[0]?.value ?? null;
  // Порог на время проверки равен документированному: правило проверяется
  // само, а не значение, оставшееся в базе от чужой настройки.
  await setFloor(DEFAULT_RATING_FLOOR);

  await pool.query('DELETE FROM e_series WHERE imdb_key = ANY($1::text[])', [[THIN, SOLID]]);
  await makeSeries(THIN, 'test-rating-thin', 3, 9.0);
  await makeSeries(SOLID, 'test-rating-solid', 50_000, 8.2);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_series WHERE imdb_key = ANY($1::text[])', [[THIN, SOLID]]);
  if (savedFloor === null) {
    await pool.query("DELETE FROM e_system_setting WHERE key = 'external_rating.min_votes_display'");
  } else {
    await pool.query(
      `INSERT INTO e_system_setting (key, value) VALUES ('external_rating.min_votes_display', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [savedFloor],
    );
  }
  await unlockImport?.();
  await pool.end();
});

/**
 * Выдача по конкретным сериалам, где бы они ни стояли.
 *
 * Тестовые строки с тремя и пятьюдесятью тысячами голосов в первую страницу по
 * популярности не попадают, а проверять надо именно их. Обход страниц честнее,
 * чем подгонка сортировки под букву слага: он не сломается, когда в каталог
 * добавят сериал с названием раньше.
 *
 * @param {string[]} slugs
 * @returns {Promise<any[]>} в порядке аргументов
 */
async function itemsOf(...slugs) {
  const { rows } = await pool.query(
    `SELECT s.slug FROM e_series s
      WHERE s.slug = ANY($1::text[]) AND s.publication_state = 'published'`,
    [slugs],
  );
  assert.equal(rows.length, slugs.length, `сериалы на месте: ${slugs.join(', ')}`);

  const found = [];
  for (let page = 1; found.length < slugs.length && page <= 20; page += 1) {
    const chunk = await catalogue.list({ sort: 'title', page });
    for (const item of chunk.items) {
      if (slugs.includes(item.slug)) found.push(item);
    }
    if (!chunk.items.length) break;
  }
  assert.equal(found.length, slugs.length, 'сериалы нашлись в выдаче');
  return slugs.map((slug) => found.find((item) => item.slug === slug));
}

test('рейтинг с малым числом голосов не показывается в выдаче', { skip }, async () => {
  const [solid, thin] = await itemsOf('test-rating-solid', 'test-rating-thin');

  assert.ok(solid, 'сериал с достаточным числом голосов в выдаче');
  assert.equal(solid.rating, 8.2);
  assert.ok(thin === undefined || thin.rating === null,
    '«9,0» от трёх человек не показывается как рейтинг');
});

test('сортировка по рейтингу не выносит скрытые оценки в начало', { skip }, async () => {
  const page = await catalogue.list({ sort: 'rating' });
  const top = page.items.filter((item) => item.rating !== null)[0];

  assert.ok(top, 'в выдаче есть что сортировать');
  assert.ok(top.slug !== 'test-rating-thin', `первым оказался «9,0 от трёх человек»: ${top.slug}`);
});

test('фильтр «рейтинг от» отсекает оценки без голосов', { skip }, async () => {
  const page = await catalogue.list({ ratingFrom: 8 });

  assert.ok(page.total > 0, 'фильтр что-то находит — иначе проверка бессмысленна');
  assert.ok(page.items.every((item) => item.slug !== 'test-rating-thin'),
    'оценка без голосов не проходит фильтр «от 8»');
});

test('на странице сериала тот же порог', { skip }, async () => {
  const thin = await series.bySlug('test-rating-thin');
  const solid = await series.bySlug('test-rating-solid');

  assert.equal(thin.ratings.imdb, null, 'карточка и каталог показывают одно и то же число');
  assert.equal(solid.ratings.imdb.value, 8.2);
});

test('порог берётся из настройки, а не из кода', { skip }, async () => {
  const [before] = await itemsOf('test-rating-solid');
  assert.equal(before.rating, 8.2, 'при пороге 10 рейтинг показывается');

  await setFloor(1_000_000);
  const [after] = await itemsOf('test-rating-solid');
  assert.equal(after.rating, null,
    'число из настройки подняло порог выше 50 тысяч — рейтинг скрылся');

  assert.equal(DEFAULT_RATING_FLOOR, 10, 'стартовое число из M2 §0');
});