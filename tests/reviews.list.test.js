// Список отзывов сериала (F-04-05, OP-04).
//
// Проверяется выборка целиком: видимость версии, группы по текущей оценке,
// фильтры длины и языка, сортировки, страницы и счётчики. HTTP-сторона —
// в `http.reviews.list.test.js`.
//
// Каждый тест чистит за собой по своему префиксу slug: файлы идут
// параллельно, и общая уборка сносила бы чужие фикстуры.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { pgReviewList } from '../src/services/reviews/list.js';
import { pgReviews } from '../src/services/reviews/store.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { REVIEW } from '../src/config/settings.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';
const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — список отзывов не проверялся';
const PREFIX = 'review-list-%';

let pool;
let list;
let reviews;
let auth;

/** Человек: подтверждённый адрес — проходит все права. */
async function viewer() {
  const { hash } = makeToken();
  const nickname = `review-list-${crypto.randomUUID().slice(0, 8)}`;
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
  return { id: created.id, nickname };
}

/** Сериал с серией: разные номера — чтобы фикстуры не мешались. */
async function seriesWith(number) {
  const { rows: [seriesRow] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Список фикстуры', 'List fixture', $2, 'published', 'airing', 2024) RETURNING id, slug`,
    [`review-list-${number}-${crypto.randomUUID().slice(0, 6)}`, 971_000_000 + number],
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

/** Отметка просмотра — без неё отзыв писать нельзя (EC-V1). */
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

/** Оценка автора напрямую: список группирует по текущей оценке (EC-V3). */
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
const dirty = { block: [{ word: 'запрещено', category: 'profanity' }], allow: [], available: true };
const down = { block: [], allow: [], available: false };

/** Отзыв от имени человека: оценка, отметка и текст одним действием. */
async function write({ user, series, text, dictionary = clean, spoiler = false, lang = 'ru', at = new Date() }) {
  await mark(user.id, series.id);
  await rate(user.id, series.id, 8);
  const r = await reviews.submit({
    userId: user.id, seriesId: series.id, body: text, spoiler, lang, dictionary, at,
  });
  assert.equal(r.ok, true, `отзыв должен записаться: ${r.reason ?? ''}`);
  return r;
}

const pageOf = (seriesId, filters = {}, rest = {}) => list.page({ seriesId, filters, page: 1, ...rest });
const byNick = (items, nickname) => items.find((item) => item.authorNickname === nickname);

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
  list = pgReviewList(pool);
  reviews = pgReviews(pool);
  auth = pgAuthStore(pool);
});

test.after(async () => {
  if (!pool) return;
  const ids = `SELECT id FROM e_series WHERE slug LIKE $1`;
  await pool.query(`DELETE FROM e_helpful_vote WHERE material_id IN (SELECT id FROM e_material WHERE series_id IN (${ids}))`, [PREFIX]);
  await pool.query(`DELETE FROM e_material WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_rating WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_restriction WHERE user_id IN (
    SELECT id FROM e_user WHERE nickname LIKE 'review-list-%')`);
  await pool.query(`DELETE FROM e_watch_mark WHERE episode_id IN (
    SELECT e.id FROM e_episode e JOIN e_season s ON s.id = e.season_id WHERE s.series_id IN (${ids}))`, [PREFIX]);
  await pool.query(`DELETE FROM e_season WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_series WHERE slug LIKE $1`, [PREFIX]);
  await pool.end();
});

test('видны опубликованные; ждущие проверки — нет; у правки виден прежний текст (R-MOD-21)', { skip }, async () => {
  const series = await seriesWith(1);
  const a = await viewer();
  const b = await viewer();
  const c = await viewer();

  await write({ user: a, series, text: 'Первый текст отзыва, он виден читателям' });
  await write({ user: b, series, text: 'Текст, который ждёт проверки словаря', dictionary: down });
  await write({ user: c, series, text: 'Текст с запрещено словом внутри', dictionary: dirty });

  const first = await pageOf(series.id);
  assert.equal(first.total, 1, 'виден только опубликованный');
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].authorNickname, a.nickname);
  assert.equal(first.items[0].body, 'Первый текст отзыва, он виден читателям');
  assert.equal(first.items[0].authorRating, 8);

  // Правка опубликованного: пока новая версия проходит проверку, читатель
  // видит прежнюю (R-MOD-21, EC-V9), а не пустоту.
  const edited = await write({
    user: a, series, text: 'Изменённый текст, он тоже ждёт проверки', dictionary: down,
  });
  assert.equal(edited.state, 'checking');

  const during = await pageOf(series.id);
  assert.equal(during.total, 1);
  assert.equal(during.items[0].body, 'Первый текст отзыва, он виден читателям',
    'новый текст на проверке читателю не показывается');

  // Новая версия прошла проверку — снимок больше не нужен, показывается она.
  const passed = await write({
    user: a, series, text: 'Изменённый текст, он прошёл проверку',
    at: new Date(Date.now() + (REVIEW.recheckMin + 1) * 60 * 1000),
  });
  assert.equal(passed.state, 'published');
  const after = await pageOf(series.id);
  assert.equal(after.items[0].body, 'Изменённый текст, он прошёл проверку');
});

test('скрытые и удалённые отзывы не показываются', { skip }, async () => {
  const series = await seriesWith(2);
  const a = await viewer();
  const b = await viewer();

  await write({ user: a, series, text: 'Отзыв, который редактор скрыл' });
  await write({ user: b, series, text: 'Отзыв, который автор удалил сам' });
  assert.equal((await pageOf(series.id)).total, 2);

  await pool.query(
    `UPDATE e_material SET state = 'hidden' WHERE author_id = $1 AND series_id = $2`,
    [a.id, series.id],
  );
  const removed = await reviews.deleteOwn({ userId: b.id, seriesId: series.id });
  assert.equal(removed, true);

  const page = await pageOf(series.id);
  assert.equal(page.total, 0, 'ни скрытый, ни удалённый читателю не видны');
  assert.deepEqual(page.counts, { all: 0, positive: 0, mixed: 0, negative: 0 });
});

test('действующий бан «скрыть материалы» убирает отзывы, снятый и истёкший — нет (M4 §8в)', { skip }, async () => {
  const series = await seriesWith(3);
  const author = await viewer();
  const moderator = await viewer();
  await write({ user: author, series, text: 'Отзыв человека, которого забанили' });

  const ban = (hide, expires = null) => pool.query(
    `INSERT INTO e_restriction (user_id, kind, reason, hide_materials, set_by, expires_at)
     VALUES ($1, 'ban', 'тест', $2, $3, $4)`,
    [author.id, hide, moderator.id, expires],
  );
  const revoke = () => pool.query(
    `UPDATE e_restriction SET revoked_at = now(), revoked_by = $2
      WHERE user_id = $1 AND kind = 'ban' AND revoked_at IS NULL`,
    [author.id, moderator.id],
  );

  await ban(true);
  assert.equal((await pageOf(series.id)).total, 0, 'бан со «скрыть материалы» убирает отзыв');

  await revoke();
  assert.equal((await pageOf(series.id)).total, 1, 'снятый бан не помнится');

  await ban(false);
  assert.equal((await pageOf(series.id)).total, 1, 'бан без признака материалы не трогает');

  await revoke();
  await ban(true, new Date(Date.now() - 60 * 60 * 1000));
  assert.equal((await pageOf(series.id)).total, 1, 'истёкший бан не помнится');
});

test('группа — по текущей оценке автора: смена оценки переносит отзыв (EC-V3)', { skip }, async () => {
  const series = await seriesWith(4);
  const a = await viewer();
  const b = await viewer();
  const c = await viewer();

  await write({ user: a, series, text: 'Отзыв с оценкой семь, граница положительных' });
  await rate(a.id, series.id, 7);
  await write({ user: b, series, text: 'Отзыв с оценкой шесть, это смешанные' });
  await rate(b.id, series.id, 6);
  await write({ user: c, series, text: 'Отзыв с оценкой четыре, отрицательные' });
  await rate(c.id, series.id, 4);

  const all = await pageOf(series.id);
  assert.deepEqual(all.counts, { all: 3, positive: 1, mixed: 1, negative: 1 });

  const positive = await pageOf(series.id, { group: 'positive' });
  assert.equal(positive.total, 1);
  assert.equal(positive.items[0].authorNickname, a.nickname);
  assert.equal(positive.items[0].authorRating, 7);
  assert.deepEqual(positive.counts, all.counts, 'счётчики не сужаются выбранной группой');

  // Оценка изменилась — отзыв перешёл в другую группу, счётчики догнали.
  await rate(a.id, series.id, 3);
  const moved = await pageOf(series.id);
  assert.deepEqual(moved.counts, { all: 3, positive: 0, mixed: 1, negative: 2 });

  const negative = await pageOf(series.id, { group: 'negative' });
  assert.equal(negative.total, 2);
  assert.equal(byNick(negative.items, a.nickname).authorRating, 3);
  assert.equal((await pageOf(series.id, { group: 'positive' })).total, 0,
    'пустая группа отвечает пустым списком, а не ошибкой');
});

test('фильтры длины — по видимому тексту; средние остаются во «Все» (M4 §8б)', { skip }, async () => {
  const series = await seriesWith(5);
  const a = await viewer();
  const b = await viewer();
  const c = await viewer();
  const d = await viewer();
  const short = 'к'.repeat(100);
  const medium = 'с'.repeat(500);
  const long = 'д'.repeat(1200);

  await write({ user: a, series, text: short });
  await write({ user: b, series, text: medium });
  await write({ user: c, series, text: long });
  // Короткий текст, у которого на проверке длинная правка: фильтр смотрит
  // на видимую версию, а не на ожидающую (иначе отзыв мигал бы между группами).
  await write({ user: d, series, text: 'и'.repeat(150) });
  await write({ user: d, series, text: `${long} ещё хвост`, dictionary: down });

  assert.equal((await pageOf(series.id)).total, 4, 'без фильтра видны все');
  const shorts = await pageOf(series.id, { length: 'short' });
  assert.equal(shorts.total, 2, 'короткие: 100 и 150 знаков; средний — не короткий');
  const longs = await pageOf(series.id, { length: 'long' });
  assert.equal(longs.total, 1, 'длинный: только опубликованный, правка на проверке не в счёте');
  assert.equal(longs.items[0].authorNickname, c.nickname);
});

test('фильтр языка отделяет RU и EN (F-04-05 §4)', { skip }, async () => {
  const series = await seriesWith(6);
  const a = await viewer();
  const b = await viewer();

  await write({ user: a, series, text: 'Русский текст отзыва про сериал' });
  await write({ user: b, series, text: 'A great show, I watch it over and over', lang: null });

  assert.equal((await pageOf(series.id, { lang: 'ru' })).total, 1);
  const en = await pageOf(series.id, { lang: 'en' });
  assert.equal(en.total, 1);
  assert.equal(en.items[0].lang, 'en');
  assert.equal((await pageOf(series.id, { lang: 'de' })).total, 2, 'неизвестный язык игнорируется');
});

test('сортировки: «Полезные», «Новые», «Длинные» — детерминированы', { skip }, async () => {
  const series = await seriesWith(7);
  const authors = [await viewer(), await viewer(), await viewer(), await viewer()];
  const voters = [await viewer(), await viewer(), await viewer()];
  const texts = ['р'.repeat(400), 'р'.repeat(300), 'р'.repeat(200), 'р'.repeat(100)];
  const at = (min) => new Date(Date.now() - min * 60 * 1000);

  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    await write({ user: authors[i], series, text: texts[i] });
    ids.push(await materialId(authors[i], series));
  }
  // created_at ставится явно: порядок не должен зависеть от скорости прогона.
  const ages = [120, 40, 80, 10];
  for (let i = 0; i < 4; i += 1) {
    await pool.query('UPDATE e_material SET created_at = $2 WHERE id = $1', [ids[i], at(ages[i])]);
  }
  // Голоса: у 1-го и 2-го поровну — порядок решает дата; у 0-го меньше всех.
  const voteCounts = [1, 2, 2, 0];
  for (let i = 0; i < 4; i += 1) {
    for (let v = 0; v < voteCounts[i]; v += 1) {
      await pool.query(
        'INSERT INTO e_helpful_vote (user_id, material_id) VALUES ($1, $2)',
        [voters[v].id, ids[i]],
      );
    }
  }

  const order = (page) => page.items.map((item) => item.authorNickname);
  const helpful = await pageOf(series.id, { sort: 'helpful' });
  assert.deepEqual(order(helpful), [authors[1].nickname, authors[2].nickname, authors[0].nickname, authors[3].nickname],
    'по голосам; при равенстве — новее выше');
  const fresh = await pageOf(series.id, { sort: 'new' });
  assert.deepEqual(order(fresh), [authors[3].nickname, authors[1].nickname, authors[2].nickname, authors[0].nickname],
    'новые — по дате создания');
  const long = await pageOf(series.id, { sort: 'long' });
  assert.deepEqual(order(long), [authors[0].nickname, authors[1].nickname, authors[2].nickname, authors[3].nickname],
    'длинные — по числу знаков видимого текста');
  assert.equal((await pageOf(series.id, { sort: 'zzz' })).items[0].authorNickname, authors[1].nickname,
    'неизвестная сортировка — умолчание «Полезные»');
});

/** Идентификатор отзыва пары — для прямых правок в тесте порядка. */
async function materialId(user, series) {
  const { rows } = await pool.query(
    `SELECT id FROM e_material WHERE author_id = $1 AND series_id = $2 AND kind = 'review'`,
    [user.id, series.id],
  );
  return Number(rows[0].id);
}

test('страницы: размер задаётся вызовом, последняя неполная, total виден за концом', { skip }, async () => {
  const series = await seriesWith(8);
  for (let i = 0; i < 5; i += 1) {
    const user = await viewer();
    await write({ user, series, text: `Отзыв номер ${i}, он нужен для страниц` });
  }

  const first = await pageOf(series.id, {}, { pageSize: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.pages, 3);
  assert.equal(first.total, 5);
  const second = await pageOf(series.id, {}, { page: 2, pageSize: 2 });
  assert.equal(second.items.length, 2);
  const third = await pageOf(series.id, {}, { page: 3, pageSize: 2 });
  assert.equal(third.items.length, 1, 'последняя страница неполная');
  const beyond = await pageOf(series.id, {}, { page: 4, pageSize: 2 });
  assert.equal(beyond.items.length, 0, 'страница за концом пуста');
  assert.equal(beyond.total, 5, 'total нужен маршруту для перехода на последнюю');

  const ids = [...first.items, ...second.items, ...third.items].map((item) => item.id);
  assert.equal(new Set(ids).size, 5, 'страницы не пересекаются и не теряют строк');
});

test('счётчики вкладок — в области фильтров длины и языка (M4 §8б)', { skip }, async () => {
  const series = await seriesWith(9);
  const a = await viewer();
  const b = await viewer();
  const c = await viewer();
  const d = await viewer();

  await write({ user: a, series, text: 'к'.repeat(100) });
  await rate(a.id, series.id, 9);
  await write({ user: b, series, text: 'к'.repeat(120) });
  await rate(b.id, series.id, 2);
  await write({ user: c, series, text: 'д'.repeat(1100) });
  await rate(c.id, series.id, 8);
  await write({ user: d, series, text: 'A concise English review of the show', lang: null });
  await rate(d.id, series.id, 7);

  const all = await pageOf(series.id);
  assert.deepEqual(all.counts, { all: 4, positive: 3, mixed: 0, negative: 1 });
  assert.equal(all.counts.positive + all.counts.mixed + all.counts.negative, all.counts.all,
    'сумма вкладок равна «Все»');

  const short = await pageOf(series.id, { length: 'short' });
  assert.deepEqual(short.counts, { all: 3, positive: 2, mixed: 0, negative: 1 },
    'длинный отзыв вне области фильтра длины');

  const en = await pageOf(series.id, { lang: 'en' });
  assert.deepEqual(en.counts, { all: 1, positive: 1, mixed: 0, negative: 0 });

  const positive = await pageOf(series.id, { group: 'positive' });
  assert.equal(positive.total, 3, 'total — в области всех фильтров');
  assert.deepEqual(positive.counts, all.counts, 'счётчики — без сужения группой');
});

test('отзыв без текущей оценки читателю не показывается: карточке нужно число', { skip }, async () => {
  const series = await seriesWith(10);
  const a = await viewer();
  await write({ user: a, series, text: 'Обычный отзыв, который видно' });

  // Через приложение такого не бывает (H-75), но строка может остаться от
  // сбоя: показывать карточку без оценки автора нельзя — в ней нет числа,
  // а счётчики вкладок разошлись бы с лентой.
  const b = await viewer();
  await mark(b.id, series.id);
  await pool.query(
    `INSERT INTO e_material (author_id, kind, series_id, body, lang, state)
     VALUES ($1, 'review', $2, 'Отзыв, потерявший свою оценку по сбою', 'ru', 'published')`,
    [b.id, series.id],
  );

  const page = await pageOf(series.id);
  assert.equal(page.total, 1);
  assert.equal(page.items[0].authorNickname, a.nickname);
});

test('удалённый автор: строка помечена, старый ник не подставляется (EC-V6)', { skip }, async () => {
  const series = await seriesWith(11);
  const a = await viewer();
  await write({ user: a, series, text: 'Отзыв человека, который удалил аккаунт' });

  await auth.anonymizeUser(a.id);

  const page = await pageOf(series.id);
  assert.equal(page.total, 1, 'сам текст остаётся, аккаунт обезличен, а не вычеркнут');
  assert.equal(page.items[0].authorStatus, 'deleted');
});

test('«Лучшие» для S-06 — порядок «Полезные» и не больше лимита', { skip }, async () => {
  const series = await seriesWith(12);
  const authors = [await viewer(), await viewer(), await viewer(), await viewer()];
  const voters = [await viewer(), await viewer(), await viewer()];

  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    await write({ user: authors[i], series, text: `Отзыв для «Лучших» номер ${i}` });
    ids.push(await materialId(authors[i], series));
  }
  for (let v = 0; v < 3; v += 1) {
    await pool.query('INSERT INTO e_helpful_vote (user_id, material_id) VALUES ($1, $2)', [voters[v].id, ids[1]]);
    if (v < 2) await pool.query('INSERT INTO e_helpful_vote (user_id, material_id) VALUES ($1, $2)', [voters[v].id, ids[2]]);
    if (v < 1) await pool.query('INSERT INTO e_helpful_vote (user_id, material_id) VALUES ($1, $2)', [voters[v].id, ids[0]]);
  }

  const top = await list.top({ seriesId: series.id, limit: 3 });
  assert.equal(top.length, 3, 'ровно лимит, даже когда отзывов больше');
  assert.deepEqual(top.map((item) => item.id), [ids[1], ids[2], ids[0]],
    'порядок — как у «Полезных»: голоса, затем дата');
});

test('«Лучшие» на сериале без отзывов — пустой список, не ошибка', { skip }, async () => {
  const series = await seriesWith(13);
  assert.deepEqual(await list.top({ seriesId: series.id, limit: 3 }), []);
  const page = await pageOf(series.id);
  assert.deepEqual(page, {
    items: [],
    total: 0,
    page: 1,
    pages: 1,
    counts: { all: 0, positive: 0, mixed: 0, negative: 0 },
    applied: { group: null, length: null, lang: null, sort: 'helpful' },
  });
});
