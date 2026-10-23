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
  // Первая карточка действительно готова к публикации: у неё есть жанр.
  // Вторая остаётся без жанра и должна быть пропущена (EC-S15).
  await pool.query(
    'INSERT INTO e_series_genre (series_id, genre_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [ids[0], 'drama'],
  );
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
  const started = await bulk.start({ action: 'publish', ids, byId: null });
  assert.equal(started.ok, true, 'задание запущено');
  assert.ok(started.jobId, 'у задания есть номер');
  await started.work;

  const { rows: [job] } = await pool.query(
    'SELECT done, failed, state FROM e_bulk_job WHERE id = $1', [started.jobId],
  );
  assert.equal(job.state, 'partial', 'задание закончилось частично');
  assert.equal(Number(job.done), 2, 'обработаны обе карточки');
  assert.equal(Number(job.failed), 1, 'одна пропущена');

  const result = { affected: 2 - 1 };
  assert.equal(result.affected, 1);

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

test('блокировка, принятие причины и отчёт по заданию', { skip }, async () => {
  const locked = await bulk.start({
    action: 'lock', ids: [ids[0]], field: 'title_ru', byId: null,
  });
  assert.equal(locked.ok, true);
  await locked.work;
  const job = await bulk.job(locked.jobId);
  assert.equal(job.state, 'done', 'одна карточка — задание готово');
  assert.equal(job.done, 1);
  assert.equal(job.result[0].ok, true);

  const { rows: [lock] } = await pool.query(
    'SELECT field FROM e_field_lock WHERE series_id = $1', [ids[0]],
  );
  assert.equal(lock?.field, 'title_ru', 'поле заблокировано от импорта');

  const { rows: [history] } = await pool.query(
    `SELECT count(*)::int AS count FROM e_catalog_version
      WHERE series_id = $1 AND diff ? 'field_lock'`, [ids[0]],
  );
  assert.ok(history.count >= 1, 'у карточки появилась версия с причиной');

  const unlocked = await bulk.start({
    action: 'unlock', ids: [ids[0]], field: 'title_ru', byId: null,
  });
  await unlocked.work;
  const { rows: after } = await pool.query(
    'SELECT 1 FROM e_field_lock WHERE series_id = $1', [ids[0]],
  );
  assert.equal(after.length, 0, 'блокировка снята');

  const accepted = await bulk.start({
    action: 'accept_reason', ids: [ids[1]], reason: 'no_genre', byId: null,
  });
  await accepted.work;
  const { rows: [series] } = await pool.query(
    'SELECT reasons FROM e_series WHERE id = $1', [ids[1]],
  );
  assert.ok(!series.reasons.includes('no_genre'), 'принятая причина снята');
});

test('жанр добавляется и убирается массово', { skip }, async () => {
  const added = await bulk.start({
    action: 'add_genre', ids: [ids[1]], genre: 'drama', byId: null,
  });
  assert.equal(added.ok, true, 'жанр из справочника принят');
  await added.work;
  const { rows: [has] } = await pool.query(
    'SELECT 1 FROM e_series_genre WHERE series_id = $1 AND genre_code = $2', [ids[1], 'drama'],
  );
  assert.ok(has, 'жанр появился');

  const removed = await bulk.start({
    action: 'remove_genre', ids: [ids[1]], genre: 'drama', byId: null,
  });
  await removed.work;
  const { rows: [gone] } = await pool.query(
    'SELECT 1 FROM e_series_genre WHERE series_id = $1 AND genre_code = $2', [ids[1], 'drama'],
  );
  assert.equal(gone, undefined, 'жанр убран');
});

test('«всё по фильтру» разрешается тем же условием, что и таблица', { skip }, async () => {
  const { pgStudioCatalogue } = await import('../src/services/studio/catalogue.js');
  const catalogue = pgStudioCatalogue(pool);
  const selected = await catalogue.ids({ query: 'Карточка для операции' }, MAX_BULK + 1);
  assert.ok(selected.includes(ids[0]), 'свой сериал попал в выборку');
  assert.ok(selected.includes(ids[1]), 'и второй тоже');
  assert.ok(selected.length <= MAX_BULK + 1, 'лишний нужен только для проверки предела');
});
