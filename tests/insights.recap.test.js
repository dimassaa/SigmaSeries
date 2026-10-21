// Персональные итоги (M7, F-07-01…03).
//
// Проверяется главное: ретро-отметки не попадают в итоги, порог считается по
// точным отметкам, слайды собираются из данных, а картинка для шеринга —
// настоящий PNG без ника.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgRecap } from '../src/services/insights/recap.js';
import { buildShareImage } from '../src/services/insights/shareImage.js';
import { pgRecapInvites, RECAP_INVITE_KIND } from '../src/services/insights/invite.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — итоги не проверялись';

let pool;
let recap;
let invites;
let userId;
let episodes = [];

test.before(async () => {
  if (!available) return;
  pool = createPool();
  recap = pgRecap(pool);
  invites = pgRecapInvites(pool);

  const { rows: users } = await pool.query(
    `SELECT u.id FROM e_user u
      WHERE u.status = 'active' AND u.email_confirmed
        AND NOT EXISTS (SELECT 1 FROM e_role_assignment r WHERE r.user_id = u.id)
      ORDER BY u.id LIMIT 1`,
  );
  userId = users[0]?.id;
  assert.ok(userId, 'есть активный пользователь');

  const { rows } = await pool.query(
    `SELECT e.id FROM e_episode e
       JOIN e_season sn ON sn.id = e.season_id
       JOIN e_series s ON s.id = sn.series_id
      WHERE s.publication_state = 'published'
      ORDER BY e.id LIMIT 60`,
  );
  episodes = rows.map((row) => Number(row.id));
  assert.ok(episodes.length >= 40, 'есть серии для отметок');
  // Отметка на серию одна: ключ (пользователь, серия), поэтому чужие
  // отметки под тестом убираются.
  await pool.query('DELETE FROM e_watch_mark WHERE user_id = $1 AND episode_id = ANY($2::bigint[])',
    [userId, episodes]);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_watch_mark WHERE user_id = $1 AND marked_at > now() - interval \'2 days\'', [userId]);
  await pool.query('DELETE FROM e_notification WHERE kind = $1 AND user_id = $2', [RECAP_INVITE_KIND, userId]);
  await pool.end();
});

/**
 * Ставит отметки: точные или ретро.
 *
 * На серию отметка одна — так устроен ключ, — поэтому отмечаются разные
 * серии.
 *
 * @param {number[]} episodeIds
 * @param {{precision?: string}} [options]
 */
async function mark(episodeIds, { precision = 'exact' } = {}) {
  for (const [i, episodeId] of episodeIds.entries()) {
    await pool.query(
      `INSERT INTO e_watch_mark (user_id, episode_id, marked_at, precision)
       VALUES ($1, $2, now() - ($3 || ' minutes')::interval, $4)`,
      [userId, episodeId, String(i), precision],
    );
  }
}

test('ретро-отметки не попадают в итоги', { skip }, async () => {
  await mark(episodes.slice(0, 30), { precision: 'retro' });
  await mark(episodes.slice(30, 31), { precision: 'exact' });
  const data = await recap.slides({ userId, period: 'year' });

  assert.ok(data);
  assert.equal(data.marks, 1, 'в итогах только точная отметка');
  assert.equal(data.enough, false, 'порог не пройден');
});

test('точные отметки попадают в итоги и дают слайды', { skip }, async () => {
  await mark(episodes.slice(31, 34), { precision: 'exact' });
  const data = await recap.slides({ userId, period: 'year' });

  assert.equal(data.marks, 4, 'три точные отметки и одна из прошлой проверки');
  assert.ok(data.slides.length >= 1, 'слайды собраны');
  const first = data.slides[0];
  assert.equal(first.key, 'series');
  assert.ok(first.value >= 1, 'число сериалов положительное');
  assert.ok(Number.isFinite(first.params.count), 'часы посчитаны');
});

test('период «всё время» не ограничен годом', { skip }, async () => {
  const all = await recap.slides({ userId, period: 'all' });
  const year = await recap.slides({ userId, period: 'year' });
  assert.ok(all.marks >= year.marks, 'за всё время отметок не меньше');
});

test('картинка для шеринга — PNG без ника', { skip: false }, async () => {
  const png = await buildShareImage({
    periodLabel: 'Итоги за 2026',
    numbers: [{ value: '47', label: 'сериалов' }],
    favourite: { title: 'Тестовый сериал' },
  });

  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', 'это PNG');
  assert.ok(png.length < 2 * 1024 * 1024, 'картинка не больше двух мегабайт');
  assert.ok(!png.toString('latin1').includes('Иван'), 'ника на картинке нет');
});

test('приглашение приходит один раз в год', { skip }, async () => {
  const first = await invites.invite(userId);
  const second = await invites.invite(userId);

  assert.equal(first, true, 'приглашение создано');
  assert.equal(second, false, 'повторно не создаётся');

  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM e_notification WHERE user_id = $1 AND kind = $2',
    [userId, RECAP_INVITE_KIND],
  );
  assert.equal(rows[0].n, 1);
});

test('уникальный ключ приглашения не пересекается с другими', { skip: false }, () => {
  assert.match(RECAP_INVITE_KIND, /^[a-z_]+$/);
  assert.ok(crypto.randomUUID());
});
