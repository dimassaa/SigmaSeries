// Обсуждения сериала и комментарии к отзыву (F-05-07).
//
// Проверяется главное: тема создаётся по общему конвейеру модерации, ответ
// виден в теме, а комментарий к отзыву привязан к отзыву и к сериалу.

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { pgDiscussions } from '../src/services/discussions/topics.js';
import { pgAuthStore } from '../src/services/auth/store.js';

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

const skip = CONN ? false : 'нет подключения к базе — обсуждения не проверялись';

// Словарь доступен и пуст: ни одного слова в чёрном списке.
const DICTIONARY = { block: [], allow: [], available: true };

let pool;
let discussions;
let userId;
let seriesId;

test.before(async () => {
  if (!CONN) return;
  pool = new pg.Pool(CONN);
  await pool.query('select 1');
  discussions = pgDiscussions(pool);

  // Пользователь создаётся через хранилище: адрес в базе хранится вслепую,
  // и вставить его вручную нельзя.
  const name = `talk-${crypto.randomUUID().slice(0, 8)}`;
  const account = await pgAuthStore(pool).createUser({
    email: `${name}@example.com`,
    nickname: name,
    passwordHash: 'x',
    tokenHash: crypto.randomUUID(),
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  userId = account.id;

  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, imdb_key, title_ru, title_original, year_start, exit_state, publication_state, reasons, level)
     VALUES ($1, $2, 'Сериал для обсуждений', 'Talk series', 2015, 'ended', 'published', '{}', 'minimum')
     RETURNING id`,
    [`talk-${crypto.randomUUID().slice(0, 8)}`, `tt${crypto.randomUUID().slice(0, 8)}`],
  );
  seriesId = series.id;
});

test.after(async () => {
  if (pool) {
    if (userId) await pool.query('DELETE FROM e_material WHERE author_id = $1', [userId]);
    if (seriesId) await pool.query('DELETE FROM e_series WHERE id = $1', [seriesId]);
    if (userId) await pool.query('DELETE FROM e_user WHERE id = $1', [userId]);
  }
  if (pool) await pool.end();
});

test('тема создаётся и видна в списке сериала (F-05-07 §4)', { skip }, async () => {
  const created = await discussions.createTopic({
    userId,
    seriesId,
    title: 'Стоит ли второй сезон?',
    body: 'После первого сезона захотелось продолжения. Кто уже посмотрел?',
    dictionary: DICTIONARY,
  });
  assert.equal(created.ok, true, 'тема создана');

  const list = await discussions.listForSeries(seriesId, {});
  assert.equal(list.total, 1, 'тема в списке');
  assert.equal(list.rows[0].title, 'Стоит ли второй сезон?');
});

test('короткая тема не создаётся (ugc.topic_min_chars)', { skip }, async () => {
  const result = await discussions.createTopic({
    userId,
    seriesId,
    title: 'Тема',
    body: 'мало',
    dictionary: DICTIONARY,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'short');
});

test('тема без заголовка не создаётся (F-05-07 §4)', { skip }, async () => {
  const result = await discussions.createTopic({
    userId,
    seriesId,
    title: '',
    body: 'Достаточно длинный текст темы, чтобы про проверку.',
    dictionary: DICTIONARY,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'title');
});

test('ответ попадает в тему и виден в ней (F-05-07 §4)', { skip }, async () => {
  const created = await discussions.createTopic({
    userId,
    seriesId,
    title: 'Тема для ответа',
    body: 'Текст темы, достаточной длины, чтобы про проверку словаря.',
    dictionary: DICTIONARY,
  });
  assert.equal(created.ok, true);

  const reply = await discussions.reply({
    userId,
    topicId: created.id,
    body: 'Ответ: посмотрел, и второго сезона не жалею.',
    dictionary: DICTIONARY,
  });
  assert.equal(reply.ok, true, 'ответ создан');

  const topic = await discussions.topic(created.id, { userId });
  assert.equal(topic.posts.length, 1, 'ответ виден в теме');
  assert.equal(topic.posts[0].body, 'Ответ: посмотрел, и второго сезона не жалею.');
});

test('ответ к несуществующей теме отклоняется (F-05-07 §4)', { skip }, async () => {
  const reply = await discussions.reply({
    userId,
    topicId: 99999999,
    body: 'Ответ в никуда: такого ответа ждать нечего.',
    dictionary: DICTIONARY,
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.reason, 'not_found');
});

test('комментарий к отзыву привязан к отзыву и к сериалу (F-05-07, S-10)', { skip }, async () => {
  const { rows: [review] } = await pool.query(
    `INSERT INTO e_material (author_id, kind, series_id, body, spoiler, lang, state, submitted_at)
     VALUES ($1, 'review', $2, 'Отзыв для проверки комментариев под ним.', FALSE, 'ru', 'published', now())
     RETURNING id`,
    [userId, seriesId],
  );

  const added = await discussions.addComment({
    userId,
    reviewId: review.id,
    body: 'Согласен, но второй сезон слабее.',
    dictionary: DICTIONARY,
  });
  assert.equal(added.ok, true, 'комментарий добавлен');

  const comments = await discussions.comments(review.id);
  assert.equal(comments.length, 1, 'комментарий виден под отзывом');

  const { rows: [row] } = await pool.query(
    'SELECT parent_id, series_id FROM e_material WHERE id = $1', [added.id],
  );
  assert.equal(Number(row.parent_id), Number(review.id), 'комментарий привязан к отзыву');
  assert.equal(Number(row.series_id), Number(seriesId), 'у комментария есть цель — сериал');
});
