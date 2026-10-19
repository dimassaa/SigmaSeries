// Отзыв: форма и публикация (F-04-04).
//
// Проверяется хранилище целиком: один отзыв на пару, версии при правке,
// видимость прежней версии, лимиты частоты, мьют, удаление и сохранение
// оценки. HTTP-сторона — в `http.reviews.test.js`.
//
// Каждый тест чистит за собой по своему префиксу slug: файлы идут
// параллельно, и общая уборка сносила бы чужие фикстуры.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { pgReviews, REASONS } from '../src/services/reviews/store.js';
import { pgRatings } from '../src/services/rating/store.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { REVIEW, MODERATION } from '../src/config/settings.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';
const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — отзыв не проверялся';

let pool;
let reviews;
let ratings;
const fixtures = [];

/** Человек: подтверждённый адрес, взрослый аккаунт — проходит все права. */
async function viewer({ confirmed = true, registeredAt = null } = {}) {
  const { hash } = makeToken();
  const email = `review-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const created = await pgAuthStore(pool).createUser({
    email,
    nickname: `review-${crypto.randomUUID().slice(0, 8)}`,
    passwordHash: await hashPassword(PASSWORD),
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  await pool.query(
    'UPDATE e_user SET email_confirmed = $2, registered_at = coalesce($3, registered_at) WHERE id = $1',
    [created.id, confirmed, registeredAt],
  );
  return created.id;
}

/** Отметка просмотра — без неё отзыв писать нельзя, как и оценку (EC-V1). */
async function mark(userId, seriesId) {
  const { rows: [episode] } = await pool.query(
    `SELECT e.id FROM e_episode e JOIN e_season s ON s.id = e.season_id
      WHERE s.series_id = $1 ORDER BY e.id LIMIT 1`,
    [seriesId],
  );
  await pool.query(
    `INSERT INTO e_watch_mark (user_id, episode_id, precision) VALUES ($1, $2, 'exact')
     ON CONFLICT DO NOTHING`,
    [userId, episode.id],
  );
}

/** Сериал с серией и категорией: разные номера — чтобы фикстуры не мешались. */
async function seriesWith(number) {
  fixtures.push(number);
  const { rows: [seriesRow] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Отзыв фикстуры', 'Review fixture', $2, 'published', 'airing', 2024) RETURNING id, slug`,
    [`review-store-${number}-${crypto.randomUUID().slice(0, 6)}`, 970_000_000 + number],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [seriesRow.id],
  );
  const { rows: [episode] } = await pool.query(
    `INSERT INTO e_episode (season_id, number, title_ru, runtime_min)
     VALUES ($1, 1, 'Серия', 45) RETURNING id`, [season.id],
  );
  return { ...seriesRow, episodeId: episode.id };
}

/** Словарь для проверки текста: без базы, чтобы тест не зависел от её содержимого. */
const clean = { block: [], allow: [], available: true };
const dirty = { block: [{ word: 'запрещено', category: 'profanity' }], allow: [], available: true };

const body = (text) => text.padEnd(REVIEW.lenMin, '.');

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
  reviews = pgReviews(pool);
  ratings = pgRatings(pool);
});

test.after(async () => {
  if (!pool) return;
  const prefix = 'review-store-%';
  const ids = `SELECT id FROM e_series WHERE slug LIKE $1`;
  await pool.query(`DELETE FROM e_material WHERE series_id IN (${ids})`, [prefix]);
  await pool.query(`DELETE FROM e_rating WHERE series_id IN (${ids})`, [prefix]);
  await pool.query(`DELETE FROM e_watch_mark WHERE episode_id IN (
    SELECT e.id FROM e_episode e JOIN e_season s ON s.id = e.season_id WHERE s.series_id IN (${ids}))`, [prefix]);
  await pool.query(`DELETE FROM e_season WHERE series_id IN (${ids})`, [prefix]);
  await pool.query(`DELETE FROM e_series WHERE slug LIKE $1`, [prefix]);
  await pool.end();
});

test('чистый текст публикуется сразу', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(1);
  await mark(user, series.id);

  const r = await reviews.submit({
    userId: user, seriesId: series.id, body: body('Хороший сериал, смотрю второй раз'), spoiler: false, lang: 'ru', dictionary: clean,
  });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'published');

  const own = await reviews.ownReview(user, series.id);
  assert.equal(own.state, 'published');
  assert.equal(own.body, body('Хороший сериал, смотрю второй раз'));
});

test('второй отзыв той же пары не создаётся — правка идёт той же строкой', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(2);
  await mark(user, series.id);

  await reviews.submit({ userId: user, seriesId: series.id, body: body('Первый текст отзыва'), dictionary: clean });
  const r = await reviews.submit({ userId: user, seriesId: series.id, body: body('Второй текст отзыва'), dictionary: clean });
  assert.equal(r.ok, true);

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM e_material WHERE author_id = $1 AND series_id = $2`,
    [user, series.id],
  );
  assert.equal(rows[0].n, 1, 'одна строка, а не две');
  const own = await reviews.ownReview(user, series.id);
  assert.equal(own.version, 2);
  assert.equal(own.body, body('Второй текст отзыва'));
});

test('слово из словаря помечает отзыв, но не теряет текст', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(3);
  await mark(user, series.id);

  const text = body('Тут запрещено писать такое');
  const r = await reviews.submit({ userId: user, seriesId: series.id, body: text, dictionary: dirty });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'flagged');
  assert.equal(r.matched[0].category, 'profanity');
  assert.ok(r.matched[0].start >= 0);

  const own = await reviews.ownReview(user, series.id);
  assert.equal(own.state, 'flagged');
  assert.equal(own.body, text, 'текст автора не подменяется');
});

test('правка опубликованного оставляет прежнюю версию видимой до проверки (R-MOD-21)', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(4);
  await mark(user, series.id);

  const first = body('Опубликованный текст');
  await reviews.submit({ userId: user, seriesId: series.id, body: first, spoiler: true, dictionary: clean });
  const second = body('Новый текст с запрещено');
  const r = await reviews.submit({ userId: user, seriesId: series.id, body: second, spoiler: false, dictionary: dirty });

  assert.equal(r.state, 'flagged');
  const own = await reviews.ownReview(user, series.id);
  assert.equal(own.body, second);
  assert.equal(own.visibleBody, first, 'прежняя версия видна читателям');
  assert.equal(own.visibleSpoiler, true, 'метка спойлера прежней версии тоже');
});

test('правка опубликованного, прошедшая проверку, публикует новую версию и снимает прежнюю', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(5);
  await mark(user, series.id);

  await reviews.submit({ userId: user, seriesId: series.id, body: body('Первая версия'), dictionary: clean });
  const r = await reviews.submit({ userId: user, seriesId: series.id, body: body('Вторая версия'), dictionary: clean });
  assert.equal(r.state, 'published');

  const own = await reviews.ownReview(user, series.id);
  assert.equal(own.visibleBody, null, 'прежняя версия больше не нужна');
  assert.equal(own.version, 2);
});

test('повторная правка помеченного отклоняется раньше пяти минут (R-MOD-09)', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(6);
  await mark(user, series.id);

  await reviews.submit({ userId: user, seriesId: series.id, body: body('Тут запрещено'), dictionary: dirty });
  const r = await reviews.submit({ userId: user, seriesId: series.id, body: body('Исправил текст'), dictionary: clean });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASONS.COOLDOWN);
  assert.ok(r.retryAfterSec > 0 && r.retryAfterSec <= REVIEW.recheckMin * 60);

  const own = await reviews.ownReview(user, series.id);
  assert.equal(own.body, body('Тут запрещено'), 'текст не заменился');
});

test('пятиминутный интервал считается от submitted_at, а не от создания', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(7);
  await mark(user, series.id);

  await reviews.submit({ userId: user, seriesId: series.id, body: body('Тут запрещено'), dictionary: dirty });
  await pool.query(
    `UPDATE e_material SET submitted_at = now() - interval '6 minutes'
      WHERE author_id = $1 AND series_id = $2`,
    [user, series.id],
  );
  const r = await reviews.submit({ userId: user, seriesId: series.id, body: body('Исправил текст'), dictionary: clean });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'published');
});

test('словарь недоступен — отзыв ждёт проверки, а не публикуется (F-05-02 а)', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(8);
  await mark(user, series.id);

  const r = await reviews.submit({
    userId: user, seriesId: series.id, body: body('Обычный текст'), dictionary: { block: [], allow: [], available: false },
  });
  assert.equal(r.state, 'checking');
  const own = await reviews.ownReview(user, series.id);
  assert.equal(own.state, 'checking');
});

test('текст без значимых символов отклоняется и ничего не пишет', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(9);
  await mark(user, series.id);

  const r = await reviews.submit({
    userId: user, seriesId: series.id, body: '\u200b'.repeat(REVIEW.lenMin + 10), dictionary: clean,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASONS.EMPTY);

  const own = await reviews.ownReview(user, series.id);
  assert.equal(own, null);
});

test('короткий и длинный текст отклоняются до проверки', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(10);
  await mark(user, series.id);

  const short = await reviews.submit({ userId: user, seriesId: series.id, body: 'коротко', dictionary: clean });
  assert.equal(short.ok, false);
  assert.equal(short.reason, REASONS.SHORT);

  const long = await reviews.submit({
    userId: user, seriesId: series.id, body: 'а'.repeat(REVIEW.lenMax + 1), dictionary: clean,
  });
  assert.equal(long.ok, false);
  assert.equal(long.reason, REASONS.LONG);
});

test('без отметки сериала отзыв не пишется (EC-V1)', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(11);

  const r = await reviews.submit({ userId: user, seriesId: series.id, body: body('Текст без отметки'), dictionary: clean });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASONS.NO_MARK);
});

test('без подтверждённого адреса отзыв не пишется', { skip }, async () => {
  const user = await viewer({ confirmed: false });
  const series = await seriesWith(12);
  await mark(user, series.id);

  const r = await reviews.submit({ userId: user, seriesId: series.id, body: body('Текст без подтверждения'), dictionary: clean });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASONS.NOT_CONFIRMED);
});

test('мьют отклоняет отзыв и называет дату окончания (F-05-08)', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(13);
  await mark(user, series.id);
  await pool.query(
    `INSERT INTO e_restriction (user_id, kind, reason, set_by, expires_at)
     VALUES ($1, 'mute', 'флуд', $1, now() + interval '3 hours')`,
    [user],
  );

  const r = await reviews.submit({ userId: user, seriesId: series.id, body: body('Текст во время мьюта'), dictionary: clean });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASONS.MUTED);
  assert.ok(r.until instanceof Date, 'срок окончания приходит датой');
  assert.equal(await reviews.ownReview(user, series.id), null);
});

test('истёкший мьют не мешает', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(14);
  await mark(user, series.id);
  await pool.query(
    `INSERT INTO e_restriction (user_id, kind, reason, set_by, expires_at)
     VALUES ($1, 'mute', 'флуд', $1, now() - interval '1 hour')`,
    [user],
  );

  const r = await reviews.submit({ userId: user, seriesId: series.id, body: body('После мьюта'), dictionary: clean });
  assert.equal(r.ok, true);
});

test('лимит 10 материалов в час на аккаунт, правки не считаются (R-MOD-10)', { skip }, async () => {
  const user = await viewer({ registeredAt: new Date(Date.now() - 48 * 3600 * 1000) });
  const target = await seriesWith(15);
  await mark(user, target.id);

  // Десять новых отзывов в разные сериалы исчерпывают часовой лимит.
  for (let i = 0; i < MODERATION.materialsPerHour; i++) {
    const other = await seriesWith(1500 + i);
    await mark(user, other.id);
    const r = await reviews.submit({ userId: user, seriesId: other.id, body: body(`Отзыв номер ${i}`), dictionary: clean });
    assert.equal(r.ok, true, `отзыв ${i} должен пройти`);
  }

  // Одиннадцатый новый отзыв упирается в лимит и говорит, когда освободится.
  const blocked = await reviews.submit({ userId: user, seriesId: target.id, body: body('Одиннадцатый'), dictionary: clean });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, REASONS.LIMIT);
  assert.ok(blocked.retryAfterSec > 0 && blocked.retryAfterSec <= 3600);

  // Правка уже написанного — не новая публикация и лимитом не считается.
  const { rows } = await pool.query(
    `SELECT series_id FROM e_material WHERE author_id = $1 AND state <> 'deleted' ORDER BY id LIMIT 1`,
    [user],
  );
  const first = await reviews.submit({
    userId: user, seriesId: rows[0].series_id, body: body('Правка первого отзыва'), dictionary: clean,
  });
  assert.equal(first.ok, true, 'правку лимит не блокирует');
});

test('аккаунт младше суток — три материала в час (R-MOD-10)', { skip }, async () => {
  const user = await viewer({ registeredAt: new Date() });
  for (let i = 0; i < MODERATION.materialsPerHourYoung; i++) {
    const series = await seriesWith(160 + i);
    await mark(user, series.id);
    const r = await reviews.submit({ userId: user, seriesId: series.id, body: body(`Отзыв ${i}`), dictionary: clean });
    assert.equal(r.ok, true, `отзыв ${i} должен пройти`);
  }
  const series = await seriesWith(170);
  await mark(user, series.id);
  const r = await reviews.submit({ userId: user, seriesId: series.id, body: body('Четвёртый'), dictionary: clean });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REASONS.LIMIT);
});

test('удаление отзыва не трогает оценку, а снятие оценки удаляет отзыв (H-75)', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(18);
  await mark(user, series.id);

  await ratings.setSeriesRating({ userId: user, seriesId: series.id, value: 8 });
  await reviews.submit({ userId: user, seriesId: series.id, body: body('Текст отзыва'), dictionary: clean });

  // Удаление отзыва: оценка остаётся.
  await reviews.deleteOwn({ userId: user, seriesId: series.id });
  assert.equal(await reviews.ownReview(user, series.id), null);
  assert.equal((await ratings.ownRating(user, series.id)).value, 8, 'оценка осталась');

  // Новый отзыв и снятие оценки: отзыв уходит вместе с ней.
  await reviews.submit({ userId: user, seriesId: series.id, body: body('Новый отзыв'), dictionary: clean });
  await ratings.removeSeriesRating({ userId: user, seriesId: series.id });
  await reviews.deleteOwn({ userId: user, seriesId: series.id });
  assert.equal(await reviews.ownReview(user, series.id), null);
});

test('после удаления можно написать отзыв заново', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(19);
  await mark(user, series.id);

  await reviews.submit({ userId: user, seriesId: series.id, body: body('Первый отзыв'), dictionary: clean });
  await reviews.deleteOwn({ userId: user, seriesId: series.id });
  const r = await reviews.submit({ userId: user, seriesId: series.id, body: body('Второй отзыв'), dictionary: clean });
  assert.equal(r.ok, true);
  const own = await reviews.ownReview(user, series.id);
  assert.equal(own.version, 1, 'новая строка, а не третья версия старой');
  assert.equal(own.body, body('Второй отзыв'));
});

test('отзыв чужого сериала не виден и не удаляется', { skip }, async () => {
  const author = await viewer();
  const stranger = await viewer();
  const series = await seriesWith(20);
  await mark(author, series.id);
  await reviews.submit({ userId: author, seriesId: series.id, body: body('Текст автора'), dictionary: clean });

  assert.equal(await reviews.ownReview(stranger, series.id), null);
  await reviews.deleteOwn({ userId: stranger, seriesId: series.id });
  assert.ok(await reviews.ownReview(author, series.id), 'чужое удаление ничего не сняло');
});

test('язык сохраняется вместе с текстом (R-I18N-08)', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(21);
  await mark(user, series.id);

  await reviews.submit({ userId: user, seriesId: series.id, body: body('English text of the review'), lang: 'en', dictionary: clean });
  const own = await reviews.ownReview(user, series.id);
  assert.equal(own.lang, 'en');
});

test('язык определяется по письменности, если поле не передано', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(22);
  await mark(user, series.id);

  await reviews.submit({ userId: user, seriesId: series.id, body: body('Текст по-русски'), dictionary: clean });
  assert.equal((await reviews.ownReview(user, series.id)).lang, 'ru');

  await reviews.submit({ userId: user, seriesId: series.id, body: body('Text in English here'), dictionary: clean });
  assert.equal((await reviews.ownReview(user, series.id)).lang, 'en');
});

test('правка не сбрасывает оценку и не создаёт вторую', { skip }, async () => {
  const user = await viewer();
  const series = await seriesWith(23);
  await mark(user, series.id);

  await ratings.setSeriesRating({ userId: user, seriesId: series.id, value: 9 });
  await reviews.submit({ userId: user, seriesId: series.id, body: body('Первый текст'), dictionary: clean });
  await reviews.submit({ userId: user, seriesId: series.id, body: body('Второй текст'), dictionary: clean });

  assert.equal((await ratings.ownRating(user, series.id)).value, 9);
});
