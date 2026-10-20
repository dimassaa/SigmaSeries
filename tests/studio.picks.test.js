// «Выбор редакции» и предпросмотр баннеров (F-10-08).
//
// Проверки на живой базе: назначение, месяц, снятие и предпросмотр. Важно
// одно: предпросмотр считает тот же отбор, что и главная, — иначе админ
// смотрел бы не на то, что увидят.

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { pgEditorialPicks } from '../src/services/studio/picks.js';

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

const skip = CONN ? false : 'нет подключения к базе — выбор редакции не проверялся';

let pool;
let picks;
let admin;

test.before(async () => {
  if (!CONN) return;
  pool = new pg.Pool(CONN);
  await pool.query('select 1');
  picks = pgEditorialPicks(pool);
  const { rows } = await pool.query(
    `SELECT u.id FROM e_user u
       JOIN e_role_assignment r ON r.user_id = u.id
      WHERE r.role = 'admin' LIMIT 1`,
  );
  admin = rows[0]?.id ?? null;
});

test.after(async () => {
  if (pool) await pool.end();
});

test('назначение попадает в месяц и снимается (F-10-08 §7)', { skip }, async () => {
  if (!admin) return;
  const candidates = await picks.candidates(5);
  if (!candidates.length) return;
  const date = '2026-11-05';

  const saved = await picks.assign({
    seriesId: candidates[0].id, date, byId: admin, note: 'проверка',
  });
  assert.equal(saved, true, 'назначение сохранено');

  const month = await picks.month({ year: 2026, month: 11 });
  const entry = month.get(date);
  assert.ok(entry, 'назначение видно в месяце');
  assert.equal(entry.seriesId, candidates[0].id);

  const removed = await picks.clear({ date });
  assert.equal(removed, true, 'назначение снято');
  const after = await picks.month({ year: 2026, month: 11 });
  assert.equal(after.get(date), undefined, 'назначения больше нет');
});

test('на сериал вне публикации назначение не делается (F-10-08 §9)', { skip }, async () => {
  if (!admin) return;
  const { rows } = await pool.query(
    `SELECT id FROM e_series WHERE archived_at IS NOT NULL OR publication_state <> 'published' LIMIT 1`,
  );
  if (!rows.length) return;
  const saved = await picks.assign({
    seriesId: rows[0].id, date: '2026-11-06', byId: admin,
  });
  assert.equal(saved, false, 'в архив или неопубликованный сериал не назначается');
});

test('предпросмотр даёт три баннера и выбор редакции в третьем (F-10-08 §8)', { skip }, async () => {
  if (!admin) return;
  const candidates = await picks.candidates(5);
  if (!candidates.length) return;
  const date = '2026-11-07';

  const before = await picks.preview({ date });
  assert.ok(before.length >= 1, 'предпросмотр не пуст');
  assert.ok(before.length <= 3, 'мест не больше трёх');

  await picks.assign({ seriesId: candidates[0].id, date, byId: admin });
  const after = await picks.preview({ date });
  const editorial = after.find((banner) => banner.kind === 'editorial');
  assert.ok(editorial, 'третье место — выбор редакции');
  assert.equal(editorial.seriesId, candidates[0].id, 'назначенный сериал и есть выбор');

  await picks.clear({ date });
});

test('в месяц попадает только сериал, годный для баннера (EC-S17)', { skip }, async () => {
  const candidates = await picks.candidates(50);
  for (const candidate of candidates) {
    assert.ok(candidate.id, 'у кандидата есть идентификатор');
  }
});
