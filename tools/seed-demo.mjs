// Демонстрационные аккаунты и материалы для показа.
//
//   PGDATABASE=serial_tracker node tools/seed-demo.mjs
//
// Скрипт идемпотентен: повторный запуск не создаёт дублей — пользователи
// находятся по нику, отзывы и руководство проверяются по автору и сериалу.
// Пароли печатаются один раз; роли выдаются с тем же сроком, что у демо-базы.

import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { hashPassword } from '../src/services/auth/password.js';
import { pgRatings } from '../src/services/rating/store.js';
import { pgMarks } from '../src/services/tracking/marks.js';
import { pgWatchStatus } from '../src/services/tracking/status.js';
import { pgReviews } from '../src/services/reviews/store.js';
import { pgGuides } from '../src/services/guides/service.js';

const PASSWORD = 'DemoPass-2026';
const DICTIONARY = { block: [], allow: [], available: true };

const ACCOUNTS = [
  { nickname: 'Анна', email: 'demo-anna@example.com', role: null },
  { nickname: 'Игорь', email: 'demo-igor@example.com', role: null },
  { nickname: 'Редактор', email: 'demo-editor@example.com', role: 'editor' },
  { nickname: 'Аналитик', email: 'demo-analyst@example.com', role: 'analyst' },
  { nickname: 'Администратор', email: 'demo-admin@example.com', role: 'admin' },
];

const pool = createPool();
const store = pgAuthStore(pool);
const ratings = pgRatings(pool);
const marks = pgMarks(pool);
const statuses = pgWatchStatus(pool);
const reviews = pgReviews(pool);
const guides = pgGuides(pool);

const reviewTexts = [
  'Сильный сериал, который держит внимание с первой серии. Отдельно отмечу работу оператора и музыку: атмосфера не отпускает до финала. Пересматривать точно буду, и не один раз.',
  'Сюжет развивается неспешно, но каждая линия в итоге закрывается. Персонажи живые, диалоги не звучат как пересказ сценария. Для вечернего просмотра — то, что нужно.',
  'Начал смотреть из любопытства и затянуло. Есть провисания в середине сезона, но финал компенсирует всё. Рекомендую тем, кто любит длинные истории с характерами.',
  'Хорошая работа с деталями: мелочи, которые вначале кажутся фоном, потом складываются в общую картину. После просмотра осталось желание обсудить финал с кем-то ещё.',
  'Атмосферный и визуально аккуратный сериал. Не пытается удивить любой ценой, но рассказывает историю честно. Понравилось, как раскрыли второго плана героев.',
];

const guideText = [
  '## С чего начать',
  'Выберите сериал в каталоге и откройте его карточку. Посмотрите описание, рейтинги и список серий, затем добавьте сериал в планы или начните смотреть: статус сохраняется в библиотеке и влияет на подборки.',
  '## Как отмечать просмотр',
  'Отмечайте вышедшие серии на странице сезона — прогресс и следующая серия появятся в карточке. Если серия ещё не вышла, отметка недоступна; для будущих серий работает подписка на уведомления.',
  '## Оценки и отзывы',
  'Оценка ставится по шкале от 1 до 10. Отзыв содержит оценку и текст, после проверки он появляется на странице сериала. Оценки участвуют в рейтинге сайта только при достаточном числе голосов.',
  '## Календарь и рекомендации',
  'Календарь показывает выходы по месяцам с учётом часового пояса из профиля; переключайтесь между месяцем, неделей и списком. Рекомендации строятся по вашим жанрам и отметкам, у каждой карточки указана причина выбора.',
].join('\n');

async function ensureUser(account) {
  const { rows: [existing] } = await pool.query(
    'SELECT id, nickname FROM e_user WHERE nickname = $1', [account.nickname]);
  if (existing) return existing.id;

  const user = await store.createUser({
    email: account.email,
    nickname: account.nickname,
    passwordHash: await hashPassword(PASSWORD),
    tokenHash: crypto.randomBytes(24).toString('base64url'),
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'system',
  });
  await pool.query('UPDATE e_user SET email_confirmed = TRUE, status = $2 WHERE id = $1',
    [user.id, 'active']);
  return user.id;
}

async function ensureRole(userId, role) {
  if (!role) return;
  const { rows } = await pool.query(
    `SELECT 1 FROM e_role_assignment WHERE user_id = $1 AND role = $2
      AND (expires_at IS NULL OR expires_at > now())`, [userId, role]);
  if (rows.length) return;
  const expiresAt = role === 'admin' ? null : new Date(Date.now() + 365 * 24 * 3600 * 1000);
  await store.assignRole({ userId, role, expiresAt, reason: 'демонстрационные данные' });
}

async function seriesForDemo() {
  const { rows } = await pool.query(`
    SELECT s.id, s.slug, s.title_ru
      FROM e_series s
      JOIN e_external_rating r ON r.series_id = s.id AND r.platform = 'imdb'
     WHERE s.publication_state = 'published' AND s.archived_at IS NULL
       AND EXISTS (SELECT 1 FROM e_image i WHERE i.series_id = s.id AND i.role = 'poster')
       AND EXISTS (SELECT 1 FROM e_season se JOIN e_episode e ON e.season_id = se.id
                    WHERE se.series_id = s.id)
     ORDER BY r.votes DESC NULLS LAST, s.id
     LIMIT 8`);
  return rows;
}

async function firstAiredEpisodes(seriesId, limit = 3) {
  const { rows } = await pool.query(`
    SELECT e.id
      FROM e_episode e
      JOIN e_season se ON se.id = e.season_id
      JOIN e_release r ON r.season_id = se.id
      LEFT JOIN e_release_episode rel ON rel.release_id = r.id AND rel.episode_id = e.id
     WHERE se.series_id = $1
       AND r.release_date <= CURRENT_DATE
     GROUP BY e.id
     ORDER BY min(r.release_date), e.number
     LIMIT $2`, [seriesId, limit]);
  return rows.map((row) => Number(row.id));
}

async function ensureReview(userId, seriesId, text) {
  const { rows } = await pool.query(
    `SELECT 1 FROM e_material
      WHERE author_id = $1 AND series_id = $2 AND kind = 'review' AND state <> 'deleted'`,
    [userId, seriesId]);
  if (rows.length) return;
  const result = await reviews.submit({ userId, seriesId, body: text, dictionary: DICTIONARY });
  const created = /** @type {{ok: boolean, state?: string, id?: number}} */ (result);
  if (created.ok && created.state !== 'published' && created.id) {
    await pool.query("UPDATE e_material SET state = 'published' WHERE id = $1", [created.id]);
  }
}

async function ensureGuide(userId, seriesId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM e_material
      WHERE author_id = $1 AND kind = 'guide' AND state <> 'deleted' LIMIT 1`, [userId]);
  if (rows.length) return;
  const result = await guides.submit({
    userId, seriesId, title: 'Как смотреть сериалы в SigmaSeries', text: guideText,
    dictionary: DICTIONARY,
  });
  if (result.ok && result.state !== 'published') {
    await pool.query("UPDATE e_material SET state = 'published' WHERE id = $1", [result.id]);
  }
}

const ids = {};
for (const account of ACCOUNTS) {
  ids[account.nickname] = await ensureUser(account);
  await ensureRole(ids[account.nickname], account.role);
}

const series = await seriesForDemo();
if (!series.length) {
  console.log('В каталоге нет опубликованных сериалов с постерами — сначала выполните импорт.');
  await pool.end();
  process.exit(1);
}

// Оценки, статусы и отметки: без отметки отзыв не принимается.
for (const [index, row] of series.entries()) {
  const value = 10 - (index % 3);
  for (const nickname of ['Анна', 'Игорь']) {
    const userId = ids[nickname];
    const episodes = await firstAiredEpisodes(row.id, 3);
    for (const episodeId of episodes) {
      await marks.setMark({ userId, episodeId, on: true });
    }
    // Оценка ставится после отметки: без просмотренной серии сервис её не примет.
    const own = await ratings.ownRating(userId, row.id);
    if (!own) await ratings.setSeriesRating({ userId, seriesId: row.id, value });
    await statuses.set({
      userId, seriesId: row.id,
      status: index % 3 === 0 ? 'watching' : index % 3 === 1 ? 'planned' : 'watched',
    });
  }
}

// Четыре отзыва и руководство — ровно пять материалов в минуту на автора:
// шестой сервис отклонит по лимиту частоты.
for (const [index, row] of series.slice(0, 4).entries()) {
  await ensureReview(ids['Анна'], row.id, reviewTexts[index]);
}
await ensureReview(ids['Игорь'], series[0].id, reviewTexts[0]);
await ensureGuide(ids['Анна'], series[0].id);

const { rows: [counts] } = await pool.query(`
  SELECT (SELECT count(*)::int FROM e_user WHERE nickname = ANY($1::text[])) AS users,
         (SELECT count(*)::int FROM e_material WHERE state = 'published') AS materials,
         (SELECT count(*)::int FROM e_rating) AS ratings`, [ACCOUNTS.map((a) => a.nickname)]);

console.log('\nДемонстрационные данные готовы.');
console.log(`  пользователей: ${counts.users}, материалов: ${counts.materials}, оценок: ${counts.ratings}`);
console.log('  вход:');
for (const account of ACCOUNTS) {
  console.log(`    ${account.role ?? 'зритель'}\t${account.email}\t${PASSWORD}`);
}
await pool.end();
