// Ночной прогон расписания (F-12-07 §4).
//
// Проверяется на живой базе с подставным TMDB: сам код расписания — это три
// запроса к API и запись в базу, а вот цена ошибки в нём обнаруживается через
// неделю, когда у половины каталога «перенесли» даты, которых никто не
// переносил. Сравнение до/после — чистая функция, её и вынесли отдельно.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { acquireImportLock } from './helpers/import-lock.js';
import { createImportStore } from '../src/services/import/store.js';
import { writeSeries, loadSlugs } from '../src/services/import/write.js';
import {
  scheduleSync, loadActiveSeries, diffSchedule, lastSeasonNumber,
} from '../src/services/import/schedule-sync.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE или TEST_DATABASE_URL — ночной прогон не проверялся';

const TCONST = 'tt9000001';
const TMDB_ID = 900001;

let pool;
/** Отпускается в `after`: держит общую блокировку строк запуска. */
let unlockImport;
let store;
let seriesId;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  unlockImport = await acquireImportLock(pool);
  store = createImportStore(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_import_item_result WHERE tconst = $1', [TCONST]);
  // Свои прогоны убираются: незакрытая строка `running` осталась бы висеть и
  // блокировала бы заморозку режима защиты у соседних проверок.
  await pool.query("DELETE FROM e_import_run WHERE kind = 'schedule_sync' AND dry_run");
  // Порядок важен: `e_season.series_id` — RESTRICT намеренно, поэтому сезоны
  // уходят первыми, а каскады дальше срабатывают сами (сезон → серии → выходы).
  await pool.query('DELETE FROM e_season WHERE series_id IN (SELECT id FROM e_series WHERE imdb_key = $1)', [TCONST]);
  await pool.query('DELETE FROM e_series WHERE imdb_key = $1', [TCONST]);
  await unlockImport?.();
  await pool.end();
});

/** Карточка TMDB для подставного клиента. */
const details = (over = {}) => ({
  id: TMDB_ID,
  name: 'Ночной сериал',
  original_name: 'Night Show',
  overview: 'Описание на русском.',
  status: 'Returning Series',
  first_air_date: '2024-01-10',
  genres: [{ id: 18, name: 'Drama' }],
  // Запрашивается через append_to_response=content_ratings: без него ночная
  // запись законно сочла бы, что возрастной метки нет.
  content_ratings: { results: [{ iso_3166_1: 'RU', rating: '16+' }] },
  seasons: [{ season_number: 0 }, { season_number: 1 }, { season_number: 2 }],
  ...over,
});

/** Клиент TMDB с настраиваемым последним сезоном. */
function fakeTmdb(season) {
  const calls = [];
  return {
    calls,
    async getDetailsLocalized(id, language) {
      calls.push(`details:${language}`);
      return language === 'ru-RU'
        ? details()
        : details({ name: 'Night Show' });
    },
    async getSeason(id, number, language) {
      calls.push(`season:${number}`);
      return season;
    },
    get breakerTripped() { return false; },
  };
}

const seasonOf = (episodes) => ({
  season_number: 2,
  name: 'Второй сезон',
  overview: 'Описание сезона.',
  episodes: episodes.map((e, i) => ({
    episode_number: i + 1,
    name: `Серия ${i + 1}`,
    overview: '',
    air_date: e,
    runtime: 45,
  })),
});

// ─── Отбор сериалов ───────────────────────────────────────────────────────────

test('в выборку попадают только те, кто ещё не завершён и не отменён (§4)', { skip }, async () => {
  await pool.query(`
    INSERT INTO e_series (slug, title_ru, title_original, year_start, exit_state, imdb_key, tmdb_id, level, reasons, publication_state)
    VALUES
      ('test-night-active', 'Ночной', 'Night', 2024, 'airing',    'tt9000010', 900010, 'full', '{}', 'published'),
      ('test-night-ended',  'Ночной', 'Night', 2020, 'ended',     'tt9000011', 900011, 'full', '{}', 'published'),
      ('test-night-cancel', 'Ночной', 'Night', 2021, 'cancelled', 'tt9000012', 900012, 'full', '{}', 'published')`);

  try {
    const rows = await loadActiveSeries(pool);
    assert.ok(rows.some((row) => row.tmdbId === 900010), 'идущий сериал нужен');
    assert.ok(!rows.some((row) => row.tmdbId === 900011), 'завершённый — не нужен');
    assert.ok(!rows.some((row) => row.tmdbId === 900012), 'отменённый — не нужен');
  } finally {
    await pool.query(
      'DELETE FROM e_series WHERE imdb_key IN (\'tt9000010\', \'tt9000011\', \'tt9000012\')',
    );
  }
});

test('последний сезон — наибольший номер, а не последний в списке', () => {
  // Спецвыпуски (0) в расчёт не идут, а нумерация с пропуском — обычное дело.
  assert.equal(lastSeasonNumber(details()), 2);
  assert.equal(lastSeasonNumber(details({ seasons: [{ season_number: 0 }] })), null);
  assert.equal(lastSeasonNumber(details({ seasons: [] })), null);
  assert.equal(lastSeasonNumber(null), null);
});

// ─── Сравнение до и после ─────────────────────────────────────────────────────

const state = (exitState, episodes) => ({
  exitState,
  season: 2,
  episodes: Object.fromEntries(episodes.map(([number, date]) => [number, date])),
});

test('дата сдвинулась позже — это перенос', () => {
  const changes = diffSchedule({
    before: state('waiting', [[1, '2026-10-10'], [2, '2026-10-17']]),
    after: state('waiting', [[1, '2026-10-10'], [2, '2026-10-24']]),
  });
  assert.deepEqual(changes, [{
    code: 'postponed', season: 2, episode: 2, from: '2026-10-17', to: '2026-10-24',
  }]);
});

test('дата сдвинулась раньше — это перенос назад, а не перенос', () => {
  const changes = diffSchedule({
    before: state('waiting', [[1, '2026-10-24']]),
    after: state('waiting', [[1, '2026-10-17']]),
  });
  assert.equal(changes[0].code, 'advanced');
});

test('появилась серия с датой — это объявление', () => {
  const changes = diffSchedule({
    before: state('waiting', [[1, '2026-10-10']]),
    after: state('waiting', [[1, '2026-10-10'], [2, '2026-11-01']]),
  });
  assert.deepEqual(changes.map((c) => c.code), ['announced']);
  assert.equal(changes[0].episode, 2);
  assert.equal(changes[0].to, '2026-11-01');
});

test('появилась серия без даты — не объявление', () => {
  // Даты нет — значит, источник о ней ещё не знает, и объявлять нечего.
  const changes = diffSchedule({
    before: state('waiting', [[1, '2026-10-10']]),
    after: state('waiting', [[1, '2026-10-10'], [2, null]]),
  });
  assert.deepEqual(changes, []);
});

test('серия исчезла из источника — молчим', () => {
  // Источник иногда теряет серии при переезде. Удалять из каталога по одному
  // ответу — значит терять данные; исчезновение замечает полный прогон.
  const changes = diffSchedule({
    before: state('waiting', [[1, '2026-10-10'], [2, '2026-10-17']]),
    after: state('waiting', [[1, '2026-10-10']]),
  });
  assert.deepEqual(changes, []);
});

test('смена состояния выхода — самостоятельное событие', () => {
  const changes = diffSchedule({
    before: state('waiting', [[1, '2026-10-10']]),
    after: state('ended', [[1, '2026-10-10']]),
  });
  assert.deepEqual(changes, [{ code: 'state_changed', from: 'waiting', to: 'ended' }]);
});

test('ничего не изменилось — пусто', () => {
  assert.deepEqual(diffSchedule({
    before: state('airing', [[1, '2026-10-10']]),
    after: state('airing', [[1, '2026-10-10']]),
  }), []);
});

// ─── Прогон целиком ───────────────────────────────────────────────────────────

/** Сырой слой сериала теста: есть жанр, описание и люди, нет картинок. */
const fixture = (over = {}) => ({
  tconst: TCONST,
  tmdbId: TMDB_ID,
  status: 'Returning Series',
  titles: { original: { text: 'Night Show' }, ru: { text: 'Ночной сериал' }, en: { text: 'Night Show' } },
  descriptions: { ru: { text: 'Описание.' }, en: { text: '' } },
  years: { start: 2024, end: null },
  genres: [{ name: 'Drama' }],
  imdbGenres: ['Drama'],
  ageRating: { code: 'RU', rating: '18+' },
  people: { directors: [{ nconst: 'nm1', name: 'Режиссёр' }], cast: [] },
  seasons: [{
    number: 2,
    titleRu: { text: 'Второй сезон' },
    descriptionRu: { text: '' },
    episodes: [{ number: 1, titleRu: { text: 'Первая' }, descriptionRu: { text: '' }, date: '2026-10-10', runtimeMin: 45 }],
  }],
  ...over,
});

/** Картинки приходят из F-12-05 и хранятся в базе: уровень зависит от них. */
async function addImages(id) {
  await pool.query(
    `INSERT INTO e_image (role, mime, width, height, series_id)
     VALUES ('poster','image/webp',500,750,$1), ('backdrop','image/webp',1280,720,$1)`,
    [id],
  );
}

test('ночной прогон обновляет расписание и не понижает полноту', { skip }, async () => {
  const slugs = await loadSlugs(pool);
  seriesId = (await writeSeries({ pool, slugs, raw: fixture() })).seriesId;
  await addImages(seriesId);
  assert.equal((await writeSeries({ pool, slugs, raw: fixture() })).level, 'full',
    'карточка с картинками, жанром, описанием и людьми — полная');

  const runId = await store.startRun('schedule_sync', { dryRun: true });
  const tmdb = fakeTmdb(seasonOf(['2026-10-10', '2026-10-24']));
  const result = await scheduleSync({
    pool, store, tmdb, runId, slugs,
    targets: [{ tconst: TCONST, tmdbId: TMDB_ID }],
    now: new Date('2026-10-14T12:00:00Z'),
  });

  assert.equal(result.status, 'success');
  assert.equal(result.items, 1);
  assert.deepEqual(result.changes, [{
    tconst: TCONST, code: 'announced', season: 2, episode: 2, from: null, to: '2026-10-24',
  }], 'появилась вторая серия с датой');

  const { rows } = await pool.query(
    'SELECT exit_state, level, reasons FROM e_series WHERE id = $1', [seriesId],
  );
  assert.equal(rows[0].level, 'full',
    `людей ночной прогон не качает, но полнота падать не должна: ${JSON.stringify(rows[0].reasons)}`);
  assert.deepEqual(rows[0].reasons, []);

  const dates = await pool.query(
    `SELECT r.release_date FROM e_release r JOIN e_season s ON s.id = r.season_id
      WHERE s.series_id = $1 ORDER BY r.release_date`, [seriesId],
  );
  assert.deepEqual(dates.rows.map((row) => row.release_date), ['2026-10-10', '2026-10-24']);
});

test('непроверенная причина не исчезает, а переносится', { skip }, async () => {
  // Обратная сторона: если людей в карточке и не было, ночной прогон не должен
  // «вылечить» её — он их просто не смотрел.
  const slugs = await loadSlugs(pool);
  const raw = fixture({ people: { directors: [], cast: [] } });
  const id = (await writeSeries({ pool, slugs, raw })).seriesId;
  await addImages(id);
  const before = await writeSeries({ pool, slugs, raw });
  assert.equal(before.level, 'displayable');
  assert.deepEqual(before.reasons, ['no_people']);

  const runId = await store.startRun('schedule_sync', { dryRun: true });
  await scheduleSync({
    pool, store, tmdb: fakeTmdb(seasonOf(['2026-10-10'])), runId, slugs,
    targets: [{ tconst: TCONST, tmdbId: TMDB_ID }],
    now: new Date('2026-10-14T12:00:00Z'),
  });

  const { rows } = await pool.query('SELECT level, reasons FROM e_series WHERE id = $1', [id]);
  assert.deepEqual(rows[0].reasons, ['no_people'], 'причина, которой прогон не проверял, остаётся');
  assert.equal(rows[0].level, 'displayable', 'уровень не повышается тем, чего не проверяли');
  await pool.query('DELETE FROM e_image WHERE series_id = $1', [id]);
  await pool.query('DELETE FROM e_season WHERE series_id = $1', [id]);
  await pool.query('DELETE FROM e_series WHERE id = $1', [id]);
});

test('ошибка одного сериала не роняет остальные', { skip }, async () => {
  const runId = await store.startRun('schedule_sync', { dryRun: true });
  const tmdb = fakeTmdb(seasonOf(['2026-10-10']));
  tmdb.getDetailsLocalized = async (id, language) => {
    if (id === 900002) throw new Error('сеть недоступна');
    return language === 'ru-RU' ? details() : details();
  };

  const result = await scheduleSync({
    pool, store, tmdb, runId, slugs: new Set(),
    targets: [{ tconst: TCONST, tmdbId: TMDB_ID }, { tconst: 'tt9000002', tmdbId: 900002 }],
    now: new Date('2026-10-14T12:00:00Z'),
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.items, 2);
  assert.equal(result.errors, 1);

  const { rows } = await pool.query(
    `SELECT tconst, outcome FROM e_import_item_result WHERE run_id = $1 ORDER BY tconst`, [runId],
  );
  assert.deepEqual(rows.map((row) => row.outcome).sort(), ['error', 'ok']);
});

test('поздний прогон не бьёт по сухому: каталог не меняется', { skip }, async () => {
  const before = await pool.query('SELECT level, reasons FROM e_series WHERE id = $1', [seriesId]);
  const runId = await store.startRun('schedule_sync', { dryRun: true });
  const tmdb = fakeTmdb(seasonOf(['2026-11-07']));

  const result = await scheduleSync({
    pool, store, tmdb, runId, slugs: new Set(),
    targets: [{ tconst: TCONST, tmdbId: TMDB_ID }],
    dryRun: true,
    now: new Date('2026-10-14T12:00:00Z'),
  });

  assert.equal(result.status, 'success');
  const after = await pool.query('SELECT level, reasons FROM e_series WHERE id = $1', [seriesId]);
  assert.deepEqual(after.rows[0], before.rows[0], 'сухой прогон читает и считает, но не пишет');
  const { rows } = await pool.query(
    'SELECT outcome FROM e_import_item_result WHERE run_id = $1', [runId],
  );
  assert.equal(rows[0].outcome, 'ok', 'результат сухого прогона виден в отчёте');
});
