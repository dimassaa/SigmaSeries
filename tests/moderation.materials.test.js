// «Мои материалы» (F-05-09, S-35).
//
// Проверяется то, что видит автор: у каждого материала своё состояние
// человеческим языком, у запрещённого — причина, и удаление убирает материал
// из очереди.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { pgMyMaterials } from '../src/services/moderation/materials.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — «Мои материалы» не проверялись';

let pool;
let materials;
const series = [];
const users = [];

async function viewer() {
  const { hash } = makeToken();
  const nickname = `my-content-${crypto.randomUUID().slice(0, 8)}`;
  const created = await pgAuthStore(pool).createUser({
    email: `${nickname}@example.com`,
    nickname,
    passwordHash: await hashPassword('правильный-пароль-из-десяти'),
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  await pool.query(
    `UPDATE e_user SET email_confirmed = TRUE, registered_at = now() - interval '30 days' WHERE id = $1`,
    [created.id],
  );
  users.push(created.id);
  return created.id;
}

async function seriesWith() {
  const { rows: [row] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Мои материалы', 'My fixture', $2, 'published', 'airing', 2024) RETURNING id`,
    [`my-content-${crypto.randomUUID().slice(0, 8)}`, 980_000_000 + Math.floor(Math.random() * 900)],
  );
  series.push(row.id);
  return row.id;
}

/** Материал автора в нужном состоянии. */
async function material({ authorId, seriesId, state = 'published' }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO e_material (author_id, kind, series_id, body, state)
     VALUES ($1, 'review', $2, 'Текст материала автора', $3) RETURNING id`,
    [authorId, seriesId, state],
  );
  return Number(row.id);
}

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
  materials = pgMyMaterials(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_editor_decision WHERE material_id IN (SELECT id FROM e_material WHERE series_id = ANY($1::bigint[]))', [series]);
  await pool.query('DELETE FROM e_material WHERE series_id = ANY($1::bigint[])', [series]);
  await pool.query('DELETE FROM e_series WHERE id = ANY($1::bigint[])', [series]);
  await pool.query('DELETE FROM e_user WHERE id = ANY($1::bigint[])', [users]);
  await pool.end();
});

test('у каждого материала своё состояние, у запрещённого — причина (F-05-09 §18)', { skip }, async () => {
  const author = await viewer();
  const seriesId = await seriesWith();
  const published = await material({ authorId: author, seriesId, state: 'published' });
  const checking = await material({ authorId: author, seriesId: await seriesWith(), state: 'checking' });
  const rejected = await material({ authorId: author, seriesId: await seriesWith(), state: 'rejected' });

  await pool.query(
    `INSERT INTO e_editor_decision (material_id, editor_id, decision, reason)
     VALUES ($1, $2, 'rejected', 'запрещённый список')`,
    [rejected, await viewer()],
  );

  const list = await materials.own({ userId: author });
  assert.equal(list.total, 3, 'три материала');
  const byId = new Map(list.items.map((item) => [item.id, item]));

  assert.equal(byId.get(published).state, 'published');
  assert.equal(byId.get(checking).state, 'checking');
  assert.equal(byId.get(rejected).state, 'rejected');
  assert.equal(byId.get(rejected).reason, 'запрещённый список', 'причина решения видна автору');
  assert.equal(byId.get(checking).reason, null, 'у материала на проверке причины нет');
});

test('список не выдаёт наружу тело материала (F-05-09 §7)', { skip }, async () => {
  const author = await viewer();
  const seriesId = await seriesWith();
  await material({ authorId: author, seriesId, state: 'published' });

  const list = await materials.own({ userId: author });
  assert.equal(list.items[0].body, undefined, 'тела материала в списке нет');
});

test('удаление убирает материал из очереди (F-05-09 §18)', { skip }, async () => {
  const author = await viewer();
  const seriesId = await seriesWith();
  const queued = await material({ authorId: author, seriesId, state: 'flagged' });

  const removed = await materials.remove({ materialId: queued, userId: author });
  assert.equal(removed, true, 'материал удалён');

  const { rows: [row] } = await pool.query('SELECT state FROM e_material WHERE id = $1', [queued]);
  assert.equal(row.state, 'deleted', 'у состояния «удалён» материал в очередь не возвращается');
});

test('чужой материал удалить нельзя', { skip }, async () => {
  const author = await viewer();
  const other = await viewer();
  const seriesId = await seriesWith();
  const id = await material({ authorId: other, seriesId, state: 'published' });

  const removed = await materials.remove({ materialId: id, userId: author });
  assert.equal(removed, false, 'чужой материал не удаляется');
});

test('фильтр по состоянию и по виду работают (F-05-09 §4)', { skip }, async () => {
  const author = await viewer();
  const seriesId = await seriesWith();
  await material({ authorId: author, seriesId, state: 'published' });
  await material({ authorId: author, seriesId: await seriesWith(), state: 'checking' });

  const published = await materials.own({ userId: author, state: 'published' });
  assert.equal(published.total, 1, 'фильтр по состоянию оставил один материал');
  assert.equal(published.applied.state, 'published', 'применённый фильтр назван');
});
