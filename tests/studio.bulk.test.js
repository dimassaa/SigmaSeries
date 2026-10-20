// Массовые операции (F-10-11).
//
// Проверяется то, что делает операцию опасной: карточка, которой действие
// не подходит, пропускается с причиной, а остальные выполняются (EC-S15).

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { pgBulkOperations, MAX_BULK } from '../src/services/studio/bulk.js';

const CONN = process.env.PGHOST && process.env.PGDATABASE
  ? {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER,
      database: process.env.PGDATABASE,
    }
  : process.env.TEST_DATABASE_URL
    ? { connectionString: process.env.TEST_DATABASE_URL }
    : null;

const skip = CONN ? false : 'нет подключения к базе — массовые операции не проверялись';

let pool;
let bulk;
let ids;

test.before(async () => {
  if (!CONN) return;
  pool = new pg.Pool(CONN);
  await pool.query('select 1');
  bulk = pgBulkOperations(pool);

  ids = [];
  for (const [state, reasons] of [['imported', '{}'], ['imported', '{"no_genre"}']]) {
    const { rows: [series] } = await pool.query(
      `INSERT INTO e_series (slug, imdb_key, title_ru, title_original, year_start, exit_state, publication_state, reasons, level)
       VALUES ($1, $2, 'Карточка для операции', 'Bulk series', 2020, 'ended', $3, $4, 'minimum')
       RETURNING id`,
      [`bulk-${crypto.randomUUID().slice(0, 8)}`, `tt${crypto.randomUUID().slice(0, 8)}`, state, reasons],
    );
    ids.push(Number(series.id));
  }
});

test.after(async () => {
  if (pool) {
    for (const id of ids ?? []) await pool.query('DELETE FROM e_series WHERE id = $1', [id]);
  }
  if (pool) await pool.end();
});

test('прогноз считает затронутых и пропущенных (EC-S15)', { skip }, async () => {
  const plan = await bulk.preview({ action: 'publish', ids });
  assert.equal(plan.ok, true);
  assert.equal(plan.total, 2, 'две карточки');
  assert.equal(plan.affected, 1, 'опубликуется одна');
  assert.equal(plan.skipped.length, 1, 'вторая пропущена');
  assert.equal(plan.skipped[0].reason, 'no_genre', 'причина пропуска названа');
});

test('опубликовать выполняется только для подходящих карточек (EC-S15)', { skip }, async () => {
  const result = await bulk.run({ action: 'publish', ids, byId: null });
  assert.equal(result.ok, true);
  assert.equal(result.affected, 1);
  assert.equal(result.skipped.length, 1);

  const { rows } = await pool.query(
    'SELECT id, publication_state FROM e_series WHERE id = ANY($1::bigint[]) ORDER BY id', [ids],
  );
  const states = rows.map((row) => row.publication_state);
  assert.ok(states.includes('published'), 'одна карточка опубликована');
  assert.ok(states.includes('imported'), 'вторая осталась на месте');
});

test('за одну операцию — не больше двухсот карточек (F-10-11 §8)', { skip }, async () => {
  const many = Array.from({ length: MAX_BULK + 1 }, (_, index) => index + 1);
  const plan = await bulk.preview({ action: 'publish', ids: many });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'too_many');
});

test('неизвестное действие отвергается', { skip }, async () => {
  const plan = await bulk.preview({ action: 'взорвать', ids });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'action');
});
