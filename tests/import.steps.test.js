// Шаги импорта (F-12-01…F-12-06): сухой прогон.
//
// Проверяется главное из F-12-08 §6: сухой прогон не пишет в каталог, но
// говорит, что изменилось бы. Сама запись проверяется в `import.write` —
// здесь важна разница между «записал» и «не записал».

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createImportStore } from '../src/services/import/store.js';
import { catalogueStep } from '../src/services/import/steps.js';
import { writeSeries, loadSlugs } from '../src/services/import/write.js';
import { acquireImportLock } from './helpers/import-lock.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — сухой прогон не проверялся';

let pool;
/** Отпускается в `after`: держит общую блокировку строк запуска. */
let unlockImport;
const runs = [];
const slugs = [];
let counter = 0;

/** Сырой слой сериала — как его кладёт обогащение. */
function raw() {
  counter += 1;
  const tconst = `tt77${String(counter).padStart(6, '0')}`;
  return {
    tconst,
    tmdbId: 7700000 + counter,
    status: 'Ended',
    titles: { original: { text: `Сухой сериал ${counter}` }, ru: { text: '' }, en: { text: '' } },
    descriptions: { ru: { text: 'Описание' }, en: { text: '' } },
    years: { start: 2015, end: 2019 },
    nextEpisode: null,
    lastEpisode: { date: '2019-05-01' },
    imdbGenres: ['Drama'],
    votes: { average: 9.5, count: 100 },
    tmdbVotes: { average: 9.4, count: 5000 },
    people: { directors: [], cast: [] },
    seasons: [],
  };
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  unlockImport = await acquireImportLock(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_import_item_result WHERE run_id = ANY($1::bigint[])', [runs]);
  await pool.query('DELETE FROM e_import_run WHERE id = ANY($1::bigint[])', [runs]);
  await pool.query(
    'DELETE FROM e_season WHERE series_id IN (SELECT id FROM e_series WHERE slug = ANY($1::text[]))',
    [slugs],
  );
  await pool.query('DELETE FROM e_series WHERE slug = ANY($1::text[])', [slugs]);
  await unlockImport?.();
  await pool.end();
});

test('сухой прогон не пишет в каталог, но считает, что изменилось бы', { skip }, async () => {
  const store = createImportStore(pool);
  const runId = await store.startRun('full_run', { dryRun: true });
  runs.push(runId);

  const series = raw();
  await store.saveItems(runId, [{
    tconst: series.tconst, stage: 'enriched', outcome: 'ok', raw: series,
  }]);

  const result = await catalogueStep({ pool, store, runId });

  assert.equal(result.counters.written, 0, 'в каталог не записано ничего');
  assert.equal(result.counters.added, 1, 'сериал был бы добавлен');

  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM e_series WHERE imdb_key = $1', [series.tconst],
  );
  assert.equal(rows[0].n, 0, 'в каталоге такого сериала нет');

  // Позиция прогона помечена пропущенной и объясняет почему.
  const { rows: items } = await pool.query(
    'SELECT outcome, reasons FROM e_import_item_result WHERE run_id = $1', [runId],
  );
  assert.equal(items[0].outcome, 'skipped');
  assert.ok(items[0].reasons.includes('dry_run'), 'причина — сухой прогон');
});

test('сухой прогон отличает «добавить», «обновить» и «без изменений»', { skip }, async () => {
  const store = createImportStore(pool);
  const existing = raw();
  const written = await writeSeries({ pool, raw: existing, slugs: await loadSlugs(pool) });
  slugs.push(written.slug);

  const runId = await store.startRun('full_run', { dryRun: true });
  runs.push(runId);

  const changed = raw();
  await store.saveItems(runId, [{
    tconst: existing.tconst, stage: 'enriched', outcome: 'ok', raw: existing,
  }, {
    tconst: changed.tconst, stage: 'enriched', outcome: 'ok', raw: changed,
  }]);

  const result = await catalogueStep({ pool, store, runId });

  assert.equal(result.counters.added, 1, 'новый сериал — добавление');
  assert.equal(result.counters.unchanged, 1, 'тот же сериал — без изменений');
  assert.equal(result.counters.updated, 0);
  assert.equal(result.counters.written, 0, 'в каталог не записано ничего');

  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM e_series WHERE imdb_key = ANY($1::text[])',
    [[existing.tconst, changed.tconst]],
  );
  assert.equal(rows[0].n, 1, 'в каталоге только тот, кто был до прогона');
});
