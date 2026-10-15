// Ночная цепочка новинок: обзор → обогащение → запись в каталог (F-12-07 §4,
// задача `discover_sync`; приёмка F-12-04 §18).
//
// Проверяется против живой базы и подставного TMDB: суть задачи в том, что
// найденное доходит до каталога и до отчёта о прогоне, а «дошло ли» видно
// только по строкам `e_series` и `e_import_item_result`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createImportStore } from '../src/services/import/store.js';
import { loadSlugs } from '../src/services/import/write.js';
import { discoverSync } from '../src/services/import/discover-sync.js';
import { acquireImportLock } from './helpers/import-lock.js';
import { EXCLUDED_GENRES_TMDB } from '../src/config/settings.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — ночная цепочка новинок не проверялась';

const TMDB_ID = 555001;
const TCONST = 'tt6660001';
const BROKEN_TMDB_ID = 555002;
const NOW = new Date('2026-10-14T04:00:00Z');

let pool;
/** Отпускается в `after`: держит общую блокировку строк запуска. */
let unlockImport;
let store;
let savedUntil = null;

/** Справочник жанров TMDB: без него исключение по жанрам молча теряет силу. */
const GENRES = [
  { id: 10759, name: 'Drama' },
  ...EXCLUDED_GENRES_TMDB.map((name, index) => ({ id: 9000 + index, name })),
];

function details(id) {
  return {
    id,
    name: 'Ночная новинка',
    original_name: 'Night Newcomer',
    overview: 'Описание на русском.',
    status: 'Returning Series',
    first_air_date: '2026-10-01',
    last_air_date: null,
    genres: [{ id: 10759, name: 'Drama' }],
    content_ratings: { results: [{ iso_3166_1: 'RU', rating: '16+' }] },
    seasons: [{ season_number: 1 }],
    external_ids: { imdb_id: id === BROKEN_TMDB_ID ? null : TCONST },
    poster_path: '/p.jpg',
    backdrop_path: '/b.jpg',
    vote_average: 8.1,
    vote_count: 1200,
    next_episode_to_air: {
      season_number: 1, episode_number: 3, name: 'Третья', overview: '',
      air_date: '2026-10-19', runtime: 45,
    },
    last_episode_to_air: {
      season_number: 1, episode_number: 2, name: 'Вторая', overview: '',
      air_date: '2026-10-12', runtime: 45,
    },
    images: { backdrops: [] },
    keywords: { results: [] },
  };
}

/**
 * Подставной TMDB.
 *
 * @param {number[]} ids сериалы, которые «видны» в обзоре
 * @param {Set<number>} brokenId у каких карточка рвётся обогащение
 */
function fakeTmdb(ids, brokenId = new Set()) {
  const calls = { discover: 0, details: 0 };
  return {
    calls,
    async getTvGenres() {
      // Клиент отдаёт справочник как «имя → идентификатор», а не списком.
      return Object.fromEntries(GENRES.map((genre) => [genre.name, genre.id]));
    },
    async discoverTv(params) {
      calls.discover += 1;
      // Окно «идёт в окне» пустое, чтобы причина включения была однозначной.
      if (!params.first_air_date_gte) return [];
      return ids.map((id) => ({
        id,
        name: 'Ночная новинка',
        original_name: 'Night Newcomer',
        first_air_date: '2026-10-01',
        popularity: 100 - id,
      }));
    },
    async getDetailsLocalized(id) {
      calls.details += 1;
      if (brokenId.has(id)) throw new Error('TMDB недоступен');
      return details(id);
    },
    async getSeason(id, number) {
      return {
        season_number: number,
        name: `Сезон ${number}`,
        overview: '',
        episodes: [
          { episode_number: 1, name: 'Первая', overview: '', air_date: '2026-10-05', runtime: 45 },
          { episode_number: 2, name: 'Вторая', overview: '', air_date: '2026-10-12', runtime: 45 },
        ],
      };
    },
  };
}

/** Убирает следы теста: порядок важен — сезоны уходят раньше сериала. */
async function cleanup() {
  await pool.query('DELETE FROM e_import_item_result WHERE tconst = $1', [TCONST]);
  await pool.query('DELETE FROM e_image WHERE series_id IN (SELECT id FROM e_series WHERE imdb_key = $1)', [TCONST]);
  await pool.query('DELETE FROM e_season WHERE series_id IN (SELECT id FROM e_series WHERE imdb_key = $1)', [TCONST]);
  await pool.query('DELETE FROM e_series WHERE imdb_key = $1', [TCONST]);
}

async function setUntil(date) {
  await pool.query(
    `INSERT INTO e_system_setting (key, value) VALUES ('import.until', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [date],
  );
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  unlockImport = await acquireImportLock(pool);
  store = createImportStore(pool);
  await cleanup();
  const { rows } = await pool.query("SELECT value FROM e_system_setting WHERE key = 'import.until'");
  savedUntil = rows[0]?.value ?? null;
  // Окно задаётся явно: в живой базе админ мог передвинуть его в прошлое, и
  // проверка падала бы не из-за кода, а из-за чужого решения.
  await setUntil('2026-12-31');
});

// Окно возвращается после каждой проверки: уезжая, оно ломает все следующие.
test.afterEach(async () => {
  if (!pool) return;
  await setUntil('2026-12-31');
});

test.after(async () => {
  if (!pool) return;
  await cleanup();
  // Свои прогоны убираются: незакрытая строка `running` осталась бы висеть и
  // блокировала бы заморозку режима защиты у соседних проверок.
  await pool.query("DELETE FROM e_import_run WHERE kind = 'discover_sync'");
  if (savedUntil === null) {
    await pool.query("DELETE FROM e_system_setting WHERE key = 'import.until'");
  } else {
    await pool.query(
      `INSERT INTO e_system_setting (key, value) VALUES ('import.until', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [savedUntil],
    );
  }
  await unlockImport?.();
  await pool.end();
});

test('новинка доходит до каталога и до отчёта о прогоне', { skip }, async () => {
  const runId = await store.startRun('discover_sync');
  const tmdb = fakeTmdb([TMDB_ID]);

  const result = await discoverSync({ pool, store, tmdb, runId, slugs: await loadSlugs(pool), now: NOW });

  assert.equal(result.status, 'success');
  assert.equal(result.items, 1);
  assert.equal(tmdb.calls.discover, 2, 'два обзора: «вышло в окне» и «идёт в окне»');

  const { rows } = await pool.query(
    `SELECT imdb_key, tmdb_id, exit_state, publication_state, level, reasons
       FROM e_series WHERE imdb_key = $1`,
    [TCONST],
  );
  assert.equal(rows.length, 1, 'сериал записан');
  assert.equal(rows[0].tmdb_id, TMDB_ID);
  assert.equal(rows[0].exit_state, 'airing', 'дата выхода важнее статуса TMDB');
  assert.equal(rows[0].publication_state, 'published');
  assert.deepEqual(rows[0].reasons.includes('no_people'), true,
    'людей ночная цепочка не собирает — причина обязана остаться в карточке');

  const { rows: episodes } = await pool.query(
    `SELECT r.release_date::text AS date FROM e_release r
       JOIN e_season s ON s.id = r.season_id
       JOIN e_series ser ON ser.id = s.series_id
      WHERE ser.imdb_key = $1 ORDER BY r.release_date`,
    [TCONST],
  );
  assert.deepEqual(episodes.map((row) => row.date), ['2026-10-05', '2026-10-12'],
    'обе серии сезона попали в календарь');

  const { rows: items } = await pool.query(
    'SELECT stage, outcome, reasons FROM e_import_item_result WHERE run_id = $1',
    [runId],
  );
  assert.deepEqual(items, [{ stage: 'written', outcome: 'ok', reasons: ['new'] }],
    'причина включения видна в отчёте: сериал новый, а не «идущий»');
});

test('уже известный сериал второй раз не пишется', { skip }, async () => {
  const tmdb = fakeTmdb([TMDB_ID]);
  const second = await store.startRun('discover_sync');

  const result = await discoverSync({
    pool, store, tmdb, runId: second, slugs: await loadSlugs(pool), now: NOW,
  });

  assert.equal(result.items, 0, 'окно возвращает его снова — каталог от этого не растёт');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM e_series WHERE imdb_key = $1', [TCONST]);
  assert.equal(rows[0].n, 1);
  const { rows: items } = await pool.query(
    'SELECT count(*)::int AS n FROM e_import_item_result WHERE run_id = $1', [second],
  );
  assert.equal(items[0].n, 0, 'в отчёте пусто: добавлять было нечего');
});

test('истёкшее окно расписания останавливает выборку', { skip }, async () => {
  await setUntil('2026-01-01');
  const tmdb = fakeTmdb([TMDB_ID]);
  const runId = await store.startRun('discover_sync');

  const result = await discoverSync({ pool, store, tmdb, runId, slugs: await loadSlugs(pool), now: NOW });

  assert.equal(result.status, 'success');
  assert.equal(result.items, 0);
  assert.equal(result.reason, 'window', 'причина видна: окно прошло, а не «ничего не нашлось»');
  assert.equal(tmdb.calls.discover, 0, 'запросов к TMDB не было — иначе это штраф за пустую ночь');
});

test('упавшая карточка единственного кандидата не остаётся «ничего не нашлось»', { skip }, async () => {
  await cleanup();
  const tmdb = fakeTmdb([TMDB_ID], new Set([TMDB_ID]));
  const runId = await store.startRun('discover_sync');

  const result = await discoverSync({ pool, store, tmdb, runId, slugs: await loadSlugs(pool), now: NOW });

  assert.equal(result.status, 'partial', 'упавшая позиция — это «частично», а не пустой успешный прогон');
  assert.equal(result.errors, 1);
  const { rows } = await pool.query(
    'SELECT outcome FROM e_import_item_result WHERE run_id = $1', [runId],
  );
  assert.deepEqual(rows, [{ outcome: 'error' }], 'ошибка записана, а не выброшенная');
});

test('сбой одного сериала не роняет остальные', { skip }, async () => {
  await cleanup();
  const tmdb = fakeTmdb([BROKEN_TMDB_ID, TMDB_ID], new Set([BROKEN_TMDB_ID]));
  const runId = await store.startRun('discover_sync');
  const lines = [];

  const result = await discoverSync({
    pool, store, tmdb, runId, slugs: await loadSlugs(pool), now: NOW,
    log: (line) => lines.push(line),
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.errors, 1);
  assert.ok(lines.some((line) => line.includes('TMDB недоступен')),
    `причина сбоя видна в журнале: ${JSON.stringify(lines)}`);
  const { rows } = await pool.query(
    'SELECT outcome, reasons FROM e_import_item_result WHERE run_id = $1 ORDER BY outcome',
    [runId],
  );
  assert.deepEqual(rows.map((row) => row.outcome), ['error', 'ok'],
    'исход «ошибка» виден, а не потерян молча');
});