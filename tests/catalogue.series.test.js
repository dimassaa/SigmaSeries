// Страница сериала против настоящей базы (F-02-01).
//
// Источник проверяется на живых данных намеренно: после импорта в базе 991
// сериал, и запрос, который работает на фикстуре из трёх строк, может развалиться
// на сезонах и выходах. Пропускается, если PG* не заданы.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { DEFAULT_RATING_FLOOR } from '../src/services/catalogue/settings.js';
import { acquireImportLock } from './helpers/import-lock.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE или TEST_DATABASE_URL — страница не проверялась';

let pool;
let series;
let unlockImport;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  // Замок импорта: соседняя проверка порога (`catalogue.rating-floor`) на своём
  // прогоне поднимает `external_rating.min_votes_display` до миллиона и заводит
  // опубликованные фикстуры — без замка этот файл видит и то, и другое (№167).
  unlockImport = await acquireImportLock(pool);
  series = pgSeries(pool);
});

test.after(async () => {
  if (!pool) return;
  await unlockImport?.();
  await pool.end();
});

/** Первый опубликованный сериал каталога. */
async function anySeries() {
  const { rows } = await pool.query(
    "SELECT slug FROM e_series WHERE publication_state = 'published' AND archived_at IS NULL AND year_start IS NOT NULL ORDER BY year_start DESC LIMIT 1",
  );
  return rows[0]?.slug;
}

test('неизвестный адрес — это null, а не пустая страница', { skip }, async () => {
  assert.equal(await series.bySlug('такого-сериала-нет'), null);
});

test('опубликованный сериал читается целиком', { skip }, async () => {
  const slug = await anySeries();
  assert.ok(slug, 'в каталоге должен быть хоть один опубликованный сериал');
  const found = await series.bySlug(slug);

  assert.equal(found.slug, slug);
  assert.ok(found.title, 'название обязательно: без него шапка пустая');
  assert.ok(found.yearStart, 'год обязателен для публикации');
  assert.ok(found.exitState);
  assert.equal(found.archived, false);
});

test('жанры приходят с русскими названиями', { skip }, async () => {
  const found = await series.bySlug(await anySeries());
  assert.ok(found.genres.length > 0, 'без жанров сериал не публикуется (EC-K2)');
  assert.ok(found.genres.every((genre) => genre.name_ru), 'название без перевода в фильтр не годится');
});

test('рейтинги площадок приходят числами', { skip }, async () => {
  // Сериал выбирается по показываемому рейтингу, а не по «есть строка в
  // e_external_rating»: карточка скрывает рейтинг с голосами ниже порога, и
  // выборка обязана спрашивать то же условие, что и показ (№167) — иначе
  // проверка краснеет на горстке голосов у чужой фикстуры.
  const { rows: setting } = await pool.query(
    "SELECT value FROM e_system_setting WHERE key = 'external_rating.min_votes_display'",
  );
  const floor = setting[0] ? Number(setting[0].value) : DEFAULT_RATING_FLOOR;
  const { rows } = await pool.query(
    `SELECT s.slug FROM e_series s
      WHERE s.publication_state = 'published'
        AND EXISTS (SELECT 1 FROM e_external_rating r
                     WHERE r.series_id = s.id AND (r.votes IS NULL OR r.votes >= $1))
      LIMIT 1`,
    [floor],
  );
  if (!rows.length) return; // каталог без показываемых рейтингов — не дефект источника
  const found = await series.bySlug(rows[0].slug);
  assert.ok(found.ratings.imdb || found.ratings.tmdb);
  const value = (found.ratings.imdb ?? found.ratings.tmdb).value;
  assert.equal(typeof value, 'number', 'значение приходит числом, а не строкой');
});

test('серии отдаются с датами, спецвыпуски не попадают', { skip }, async () => {
  const found = await series.bySlug(await anySeries());
  if (!found.seasons.length) return;
  assert.ok(found.seasons.every((season) => season.number > 0), 'сезон 0 скрыт по умолчанию (H-38)');
  const episodes = found.seasons.flatMap((season) => season.episodes);
  assert.ok(episodes.length > 0);
  const withDate = episodes.filter((episode) => episode.date);
  assert.ok(withDate.length > 0, 'у импортированных сериалов даты есть');
  assert.ok(
    withDate.every((episode) => /^\d{4}-\d{2}-\d{2}$/.test(episode.date)),
    'дата приходит строкой YYYY-MM-DD, а не объектом Date',
  );
});

test('неопубликованный сериал для посетителя не существует', { skip }, async () => {
  const { rows } = await pool.query(
    "SELECT slug FROM e_series WHERE publication_state = 'imported' LIMIT 1",
  );
  if (!rows.length) return;
  assert.equal(await series.bySlug(rows[0].slug), null, 'иначе адрес утечёт до правки редактора');
});

test('архивный сериал читается, но помечен — страница ответит 410', { skip }, async () => {
  const found = await series.bySlug(await anySeries());
  await pool.query('UPDATE e_series SET archived_at = now() WHERE id = $1', [found.id]);
  try {
    const archived = await series.bySlug(found.slug);
    assert.equal(archived.archived, true, 'EC-C1: о снятом с публикации сообщаем, а не молчим');
  } finally {
    await pool.query('UPDATE e_series SET archived_at = NULL WHERE id = $1', [found.id]);
  }
});

test('ближайший выход не из прошлого', { skip }, async () => {
  const found = await series.bySlug(await anySeries());
  if (!found.nextRelease) return;
  assert.ok(found.nextRelease.date >= new Date().toISOString().slice(0, 10));
});