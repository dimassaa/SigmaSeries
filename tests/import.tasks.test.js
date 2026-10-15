// Связывание ночных задач с видами запуска (F-12-07 §4).
//
// Проверяется то, ради чего модуль существует: вид запуска попадает в свою
// задачу, а не в соседнюю, и реестр не растёт сам собой посторонними видами.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { createPool } from '../src/db/pool.js';
import { createImportStore } from '../src/services/import/store.js';
import { createImportTasks } from '../src/services/import/tasks.js';
import { TASK_ORDER } from '../src/services/import/scheduler.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — реестр ночных задач не проверялся';

const DATA_DIR = '/tmp/opencode/tasks-imdb';
const TCONST = 'tt8890001';
const NOW = new Date('2026-10-19T05:00:00Z');

let pool;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  await pool.query('DELETE FROM e_series WHERE imdb_key = $1', [TCONST]);
  await pool.query(
    `INSERT INTO e_series (slug, title_original, imdb_key, year_start, level, reasons)
     VALUES ('test-tasks-ratings', 'Ratings Tasks', $1, 2012, 'full', '{}')`,
    [TCONST],
  );

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const text = ['tconst\taverageRating\tnumVotes', `${TCONST}\t8.4\t3210`].join('\n') + '\n';
  fs.writeFileSync(path.join(DATA_DIR, 'title.ratings.tsv.gz'), zlib.gzipSync(Buffer.from(text)));
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_series WHERE imdb_key = $1', [TCONST]);
  await pool.end();
});

test('у каждого ночного вида запуска есть задача, и лишних видов нет', { skip }, () => {
  const tasks = createImportTasks({ pool, store: createImportStore(pool), tmdb: {} });

  assert.deepEqual(Object.keys(tasks).sort(), ['discover_sync', 'ratings_sync', 'schedule_sync']);
  assert.equal(tasks.full_run, undefined, 'полный прогон запускается по кнопке, а не по часу');
  assert.equal(tasks.backup, undefined, 'резервная копия — задача M9');
  assert.deepEqual(TASK_ORDER, ['backup', 'schedule_sync', 'discover_sync', 'ratings_sync'],
    'порядок ночи задан заранее и не зависит от того, что уже построено');
});

test('задача рейтингов берёт датасет и пишет числа в каталог', { skip }, async () => {
  const tasks = createImportTasks({
    pool,
    store: createImportStore(pool),
    tmdb: {},
    dataDir: DATA_DIR,
    log: () => {},
  });

  const result = await tasks.ratings_sync({ now: NOW });

  assert.equal(result.status, 'success');
  assert.equal(result.items, 1);

  const { rows } = await pool.query(
    `SELECT r.value::text AS value, r.votes, r.measured_on::text AS measured
       FROM e_external_rating r
       JOIN e_series s ON s.id = r.series_id
      WHERE s.imdb_key = $1 AND r.platform = 'imdb'`,
    [TCONST],
  );
  assert.deepEqual(rows, [{ value: '8.4', votes: 3210, measured: '2026-10-19' }]);
});