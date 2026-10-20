// Жалоба на отзыв (F-04-07).
//
// Сервис решает всё: кто жалуется (подтверждённый, не на свой отзыв), что
// жалоба единственная на пару пользователь–материал (EC-V16) и когда материал
// скрывается по порогу (R-MOD-16, переход «Опубликован → Помечен», STATES §1).
// Повторы одного человека порог не двигают: порог считают по разным людям.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { pgReviewReports } from '../src/services/reviews/reports.js';
import { pgReviews } from '../src/services/reviews/store.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';
const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — жалобы не проверялись';
const PREFIX = 'review-reports-%';

let pool;
let reports;
let reviews;

/** Человек: подтверждённый адрес — имеет право «Зритель». */
async function viewer() {
  const { hash } = makeToken();
  const nickname = `review-reports-${crypto.randomUUID().slice(0, 8)}`;
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
  const nickname = `review-reports-${crypto.randomUUID().slice(0, 8)}`;
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
     VALUES ($1, 'Голоса фикстуры', 'Reports fixture', $2, 'published', 'airing', 2024) RETURNING id, slug`,
    [`review-reports-${number}-${crypto.randomUUID().slice(0, 6)}`, 975_000_000 + number],
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

const clean = { block: [], allow: [] };

/** Отзыв от имени человека: оценка, отметка и текст одним действием. */
async function write({ user, series, text = 'Отзыв для проверки жалоб, длиннее двадцати знаков.', state = null }) {
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

/** Материал-не-отзыв: комментарий виден, но жалоба на него невозможна по виду. */
async function commentMaterial({ user, series }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO e_material (author_id, kind, series_id, body, state)
     VALUES ($1, 'comment', $2, 'Комментарий фикстуры', 'published') RETURNING id`,
    [user.id, series.id],
  );
  return Number(row.id);
}

const countReports = async (materialId) => {
  const { rows: [row] } = await pool.query(
    'SELECT count(*)::int AS n FROM e_report WHERE material_id = $1', [materialId],
  );
  return row.n;
};

async function materialState(materialId) {
  const { rows: [row] } = await pool.query(
    'SELECT state, visible_body, visible_spoiler FROM e_material WHERE id = $1', [materialId],
  );
  return row;
}

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
  reports = pgReviewReports(pool);
  reviews = pgReviews(pool);
});

test.after(async () => {
  if (!pool) return;
  const ids = 'SELECT id FROM e_series WHERE slug LIKE $1';
  // Жалобы ссылаются на материалы каскадом — удаляются вместе с ними; явный
  // проход оставлен как в соседних файлах: дерево фикстур читается целиком.
  await pool.query(`DELETE FROM e_report WHERE material_id IN (SELECT id FROM e_material WHERE series_id IN (${ids}))`, [PREFIX]);
  await pool.query(`DELETE FROM e_helpful_vote WHERE material_id IN (SELECT id FROM e_material WHERE series_id IN (${ids}))`, [PREFIX]);
  await pool.query(`DELETE FROM e_material WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_rating WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_restriction WHERE user_id IN (
    SELECT id FROM e_user WHERE nickname LIKE 'review-reports-%')`);
  await pool.query(`DELETE FROM e_watch_mark WHERE episode_id IN (
    SELECT e.id FROM e_episode e JOIN e_season s ON s.id = e.season_id WHERE s.series_id IN (${ids}))`, [PREFIX]);
  await pool.query(`DELETE FROM e_season WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_series WHERE slug LIKE $1`, [PREFIX]);
  await pool.end();
});

test('подать жалобу: строка открыта, причина и комментарий сохранены, скрытия нет', { skip }, async () => {
  const series = await seriesWith(1);
  const author = await viewer();
  const reporter = await viewer();
  const review = await write({ user: author, series });

  const result = await reports.submit({
    userId: reporter.id, materialId: review.id, seriesId: series.id,
    reason: 'spoiler', comment: 'Спойлер последней серии без пометки',
  });
  assert.equal(result.ok, true, result.reason ?? '');
  assert.equal(result.reported, true);
  assert.equal(result.hidden, false, 'одна жалоба порога не достигает');

  const { rows: [row] } = await pool.query(
    'SELECT reason, comment, state FROM e_report WHERE user_id = $1 AND material_id = $2',
    [reporter.id, review.id],
  );
  assert.equal(row.reason, 'spoiler');
  assert.equal(row.comment, 'Спойлер последней серии без пометки');
  assert.equal(row.state, 'open');
});

test('повторная жалоба того же человека — «уже подано», без второй строки (EC-V16)', { skip }, async () => {
  const series = await seriesWith(2);
  const author = await viewer();
  const reporter = await viewer();
  const review = await write({ user: author, series });
  await reports.submit({ userId: reporter.id, materialId: review.id, seriesId: series.id, reason: 'spam' });

  const again = await reports.submit({
    userId: reporter.id, materialId: review.id, seriesId: series.id, reason: 'other', comment: 'другая причина',
  });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already');
  assert.equal(await countReports(review.id), 1, 'повторная жалоба не пишет вторую строку');
});

test('повторы одного человека не двигают порог: порог считается по разным податчикам', { skip }, async () => {
  const series = await seriesWith(3);
  const author = await viewer();
  const first = await viewer();
  const second = await viewer();
  const review = await write({ user: author, series });

  for (const who of [first, second]) {
    await reports.submit({ userId: who.id, materialId: review.id, seriesId: series.id, reason: 'offtopic' });
    const again = await reports.submit({ userId: who.id, materialId: review.id, seriesId: series.id, reason: 'offtopic' });
    assert.equal(again.ok, false);
  }
  const state = await materialState(review.id);
  assert.equal(state.state, 'published', 'два человека с повторами порога не достигают');
});

test('третий человек жалуется: материал помечен и снимок правки очищен (R-MOD-16)', { skip }, async () => {
  const series = await seriesWith(4);
  const author = await viewer();
  const a = await viewer();
  const b = await viewer();
  const c = await viewer();
  const review = await write({ user: author, series });
  await reports.submit({ userId: a.id, materialId: review.id, seriesId: series.id, reason: 'spam' });
  await reports.submit({ userId: b.id, materialId: review.id, seriesId: series.id, reason: 'spam' });

  const third = await reports.submit({ userId: c.id, materialId: review.id, seriesId: series.id, reason: 'spam' });
  assert.equal(third.ok, true, third.reason ?? '');
  assert.equal(third.hidden, true, 'третий податчик закрывает порог');

  const state = await materialState(review.id);
  assert.equal(state.state, 'flagged', 'переход «Опубликован → Помечен» (STATES §1)');
  assert.equal(state.visible_body, null, 'скрытие заметает и видимую версию тела');
  assert.equal(state.visible_spoiler, false);
});

test('разрешённая редактором жалоба не двигает порог: нужны три новые (решение автора)', { skip }, async () => {
  const series = await seriesWith(12);
  const author = await viewer();
  const a = await viewer();
  const b = await viewer();
  const fresh = await viewer();
  const review = await write({ user: author, series });

  // Разрешённые жалобы вносятся прямо в таблицу: разбор жалоб построит M5,
  // а правило порога проверяется уже сейчас — проверка решает и за M5.
  for (const who of [a, b]) {
    await pool.query(
      `INSERT INTO e_report (user_id, material_id, reason, state)
       VALUES ($1, $2, 'spam', 'resolved')`,
      [who.id, review.id],
    );
  }

  const only = await reports.submit({
    userId: fresh.id, materialId: review.id, seriesId: series.id, reason: 'spam',
  });
  assert.equal(only.ok, true);
  assert.equal(only.hidden, false, 'две разрешённые + одна открытая порога не закрывают');
  const state = await materialState(review.id);
  assert.equal(state.state, 'published', 'материал остаётся видимым');
  assert.equal(await countReports(review.id), 3, 'строки разрешённых лежат, скоростных скрытий нет');
});

test('повторная жалоба после порога молчит вежливо и не переходит дважды', { skip }, async () => {
  const series = await seriesWith(5);
  const author = await viewer();
  const a = await viewer();
  const b = await viewer();
  const c = await viewer();
  const review = await write({ user: author, series });
  await reports.submit({ userId: a.id, materialId: review.id, seriesId: series.id, reason: 'offtopic' });
  await reports.submit({ userId: b.id, materialId: review.id, seriesId: series.id, reason: 'offtopic' });
  await reports.submit({ userId: c.id, materialId: review.id, seriesId: series.id, reason: 'offtopic' });

  const firstAgain = await reports.submit({ userId: a.id, materialId: review.id, seriesId: series.id, reason: 'offtopic' });
  assert.equal(firstAgain.ok, false);
  assert.equal(firstAgain.reason, 'already');

  const state = await materialState(review.id);
  assert.equal(state.state, 'flagged', 'состояние «Помечен» — уже поставлено третьим, повтор ничего не меняет');
});

test('жалоба на материал правки на проверке: снимок очищается, отзыв скрыт до решения', { skip }, async () => {
  const series = await seriesWith(6);
  const author = await viewer();
  const a = await viewer();
  const b = await viewer();
  const c = await viewer();
  const review = await write({ user: author, series });
  await pool.query(
    `UPDATE e_material SET state = 'checking', visible_body = 'Старая версия, видная читателям'
      WHERE id = $1`, [review.id],
  );

  await reports.submit({ userId: a.id, materialId: review.id, seriesId: series.id, reason: 'harassment' });
  await reports.submit({ userId: b.id, materialId: review.id, seriesId: series.id, reason: 'harassment' });
  const third = await reports.submit({ userId: c.id, materialId: review.id, seriesId: series.id, reason: 'harassment' });

  assert.equal(third.ok, true);
  assert.equal(third.hidden, true);
  const state = await materialState(review.id);
  assert.equal(state.state, 'flagged');
  assert.equal(state.visible_body, null, 'R-MOD-16 сильнее снимка правки: читатель не видит ничего до решения');
});

test('жалоба на свой отзыв отклонена (не на свой отзыв, F-04-07 §2)', { skip }, async () => {
  const series = await seriesWith(7);
  const author = await viewer();
  const review = await write({ user: author, series });

  const result = await reports.submit({
    userId: author.id, materialId: review.id, seriesId: series.id, reason: 'other',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'own');
  assert.equal(await countReports(review.id), 0);
});

test('неподтверждённый аккаунт не жалуется — не «Зритель»', { skip }, async () => {
  const series = await seriesWith(8);
  const author = await viewer();
  const stranger = await unconfirmed();
  const review = await write({ user: author, series });

  const result = await reports.submit({
    userId: stranger.id, materialId: review.id, seriesId: series.id, reason: 'other',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-confirmed');
  assert.equal(await countReports(review.id), 0);
});

test('сериал из адреса: чужая витрина не жалуется на чужой отзыв', { skip }, async () => {
  const series = await seriesWith(9);
  const other = await seriesWith(10);
  const author = await viewer();
  const stranger = await viewer();
  const review = await write({ user: author, series });

  const result = await reports.submit({
    userId: stranger.id, materialId: review.id, seriesId: other.id, reason: 'other',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing');
  assert.equal(await countReports(review.id), 0);
});

test('не отзыв и не существующий: жалоба отклонена по виду, затем по существованию', { skip }, async () => {
  const series = await seriesWith(11);
  const author = await viewer();
  const stranger = await viewer();
  const comment = await commentMaterial({ user: author, series });

  const byKind = await reports.submit({
    userId: stranger.id, materialId: comment, seriesId: series.id, reason: 'other',
  });
  assert.equal(byKind.ok, false);
  assert.equal(byKind.reason, 'kind');

  const byMissing = await reports.submit({
    userId: stranger.id, materialId: 9_999_999, seriesId: series.id, reason: 'other',
  });
  assert.equal(byMissing.ok, false);
  assert.equal(byMissing.reason, 'missing');
});
