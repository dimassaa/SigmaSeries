// Дозагрузка стран и сетей (F-12-03 §4(4)).
//
// Проверяется на живой базе с подставным TMDB: суть команды — «обойти то, чего
// нет, и не тронуть остальное», и оба свойства видны только по строкам.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { writeSeries, loadSlugs } from '../src/services/import/write.js';
import { buildRawSeries } from '../src/services/import/enrich.js';
import { fillOrigins, parseArgs } from '../src/services/import/origins.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — дозагрузка не проверялась';

const TMDB_ID = 999_401;
const TCONST = 'tt7770401';

let pool;

function raw(over = {}) {
  return buildRawSeries({
    detailsRu: {
      id: TMDB_ID,
      name: 'Без страны',
      original_name: 'No Origin',
      overview: 'Описание.',
      status: 'Returning Series',
      first_air_date: '2022-03-01',
      genres: [{ id: 18, name: 'Drama' }],
      origin_country: [],
      networks: [],
      seasons: [{ season_number: 1 }],
      ...over,
    },
    detailsEn: { name: 'No Origin' },
    seasons: [],
    imdb: { tconst: TCONST, startYear: 2022, genres: ['Drama'], numVotes: null, averageRating: null },
  });
}

async function cleanup() {
  const { rows } = await pool.query('SELECT id FROM e_series WHERE imdb_key = $1', [TCONST]);
  for (const row of rows) {
    await pool.query('DELETE FROM e_image WHERE series_id = $1', [row.id]);
    await pool.query('DELETE FROM e_season WHERE series_id = $1', [row.id]);
  }
  await pool.query('DELETE FROM e_series WHERE imdb_key = $1', [TCONST]);
}

/** Подставной TMDB: одна карточка на идентификатор. */
function fakeTmdb(cards) {
  const asked = [];
  return {
    asked,
    async getDetailsLocalized(id) {
      asked.push(id);
      const card = cards[id];
      if (!card) throw Object.assign(new Error('404'), { code: 404 });
      return card;
    },
  };
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

test('дозагрузка берёт только недостающие сериалы', { skip }, async () => {
  const written = await writeSeries({ pool, raw: raw(), slugs: await loadSlugs(pool) });
  const tmdb = fakeTmdb({
    [TMDB_ID]: {
      id: TMDB_ID,
      origin_country: ['IT'],
      networks: [{ id: 55, name: 'Sky Atlantic', origin_country: 'GB' }],
    },
  });

  const result = await fillOrigins({ pool, tmdb, limit: 1, tconst: TCONST });

  assert.equal(result.scanned, 1, 'обходится только то, чего не хватает');
  assert.ok(result.filled >= 1);
  assert.deepEqual(tmdb.asked, [TMDB_ID]);

  const { rows } = await pool.query(
    `SELECT c.code FROM e_series_country sc JOIN e_country c ON c.code = sc.country_code
      WHERE sc.series_id = $1`, [written.seriesId],
  );
  assert.deepEqual(rows.map((row) => row.code), ['IT']);

  const networks = await pool.query(
    `SELECT n.name FROM e_series_network sn JOIN e_network n ON n.id = sn.network_id
      WHERE sn.series_id = $1`, [written.seriesId],
  );
  assert.deepEqual(networks.rows.map((row) => row.name), ['Sky Atlantic']);
});

test('сбой одной карточки не обрывает обход', { skip }, async () => {
  // Сериал без страны: иначе обход его и не тронет — он уже посчитанным.
  await writeSeries({ pool, raw: raw(), slugs: await loadSlugs(pool) });
  const tmdb = fakeTmdb({});   // любая карточка отвечает 404

  const result = await fillOrigins({ pool, tmdb, limit: 5, tconst: TCONST });

  assert.equal(result.errors, result.scanned);
  assert.equal(result.filled, 0, 'не записано ни одной пустой строки');
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM e_series_country WHERE series_id IN (SELECT id FROM e_series WHERE imdb_key = $1)',
    [TCONST],
  );
  assert.equal(rows[0].n, 0);
});

test('сериал без страны у источника считается, а не прячется', { skip }, async () => {
  await writeSeries({ pool, raw: raw(), slugs: await loadSlugs(pool) });
  const tmdb = fakeTmdb({ [TMDB_ID]: { id: TMDB_ID, origin_country: [], networks: [] } });

  const result = await fillOrigins({ pool, tmdb, limit: 1, tconst: TCONST });

  assert.equal(result.withoutCountry, 1,
    '«у источника нет страны» — это факт, а не повод не показывать счётчик');
});

test('ключ, отвергнутый TMDB, останавливает обход', { skip }, async () => {
  await writeSeries({ pool, raw: raw(), slugs: await loadSlugs(pool) });
  const lines = [];
  const tmdb = {
    async getDetailsLocalized() {
      throw Object.assign(new Error('401 Unauthorized'), { code: 401 });
    },
  };

  const result = await fillOrigins({ pool, tmdb, limit: 5, tconst: TCONST, log: (line) => lines.push(line) });

  assert.equal(result.filled, 0);
  assert.equal(result.scanned, 1, 'после отказа ключа дальше не идём: остальные попытки бесполезны');
  assert.ok(lines.some((line) => line.includes('ключ TMDB отвергнут')), 'причина в журнале');
});

test('аргументы разбираются, а мусор не превращается в «все сериалы»', { skip }, () => {
  assert.equal(parseArgs(['--limit', '50']).limit, 50);
  assert.equal(parseArgs(['--all']).limit, Infinity);
  assert.equal(parseArgs(['--tconst', 'tt1234567']).tconst, 'tt1234567');
  assert.throws(() => parseArgs(['--limit', '0']), /--limit/);
  assert.throws(() => parseArgs(['--limit', 'много']), /--limit/);
  assert.throws(() => parseArgs(['--tconst', 'сериал']), /--tconst/);
});