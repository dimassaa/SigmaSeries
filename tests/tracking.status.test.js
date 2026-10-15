// Статус просмотра (F-03-01).
//
// Проверяется против живой базы и против настоящей сессии: правило H-70 живёт
// на стыке двух таблиц, и «работает» оно только когда статус и подписка
// меняются вместе.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';
import { STATUSES, pgWatchStatus } from '../src/services/tracking/status.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — статус просмотра не проверялся';

let pool;
let status;
let store;
let user;

/** Аккаунт и сериал, которых не существовало до прогона. */
async function fixtures() {
  const { token, hash } = makeToken();
  const id = `st-${crypto.randomUUID()}`;
  void token;
  const created = await store.createUser({
    email: `${id}@example.com`,
    nickname: id,
    passwordHash: '$argon2id$заглушка',
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
  });

  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_original, tmdb_id, publication_state, exit_state)
     VALUES ($1, 'Status fixture', $2, 'published', 'airing') RETURNING id, slug`,
    [id, 990000000 + Math.floor(Number(id.slice(-4).replace(/\D/g, '') || 1))],
  );

  return { userId: created.id, seriesId: series.id, slug: series.slug };
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  status = pgWatchStatus(pool);
  store = pgAuthStore(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_watch_status WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)', ['st-%']);
  await pool.query('DELETE FROM e_subscription WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)', ['st-%']);
  await pool.query('DELETE FROM e_series WHERE slug LIKE $1', ['st-%']);
  await pool.query('DELETE FROM e_user WHERE nickname LIKE $1', ['st-%']);
  await pool.end();
});

test('гость не имеет статуса даже если очень хочет', { skip }, async () => {
  const { seriesId } = await fixtures();
  assert.equal(await status.of(null, seriesId), null);
});

test('статус ставится, читается и перестаёт существовать после «Убрать»', { skip }, async () => {
  const { userId, seriesId } = await fixtures();

  assert.equal(await status.of(userId, seriesId), null, 'изначально статуса нет');

  const set = await status.set({ userId, seriesId, status: 'watching' });
  assert.equal(set.ok, true);
  assert.equal((await status.of(userId, seriesId))?.status, 'watching');

  const changed = await status.set({ userId, seriesId, status: 'on_hold' });
  assert.equal(changed.status, 'on_hold');
  assert.equal((await status.of(userId, seriesId))?.status, 'on_hold', 'статус заменяется, а не добавляется');

  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM e_watch_status WHERE user_id = $1 AND series_id = $2',
    [userId, seriesId],
  );
  assert.equal(rows[0].n, 1, 'на пару пользователь–сериал ровно одна строка (EC-T1)');

  await status.remove({ userId, seriesId });
  assert.equal(await status.of(userId, seriesId), null);
});

test('неизвестный статус отвергается, а не записывается (белый список)', { skip }, async () => {
  const { userId, seriesId } = await fixtures();

  const result = await status.set({ userId, seriesId, status: 'не-статус' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown');
  assert.equal(await status.of(userId, seriesId), null, 'в базе мусор не появился');

  for (const value of STATUSES) {
    assert.equal((await status.set({ userId, seriesId, status: value })).ok, true, `${value} принимается`);
  }
});

test('«Смотрю» и «В планах» включают подписку, остальные выключают (H-70)', { skip }, async () => {
  const { userId, seriesId } = await fixtures();

  for (const [statusName, expected] of [
    ['watching', true],
    ['planned', true],
    ['dropped', false],
    ['watched', false],
    ['on_hold', false],
  ]) {
    await status.set({ userId, seriesId, status: statusName });
    const { rows } = await pool.query(
      'SELECT enabled, source FROM e_subscription WHERE user_id = $1 AND series_id = $2 AND kind = $3',
      [userId, seriesId, 'release'],
    );
    assert.equal(rows.length, 1, `подписка создана для статуса ${statusName}`);
    assert.equal(rows[0].enabled, expected, `статус ${statusName} → подписка ${expected ? 'включена' : 'выключена'}`);
    assert.equal(rows[0].source, 'auto', 'автоматика помечена источником — по нему её и узнают');
  }
});

test('ручное выключение переживает смену статуса (EC-T19)', { skip }, async () => {
  const { userId, seriesId } = await fixtures();

  await pool.query(
    `INSERT INTO e_subscription (user_id, series_id, kind, source, enabled)
     VALUES ($1, $2, 'release', 'manual', false)`,
    [userId, seriesId],
  );

  await status.set({ userId, seriesId, status: 'watching' });
  const { rows } = await pool.query(
    'SELECT enabled FROM e_subscription WHERE user_id = $1 AND series_id = $2 AND kind = $3',
    [userId, seriesId, 'release'],
  );
  assert.equal(rows[0].enabled, false, 'человек выключил — автоматика его не включает обратно');
});

test('ручное включение переживает смену статуса (F-03-07 §8)', { skip }, async () => {
  const { userId, seriesId } = await fixtures();

  await pool.query(
    `INSERT INTO e_subscription (user_id, series_id, kind, source, enabled)
     VALUES ($1, $2, 'release', 'manual', true)`,
    [userId, seriesId],
  );

  await status.set({ userId, seriesId, status: 'dropped' });
  const { rows } = await pool.query(
    'SELECT enabled FROM e_subscription WHERE user_id = $1 AND series_id = $2 AND kind = $3',
    [userId, seriesId, 'release'],
  );
  assert.equal(rows[0].enabled, true, 'человек включил вручную — статус его не выключает');
});

test('снятый с публикации сериал статус не принимает, но и не теряет (EC-T8)', { skip }, async () => {
  const { userId, seriesId } = await fixtures();
  await status.set({ userId, seriesId, status: 'watching' });

  await pool.query("UPDATE e_series SET archived_at = now() WHERE id = $1", [seriesId]);
  try {
    const result = await status.set({ userId, seriesId, status: 'dropped' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'archived', 'снятый сериал — это не ошибка, а отказ менять');
    assert.equal((await status.of(userId, seriesId))?.status, 'watching',
      'прежний статус сохранился: сериал убирают из закладок кнопкой, а не сменой статуса');
  } finally {
    await pool.query('UPDATE e_series SET archived_at = NULL WHERE id = $1', [seriesId]);
  }
});

test('«Убрать» выключает автоматическую подписку и не трогает отметки серий', { skip }, async () => {
  const { userId, seriesId } = await fixtures();
  await status.set({ userId, seriesId, status: 'watching' });

  const { rows: [episode] } = await pool.query(
    `SELECT e.id FROM e_episode e
       JOIN e_season se ON se.id = e.season_id
      WHERE se.series_id = $1 AND e.number > 0 LIMIT 1`,
    [seriesId],
  );
  if (episode) {
    await pool.query(
      `INSERT INTO e_watch_mark (user_id, episode_id, precision) VALUES ($1, $2, 'exact')`,
      [userId, episode.id],
    );
  }

  await status.remove({ userId, seriesId });

  const { rows } = await pool.query(
    'SELECT enabled FROM e_subscription WHERE user_id = $1 AND series_id = $2 AND kind = $3',
    [userId, seriesId, 'release'],
  );
  assert.equal(rows[0].enabled, false, 'сериал убран из закладок — подписка на выходы ему не нужна');

  if (episode) {
    const marks = await pool.query('SELECT count(*)::int AS n FROM e_watch_mark WHERE user_id = $1', [userId]);
    assert.equal(marks.rows[0].n, 1, 'отметки серий остались: вернувшись, человек не отмечает заново');
  }
});

test('список закладок отдаёт счётчики по статусам, а не по выборке', { skip }, async () => {
  const first = await fixtures();
  const second = await fixtures();

  await status.set({ userId: first.userId, seriesId: first.seriesId, status: 'watching' });
  await status.set({ userId: first.userId, seriesId: second.seriesId, status: 'planned' });

  const list = await status.listOf(first.userId);
  assert.equal(list.total, 2);
  assert.equal(list.counts.watching, 1);
  assert.equal(list.counts.planned, 1);
  assert.equal(list.counts.dropped, 0);
  assert.deepEqual(list.rows.map((row) => row.series_id).sort(), [first.seriesId, second.seriesId].sort());

  // Порядок по умолчанию — «недавно изменённые». Порядок строк с одинаковым
  // `changed_at` (обе строки записаны в одну секунду) не проверяется: он не
  // задан и менялся бы от прогона к прогону.
  const stamps = list.rows.map((row) => row.changed_at);
  assert.deepEqual(stamps, [...stamps].sort().reverse(), 'сначала изменённые позже');
});