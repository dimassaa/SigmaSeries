// Отчёт об импорте (F-12-08, S-76): покрытие расписания, запуски, детали.
//
// Проверяется против живой базы: числа отчёта — это SQL (агрегаты по
// каталогу и по прогонам), и подменять их заглушкой нечего. Числа в общей
// базе считаются дельтой: своя фикстура добавляет ровно своё.
//
// Пропускается, если PG* не заданы.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgImportReport } from '../src/services/import/report.js';
import { createImportStore } from '../src/services/import/store.js';
import { studioImportView } from '../src/view/studioImport.js';
import { acquireImportLock } from './helpers/import-lock.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — отчёт об импорте не проверялся';

let pool;
let report;
let store;
/** Отпускается в `after`: держит общую блокировку строк запуска. */
let unlockImport;
const slugs = [];
const runs = [];
let fixture = 0;

/** Номер TMDB-идентификатора фикстуры: уникальный, как требует база. */
function counter() {
  fixture += 1;
  return fixture;
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  unlockImport = await acquireImportLock(pool);
  report = pgImportReport(pool);
  store = createImportStore(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_import_item_result WHERE run_id = ANY($1::bigint[])', [runs]);
  await pool.query('DELETE FROM e_import_run WHERE id = ANY($1::bigint[])', [runs]);
  // Сезоны удаляются первыми: ключ на них ограничен (R-SQL-02), и каскада с
  // сериала нет.
  await pool.query(
    'DELETE FROM e_season WHERE series_id IN (SELECT id FROM e_series WHERE slug = ANY($1::text[]))',
    [slugs],
  );
  await pool.query('DELETE FROM e_series WHERE slug = ANY($1::text[])', [slugs]);
  await unlockImport?.();
  await pool.end();
});

/** Сериал в состоянии «выходит» с одним выходом. */
async function seriesWithRelease({ exitState = 'airing', date = '2026-11-10' } = {}) {
  const slug = `import-report-${crypto.randomUUID().slice(0, 8)}`;
  slugs.push(slug);
  const { rows: [row] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Отчёт об импорте: тест', 'Import report fixture', $3, 'published', $2, 2026)
     RETURNING id`,
    [slug, exitState, 960000000 + counter()]
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id',
    [row.id],
  );
  await pool.query(
    'INSERT INTO e_release (season_id, release_date, covers_season) VALUES ($1, $2, FALSE)',
    [season.id, date],
  );
  return row;
}

test('покрытие считает выходящие сериалы с датами и без них', { skip }, async () => {
  const before = await report.overview();

  await seriesWithRelease({ exitState: 'airing' });
  await seriesWithRelease({ exitState: 'announced' });

  const after = await report.overview();
  assert.equal(after.total - before.total, 1, 'в «выходит» попал только один сериал');
  assert.equal(after.withDates - before.withDates, 1, 'у него есть дата выхода');
  assert.equal(
    after.states.announced - before.states.announced,
    1,
    'анонс посчитан в своём состоянии, а не в «выходит»',
  );
});

test('плотность календаря разбита по неделям до конца года', { skip }, async () => {
  await seriesWithRelease({ date: '2026-11-10' });
  const overview = await report.overview();

  const weeks = overview.weeks.map((week) => week.week);
  assert.deepEqual(weeks, [...weeks].sort(), 'недели идут по порядку');
  assert.ok(weeks.every((week) => week <= '2026-12-31'), 'окно заканчивается 31.12');
  assert.ok(overview.weeks.some((week) => week.week === '2026-11-09'), 'неделя выхода посчитана');
});

test('запуски и детали запуска: счётчики, исходы и фильтр', { skip }, async () => {
  const runId = await store.startRun('full_run', { dryRun: true });
  runs.push(runId);
  await store.saveItems(runId, [
    { tconst: 'tt7000001', stage: 'matched', outcome: 'ok', tmdbId: 1 },
    { tconst: 'tt7000002', stage: 'matched', outcome: 'no_tmdb' },
    { tconst: 'tt7000003', stage: 'matched', outcome: 'error', reasons: ['сеть недоступна'] },
  ]);
  await store.finishRun(runId, 'partial', {
    counters: { matched: 1, no_tmdb: 1, error: 1, total: 3 },
    checkpoint: { stage: 'matched', processed: 3, planned: 3 },
  });

  const list = await report.runs();
  assert.ok(list.some((row) => row.id === runId), 'запуск виден в списке');
  const found = list.find((row) => row.id === runId);
  assert.equal(found.status, 'partial');
  assert.equal(found.counters.total, 3);

  const detail = await report.run(runId);
  assert.equal(detail.items.length, 3);
  assert.equal(detail.byOutcome.error, 1);
  assert.equal(detail.total, 3);

  const onlyErrors = await report.run(runId, { outcome: 'error' });
  assert.equal(onlyErrors.items.length, 1, 'фильтр по исходу оставляет только свои');
  assert.equal(onlyErrors.items[0].tconst, 'tt7000003');

  const bogus = await report.run(runId, { outcome: 'что-то' });
  assert.equal(bogus.items.length, 3, 'незнакомый исход не фильтрует, а не ломает отчёт');
});

test('несуществующий запуск — это отсутствие, а не ошибка', { skip }, async () => {
  assert.equal(await report.run(999999999), null);
});

test('экран отчёта собирается и показывает ключевое число', { skip }, async () => {
  // Свой запуск: без него экран показывает пустое состояние, а не отчёт.
  const runId = await store.startRun('full_run', { dryRun: true });
  runs.push(runId);

  const overview = await report.overview();
  const runsList = await report.runs();
  const detail = runsList.length ? await report.run(runsList[0].id) : null;

  const html = studioImportView({
    locale: 'ru',
    overview,
    runs: runsList,
    detail,
    mode: { frozen: false, since: null },
    selected: detail?.run?.id ?? null,
    csrf: 'токен',
  });
  const text = String(html.__raw);

  assert.match(text, /studio-import__coverage/);
  assert.match(text, /studio-import__coverage/);
  assert.match(text, /studio-import__runs/);
});

test('экран на английском собирается без пропущенных ключей', { skip }, async () => {
  const overview = await report.overview();
  const html = studioImportView({
    locale: 'en',
    overview,
    runs: [],
    detail: null,
    mode: { frozen: true, since: '2026-10-21' },
    selected: null,
    csrf: '',
  });
  const text = String(html.__raw);

  assert.match(text, /Import/);
  assert.match(text, /defence|защита/i);
  assert.match(text, /The import has not been run yet/);
});
