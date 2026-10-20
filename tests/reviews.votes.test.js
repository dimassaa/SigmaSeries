// Голос «Полезно» (F-04-06).
//
// Сервис сам решает, кому голосовать: чужой видимый отзыв, не свой (EC-V15),
// и только подтверждённому аккаунту — «Зритель и выше». Идемпотентность
// примитивов (§8) проверяется повторным вызовом: поставить и снять второй
// раз ничего не меняют и не ошибаются.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { pgReviewVotes } from '../src/services/reviews/votes.js';
import { pgReviews } from '../src/services/reviews/store.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';
const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — голоса не проверялись';
const PREFIX = 'review-votes-%';

let pool;
let votes;
let reviews;

/** Человек: подтверждённый адрес — имеет право «Зритель». */
async function viewer() {
  const { hash } = makeToken();
  const nickname = `review-votes-${crypto.randomUUID().slice(0, 8)}`;
  const created = await pgAuthStore(pool).createUser({
    email: `${nickname}@example.com`,
    nickname,
    passwordHash: await hashPassword(PASSWORD),
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  await pool.query('UPDATE e_user SET email_confirmed = TRUE WHERE id = $1', [created.id]);
  return { id: created.id };
}

/** Человек без подтверждения email (вошёл, но не «Зритель»). */
async function unconfirmed() {
  const { hash } = makeToken();
  const nickname = `review-votes-${crypto.randomUUID().slice(0, 8)}`;
  const created = await pgAuthStore(pool).createUser({
    email: `${nickname}@example.com`,
    nickname,
    passwordHash: await hashPassword(PASSWORD),
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: false,
  });
  await pool.query('UPDATE e_user SET email_confirmed = FALSE WHERE id = $1', [created.id]);
  return { id: created.id };
}

/** Сериал с серией: разные номера — чтобы фикстуры не мешались. */
async function seriesWith(number) {
  const { rows: [seriesRow] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Голоса фикстуры', 'Votes fixture', $2, 'published', 'airing', 2024) RETURNING id, slug`,
    [`review-votes-${number}-${crypto.randomUUID().slice(0, 6)}`, 974_000_000 + number],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id',
    [seriesRow.id],
  );
  const { rows: [episode] } = await pool.query(
    `INSERT INTO e_episode (season_id, number, title_ru, runtime_min)
     VALUES ($1, 1, 'Серия', 45) RETURNING id`,
    [season.id],
  );
  return { ...seriesRow, episodeId: episode.id };
}

async function mark(userId, seriesId) {
  await pool.query(
    `INSERT INTO e_watch_mark (user_id, episode_id, precision)
     SELECT $1, e.id, 'exact' FROM e_episode e
       JOIN e_season s ON s.id = e.season_id
      WHERE s.series_id = $2 ORDER BY e.id LIMIT 1
     ON CONFLICT DO NOTHING`,
    [userId, seriesId],
  );
}

async function rate(userId, seriesId, value) {
  await pool.query(
    `INSERT INTO e_rating (user_id, object_type, series_id, value)
     VALUES ($1, 'series', $2, $3)
     ON CONFLICT (user_id, series_id) WHERE object_type = 'series'
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [userId, seriesId, value],
  );
}

const clean = { block: [], allow: [], available: true };

/** Отзыв от имени человека: оценка, отметка и текст одним действием. */
async function write({ user, series, text = 'Отзыв для проверки голосов, длиннее двадцати знаков.', state = null }) {
  await mark(user.id, series.id);
  await rate(user.id, series.id, 8);
  const r = await reviews.submit({
    userId: user.id, seriesId: series.id, body: text, spoiler: false, lang: 'ru', dictionary: clean,
  });
  assert.equal(r.ok, true, `отзыв должен записаться: ${r.reason ?? ''}`);
  const { rows: [material] } = await pool.query(
    `SELECT id FROM e_material WHERE author_id = $1 AND series_id = $2 AND kind = 'review'`,
    [user.id, series.id],
  );
  if (state) {
    await pool.query('UPDATE e_material SET state = $1 WHERE id = $2', [state, material.id]);
  }
  return { ...r, id: Number(material.id) };
}

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
  votes = pgReviewVotes(pool);
  reviews = pgReviews(pool);
});

test.after(async () => {
  if (!pool) return;
  const ids = 'SELECT id FROM e_series WHERE slug LIKE $1';
  // Голоса ссылаются на материалы каскадом — удаляются вместе с ними; явный
  // проход оставлен как в соседних файлах: дерево фикстур читается целиком.
  await pool.query(`DELETE FROM e_helpful_vote WHERE material_id IN (SELECT id FROM e_material WHERE series_id IN (${ids}))`, [PREFIX]);
  await pool.query(`DELETE FROM e_material WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_rating WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_restriction WHERE user_id IN (
    SELECT id FROM e_user WHERE nickname LIKE 'review-votes-%')`);
  await pool.query(`DELETE FROM e_watch_mark WHERE episode_id IN (
    SELECT e.id FROM e_episode e JOIN e_season s ON s.id = e.season_id WHERE s.series_id IN (${ids}))`, [PREFIX]);
  await pool.query(`DELETE FROM e_season WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_series WHERE slug LIKE $1`, [PREFIX]);
  await pool.end();
});

test('поставить голос: счётчик 1; повтор — счётчик не растёт (идемпотентно, §8)', { skip }, async () => {
  const series = await seriesWith(1);
  const author = await viewer();
  const reader = await viewer();
  const review = await write({ user: author, series });

  const first = await votes.set({ userId: reader.id, materialId: review.id, seriesId: series.id });
  assert.equal(first.ok, true, first.reason ?? '');
  assert.equal(first.voted, true);
  assert.equal(first.count, 1, 'счётчик — число, а не строка `count(*)`');

  const again = await votes.set({ userId: reader.id, materialId: review.id, seriesId: series.id });
  assert.equal(again.ok, true);
  assert.equal(again.voted, true);
  assert.equal(again.count, 1, 'повторное «поставить» не дублирует строку');
});

test('снять голос: счётчик 0; повтор — ничего не меняет (идемпотентно, §8)', { skip }, async () => {
  const series = await seriesWith(2);
  const author = await viewer();
  const reader = await viewer();
  const review = await write({ user: author, series });
  await votes.set({ userId: reader.id, materialId: review.id, seriesId: series.id });

  const first = await votes.unset({ userId: reader.id, materialId: review.id, seriesId: series.id });
  assert.equal(first.ok, true, first.reason ?? '');
  assert.equal(first.voted, false);
  assert.equal(first.count, 0);

  const again = await votes.unset({ userId: reader.id, materialId: review.id, seriesId: series.id });
  assert.equal(again.ok, true);
  assert.equal(again.voted, false);
  assert.equal(again.count, 0);
});

test('приёмка: поставил → снял (§18)', { skip }, async () => {
  const series = await seriesWith(3);
  const author = await viewer();
  const reader = await viewer();
  const review = await write({ user: author, series });

  assert.equal((await votes.set({ userId: reader.id, materialId: review.id, seriesId: series.id })).count, 1);
  assert.equal((await votes.unset({ userId: reader.id, materialId: review.id, seriesId: series.id })).count, 0);
});

test('свой отзыв голоса не принимает (EC-V15)', { skip }, async () => {
  const series = await seriesWith(4);
  const author = await viewer();
  const review = await write({ user: author, series });

  const set = await votes.set({ userId: author.id, materialId: review.id, seriesId: series.id });
  assert.equal(set.ok, false);
  assert.equal(set.reason, 'own');
  assert.equal(set.count, 0, 'голос не записан');
});

test('неподтверждённый аккаунт голосовать не может («Зритель и выше»)', { skip }, async () => {
  const series = await seriesWith(5);
  const author = await viewer();
  const newcomer = await unconfirmed();
  const review = await write({ user: author, series });

  const set = await votes.set({ userId: newcomer.id, materialId: review.id, seriesId: series.id });
  assert.equal(set.ok, false);
  assert.equal(set.reason, 'not-confirmed');
});

test('не отзыв (комментарий) и несуществующий материал — отказ, не ошибка', { skip }, async () => {
  const series = await seriesWith(6);
  const author = await viewer();
  const reader = await viewer();
  const review = await write({ user: author, series });

  await pool.query(
    `INSERT INTO e_material (author_id, kind, series_id, body, lang, state)
     VALUES ($1, 'comment', $2, 'Комментарий той же фикстуры.', 'ru', 'published') RETURNING id`,
    [author.id, series.id],
  );
  const { rows: [comment] } = await pool.query(
    `SELECT id FROM e_material WHERE kind = 'comment' AND series_id = $1`, [series.id],
  );
  const kind = await votes.set({ userId: reader.id, materialId: comment.id, seriesId: series.id });
  assert.equal(kind.ok, false);
  assert.equal(kind.reason, 'kind');

  const missing = await votes.set({ userId: reader.id, materialId: comment.id + 10_000_000, seriesId: series.id });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing');
});

test('отзыв, видимый по снимку, голос принимает; скрытый баном — нет', { skip }, async () => {
  const series = await seriesWith(7);
  const author = await viewer();
  const another = await viewer();
  const moderator = await viewer();
  const reader = await viewer();
  const checking = await write({ user: author, series, state: 'checking' });
  await pool.query('UPDATE e_material SET visible_body = $2 WHERE id = $1', [checking.id, 'Прежний видимый текст снимка.']);

  const snapshot = await votes.set({ userId: reader.id, materialId: checking.id, seriesId: series.id });
  assert.equal(snapshot.ok, true, snapshot.reason ?? '');

  const hidden = await write({ user: another, series });
  await pool.query(
    `INSERT INTO e_restriction (user_id, kind, reason, hide_materials, set_by)
     VALUES ($1, 'ban', 'тест', TRUE, $2)`,
    [another.id, moderator.id],
  );
  const banned = await votes.set({ userId: reader.id, materialId: hidden.id, seriesId: series.id });
  assert.equal(banned.ok, false);
  assert.equal(banned.reason, 'missing', 'читатель такого отзыва не видит — для него его нет');
});

test('mine перечисляет только свои голоса', { skip }, async () => {
  const series = await seriesWith(8);
  const a1 = await viewer();
  const a2 = await viewer();
  const reader = await viewer();
  const r1 = await write({ user: a1, series });
  const r2 = await write({ user: a2, series });

  await votes.set({ userId: reader.id, materialId: r1.id, seriesId: series.id });
  const mine = await votes.mine({ userId: reader.id, materialIds: [r1.id, r2.id] });
  assert.deepEqual(mine, [r1.id], 'в ответе — только голосованный id, сосед не приписан');
});

