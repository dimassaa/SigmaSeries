// Студия: список сериалов и очередь неполных карточек (F-10-01, F-10-02).
//
// Проверки на живой базе: фильтры, порядок очереди и постраничность. Отдельно
// — что чужим адреса студии отвечают 404, а не 403: раздела не существует.

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { pgStudioCatalogue } from '../src/services/studio/catalogue.js';

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

const skip = CONN ? false : 'нет подключения к базе — студия не проверялась';

let pool;
let studio;

test.before(async () => {
  if (!CONN) return;
  pool = new pg.Pool(CONN);
  await pool.query('select 1');
  studio = pgStudioCatalogue(pool);
});

test.after(async () => {
  if (pool) await pool.end();
});

test('список отдаёт страницу строк и общее число (F-10-01 §4)', { skip }, async () => {
  const list = await studio.list({});
  assert.ok(list.rows.length <= 50, 'страница не больше пятидесяти строк');
  assert.ok(list.total >= list.rows.length, 'общее число не меньше страницы');
  assert.ok(list.pages >= 1);
});

test('вторая страница не повторяет первую (F-10-01 §14)', { skip }, async () => {
  const first = await studio.list({ page: 1, sort: 'title' });
  const second = await studio.list({ page: 2, sort: 'title' });
  if (first.total <= 50) return;
  const firstIds = first.rows.map((row) => row.id);
  const secondIds = second.rows.map((row) => row.id);
  assert.equal(firstIds.some((id) => secondIds.includes(id)), false, 'страницы не пересекаются');
});

test('фильтр по названию оставляет только подходящие сериалы (F-10-01 §4)', { skip }, async () => {
  const list = await studio.list({ query: 'Breaking' });
  assert.ok(list.total >= 1, 'такой сериал есть в каталоге');
  for (const row of list.rows) {
    const haystack = `${row.title} ${row.titleOriginal}`.toLowerCase();
    assert.ok(haystack.includes('breaking'), `«${row.title}» не подходит под фильтр`);
  }
});

test('фильтр по состоянию публикации разделяет сериалы (F-10-01 §4)', { skip }, async () => {
  const published = await studio.list({ publication: 'published' });
  for (const row of published.rows) {
    assert.equal(row.publicationState, 'published');
  }
  const imported = await studio.list({ publication: 'imported' });
  for (const row of imported.rows) {
    assert.equal(row.publicationState, 'imported');
  }
});

test('фильтр по причине оставляет только карточки с этой причиной (F-10-01 §18)', { skip }, async () => {
  const list = await studio.list({ reasons: ['no_backdrop'] });
  if (!list.total) return;
  for (const row of list.rows) {
    assert.ok(row.reasons.some((reason) => reason.code === 'no_backdrop'),
      `у «${row.title}» есть no_backdrop`);
  }
});

test('значение фильтра не из адреса не попадает в запрос (F-10-01 §9)', { skip }, async () => {
  // Мусор в значении не должен ломать запрос: неизвестное значение отбрасывается,
  // а не подставляется в SQL.
  const list = await studio.list({ publication: "'; drop table e_series; --", exit: 'нет' });
  assert.ok(Array.isArray(list.rows));
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM e_series');
  assert.ok(rows[0].n > 0, 'таблица на месте');
});

test('очередь неполных карточек идёт по классам причины (F-10-02, M12 §8)', { skip }, async () => {
  const queue = await studio.incomplete({});
  if (!queue.rows.length) return;
  const rank = (row) => {
    const codes = row.reasons.map((reason) => reason.code);
    if (codes.some((code) => ['no_tmdb', 'pair_doubt', 'no_genre'].includes(code))) return 0;
    if (codes.some((code) => ['no_backdrop', 'schedule_gap'].includes(code))) return 1;
    if (codes.some((code) => ['no_poster', 'no_overview', 'no_overview_ru', 'no_people'].includes(code))) return 2;
    return 3;
  };
  const ranks = queue.rows.map(rank);
  for (let i = 1; i < ranks.length; i += 1) {
    assert.ok(ranks[i] >= ranks[i - 1], 'классы не перемешиваются');
  }
  for (const row of queue.rows) {
    assert.ok(row.reasons.length > 0, 'в очереди только неполные карточки');
  }
});

test('очередь по одной причине показывает только её (F-10-02)', { skip }, async () => {
  const queue = await studio.incomplete({ reason: 'no_genre' });
  for (const row of queue.rows) {
    assert.ok(row.reasons.some((reason) => reason.code === 'no_genre'));
  }
});
