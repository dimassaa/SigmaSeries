// Страны и каналы сериала: от карточки TMDB до строк в базе (F-12-03 §4(4),
// F-02-03: фильтры «страна» и «канал или платформа»).
//
// Источник — `origin_country` и `networks` карточки TMDB. Названия стран
// берутся из `Intl.DisplayNames`, а не из списка в коде: переводы вручную
// разошлись бы с базой ICU при первом же обновлении Node.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { buildRawSeries } from '../src/services/import/enrich.js';
import { writeSeries, writeOriginsForSeries, loadSlugs } from '../src/services/import/write.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — страны и каналы не проверялись';

const TMDB_ID = 999_301;
const TCONST = 'tt7770301';

let pool;

/** Карточка TMDB: минимум, в котором есть страны и сети. */
function details(over = {}) {
  return {
    id: TMDB_ID,
    name: 'Страны и сети',
    original_name: 'Origins',
    overview: 'Описание.',
    status: 'Returning Series',
    first_air_date: '2021-01-10',
    genres: [{ id: 18, name: 'Drama' }],
    origin_country: ['US', 'GB'],
    networks: [
      { id: 174, name: 'AMC', origin_country: 'US' },
      { id: 213, name: 'HBO', origin_country: 'US' },
    ],
    production_companies: [{ id: 11073, name: 'Sony Pictures Television' }],
    seasons: [{ season_number: 1 }],
    ...over,
  };
}

const raw = (over = {}) => buildRawSeries({
  detailsRu: details(over),
  detailsEn: details({ name: 'Origins' }),
  seasons: [],
  imdb: { tconst: TCONST, startYear: 2021, genres: ['Drama'], numVotes: null, averageRating: null },
});

async function write(over) {
  return writeSeries({ pool, raw: raw(over), slugs: await loadSlugs(pool) });
}

async function cleanup() {
  const { rows } = await pool.query('SELECT id FROM e_series WHERE imdb_key = $1', [TCONST]);
  for (const row of rows) {
    await pool.query('DELETE FROM e_image WHERE series_id = $1', [row.id]);
    await pool.query('DELETE FROM e_season WHERE series_id = $1', [row.id]);
  }
  await pool.query('DELETE FROM e_series WHERE imdb_key = $1', [TCONST]);
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  await cleanup();
});

test.after(async () => {
  if (!pool) return;
  await cleanup();
  await pool.end();
});

test('страны берутся из origin_country, а не из года или языка', { skip }, () => {
  const built = raw();
  assert.deepEqual(built.countries, ['US', 'GB'], 'только страны производства, по порядку источника');
});

test('сети берутся из networks, а производственные компании — нет', { skip }, () => {
  const built = raw();
  assert.deepEqual(built.networks, [
    { id: 174, name: 'AMC', countryCode: 'US' },
    { id: 213, name: 'HBO', countryCode: 'US' },
  ]);
  assert.ok(
    !JSON.stringify(built.networks).includes('Sony'),
    'производственная компания — это студия (M10), а не канал',
  );
});

test('страны и сети записываются и перечитываются', { skip }, async () => {
  const written = await write();
  const { rows } = await pool.query(
    `SELECT c.code, c.name_ru, c.name_en
       FROM e_series_country sc JOIN e_country c ON c.code = sc.country_code
      WHERE sc.series_id = $1 ORDER BY c.code`,
    [written.seriesId],
  );
  assert.deepEqual(rows.map((row) => row.code), ['GB', 'US']);
  // Название — то, что отдаёт ICU для русского: «Соединенные Штаты» без «ё».
  // Своя строка с «ё» разошлась бы с этим через обновление Node.
  assert.equal(rows.find((row) => row.code === 'US').name_ru,
    new Intl.DisplayNames(['ru'], { type: 'region' }).of('US'),
    'русское название страны приходит из ICU, а не из списка в коде');
  assert.equal(rows.find((row) => row.code === 'US').name_en, 'United States');

  const networks = await pool.query(
    `SELECT n.id, n.name, n.country_code
       FROM e_series_network sn JOIN e_network n ON n.id = sn.network_id
      WHERE sn.series_id = $1 ORDER BY n.id`,
    [written.seriesId],
  );
  assert.deepEqual(networks.rows, [
    { id: 174, name: 'AMC', country_code: 'US' },
    { id: 213, name: 'HBO', country_code: 'US' },
  ]);
});

test('повторная запись не оставляет прежних строк', { skip }, async () => {
  const first = await write();
  const second = await write({ origin_country: ['DE'], networks: [{ id: 213, name: 'HBO', origin_country: 'US' }] });

  assert.equal(second.seriesId, first.seriesId);
  const countries = await pool.query(
    'SELECT country_code FROM e_series_country WHERE series_id = $1', [first.seriesId],
  );
  assert.deepEqual(countries.rows.map((row) => row.country_code), ['DE'],
    'сериал переехал в другую страну — старая строка должна исчезнуть');

  const networks = await pool.query(
    'SELECT network_id FROM e_series_network WHERE series_id = $1', [first.seriesId],
  );
  assert.deepEqual(networks.rows.map((row) => row.network_id), [213]);
});

test('карточка без стран и сетей не оставляет пустых строк', { skip }, async () => {
  const written = await write({ origin_country: [], networks: [] });
  const countries = await pool.query(
    'SELECT count(*)::int AS n FROM e_series_country WHERE series_id = $1', [written.seriesId],
  );
  const networks = await pool.query(
    'SELECT count(*)::int AS n FROM e_series_network WHERE series_id = $1', [written.seriesId],
  );
  assert.equal(countries[0]?.n ?? countries.rows[0].n, 0);
  assert.equal(networks[0]?.n ?? networks.rows[0].n, 0);
});

test('дозагрузка пишет страны и сети, не трогая остальное', { skip }, async () => {
  const written = await write({ origin_country: [], networks: [] });
  const before = await pool.query(
    'SELECT title_ru, year_start, level FROM e_series WHERE id = $1', [written.seriesId],
  );

  // Поле называется `countryCode`, как в сыром слое: команда дозагрузки сама
  // переносит `origin_country` из карточки TMDB в форму сырого слоя.
  await writeOriginsForSeries({
    pool,
    seriesId: written.seriesId,
    countries: ['FR'],
    networks: [{ id: 213, name: 'HBO', countryCode: 'US' }],
  });

  const after = await pool.query(
    'SELECT title_ru, year_start, level FROM e_series WHERE id = $1', [written.seriesId],
  );
  assert.deepEqual(after.rows[0], before.rows[0], 'название, год и уровень не изменились');

  const countries = await pool.query(
    `SELECT c.code FROM e_series_country sc JOIN e_country c ON c.code = sc.country_code
      WHERE sc.series_id = $1`, [written.seriesId],
  );
  assert.deepEqual(countries.rows.map((row) => row.code), ['FR']);

  const networks = await pool.query(
    `SELECT n.id, n.country_code FROM e_series_network sn JOIN e_network n ON n.id = sn.network_id
      WHERE sn.series_id = $1`, [written.seriesId],
  );
  assert.deepEqual(networks.rows, [{ id: 213, country_code: 'US' }],
    'страна сети доезжает из карточки, даже если страны сериала другой');
});