// Персональные рекомендации (M11, F-11-01, F-11-03).
//
// Проверяется главное: у каждой рекомендации есть причина, отмеченное не
// предлагается, скрытое не возвращается, а при малой истории строки нет.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgRecommendations } from '../src/services/recommendations/reco.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — рекомендации не проверялись';

let pool;
let reco;
let userId;
let episodes = [];
let genres = [];

test.before(async () => {
  if (!available) return;
  pool = createPool();
  reco = pgRecommendations(pool);

  const { rows: users } = await pool.query(
    `SELECT u.id FROM e_user u
      WHERE u.status = 'active' AND u.email_confirmed
        AND NOT EXISTS (SELECT 1 FROM e_role_assignment r WHERE r.user_id = u.id)
      ORDER BY u.id LIMIT 1 OFFSET 1`,
  );
  userId = users[0]?.id;
  assert.ok(userId, 'есть активный пользователь');

  const { rows: eps } = await pool.query(
    `SELECT e.id FROM e_episode e
       JOIN e_season sn ON sn.id = e.season_id
       JOIN e_series s ON s.id = sn.series_id
      WHERE s.publication_state = 'published'
      ORDER BY e.id LIMIT 80`,
  );
  episodes = eps.map((row) => Number(row.id));
  assert.ok(episodes.length >= 20, 'есть серии для отметок');

  const { rows: g } = await pool.query(
    `SELECT sg.genre_code, count(*)::int AS n
       FROM e_series_genre sg
       JOIN e_series s ON s.id = sg.series_id
      WHERE s.publication_state = 'published'
      GROUP BY sg.genre_code ORDER BY n DESC LIMIT 1`,
  );
  genres = g.map((row) => row.genre_code);
  assert.ok(genres.length, 'есть жанры каталога');

  await pool.query('DELETE FROM e_watch_mark WHERE user_id = $1 AND episode_id = ANY($2::bigint[])',
    [userId, episodes]);
  // Демо-оценки тоже считаются историей, а для проверки «мало истории» их
  // быть не должно: демо-данные ставятся отдельно и помечены.
  await pool.query('DELETE FROM e_rating WHERE user_id = $1 AND is_demo', [userId]);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_watch_mark WHERE user_id = $1 AND episode_id = ANY($2::bigint[])',
    [userId, episodes]);
  await pool.query('DELETE FROM e_reco_dismiss WHERE user_id = $1', [userId]);
  await pool.end();
});

/** Ставит точные отметки на серии из указанного жанра. */
async function mark(seriesIds, count) {
  const { rows } = await pool.query(
    `SELECT e.id FROM e_episode e
       JOIN e_season sn ON sn.id = e.season_id
      WHERE sn.series_id = ANY($1::bigint[])
      ORDER BY e.id LIMIT $2`,
    [seriesIds, count],
  );
  for (const row of rows) {
    await pool.query(
      `INSERT INTO e_watch_mark (user_id, episode_id, marked_at, precision)
       VALUES ($1, $2, now(), 'exact')
       ON CONFLICT DO NOTHING`,
      [userId, row.id],
    );
  }
}

/** Сериалы жанра — источник и отметок, и кандидатов. */
async function seriesOfGenre(limit) {
  const { rows } = await pool.query(
    `SELECT s.id FROM e_series s
       JOIN e_series_genre sg ON sg.series_id = s.id
      WHERE sg.genre_code = $1 AND s.publication_state = 'published'
      ORDER BY s.id LIMIT $2`,
    [genres[0], limit],
  );
  return rows.map((row) => Number(row.id));
}

test('мало истории — персональной строки нет', { skip }, async () => {
  const result = await reco.forUser(userId);
  assert.equal(result.personalized, false, 'при восьми отметках строки нет');
  assert.equal(result.items.length, 0);
});

test('у каждой рекомендации есть причина', { skip }, async () => {
  const own = await seriesOfGenre(20);
  await mark(own, 12);

  const result = await reco.forUser(userId, { force: true });
  assert.ok(result.personalized, 'строка появилась');
  assert.ok(result.items.length > 0, 'есть рекомендации');
  for (const item of result.items) {
    assert.ok(item.reason, 'у позиции есть причина');
    assert.ok(['like', 'genre', 'marked'].includes(item.reason.kind));
    assert.ok(item.reason.titleRu, 'причина называет конкретное');
  }
});

test('отмеченное не предлагается', { skip }, async () => {
  const own = await seriesOfGenre(20);
  const { rows } = await pool.query(
    `SELECT s.slug FROM e_series s WHERE s.id = ANY($1::bigint[])`,
    [own],
  );
  const marked = new Set(rows.map((row) => row.slug));

  const result = await reco.forUser(userId, { force: true });
  for (const item of result.items) {
    assert.ok(!marked.has(item.slug), 'отмеченный сериал не рекомендован');
  }
});

test('скрытый сериал не возвращается', { skip }, async () => {
  const result = await reco.forUser(userId, { force: true });
  const first = result.items[0];
  assert.ok(first, 'есть что скрывать');

  const hidden = await reco.dismiss(userId, first.slug);
  assert.equal(hidden, true, 'сериал скрыт');

  const after = await reco.forUser(userId, { force: true });
  assert.ok(!after.items.some((item) => item.slug === first.slug),
    'скрытый сериал не вернулся');
});
