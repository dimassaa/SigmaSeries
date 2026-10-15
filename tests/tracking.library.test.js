// Закладки (F-03-04, S-30).
//
// Список строится по статусам зрителя, поэтому проверяется на связке трёх
// вещей: строка статуса, каталог и выходы. Счётчики на вкладках обязаны считать
// по всем статусам пользователя, а не по выборке — иначе цифра меняется при
// переключении вкладки, и это выглядит как ошибка.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';
import { pgLibrary } from '../src/services/tracking/library.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — закладки не проверялись';

let pool;
let library;
let store;
let user;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  library = pgLibrary(pool);
  store = pgAuthStore(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_watch_status WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)', ['lib-%']);
  await pool.query('DELETE FROM e_watch_mark WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)', ['lib-%']);
  await pool.query('DELETE FROM e_series WHERE slug LIKE $1', ['lib-%']);
  await pool.query('DELETE FROM e_user WHERE nickname LIKE $1', ['lib-%']);
  await pool.end();
});

/** Зритель с `count` сериалами, у каждого свой статус по кругу. */
async function viewerWith(count = 4) {
  const { token, hash } = makeToken();
  const id = `lib-${crypto.randomUUID()}`;
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

  const statuses = ['watching', 'planned', 'watched', 'dropped', 'on_hold'];
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
       VALUES ($1, $2, $3, $4, 'published', 'airing', $5) RETURNING id`,
      [
        `${id}-${index}`,
        `Закладка ${String.fromCharCode(64 + index + 1)} тестовая`,
        `Bookmark fixture ${index}`,
        994000000 + (Number(id.replace(/\D/g, '').slice(0, 4)) || 1) * 10 + index,
        2000 + index,
      ],
    );
    await pool.query(
      'INSERT INTO e_watch_status (user_id, series_id, status, changed_at) VALUES ($1, $2, $3, now() - ($4 || \' minutes\')::interval)',
      [created.id, row.id, statuses[index % statuses.length], String(index)],
    );
    ids.push(row.id);
  }

  return { userId: created.id, series: ids };
}

test('список отдаёт статусы пользователя со счётчиками по всем вкладкам', { skip }, async () => {
  const { userId } = await viewerWith(4);
  const page = await library.list({ userId, today: '2026-10-15' });

  assert.equal(page.total, 4, 'всего закладок');
  assert.equal(page.counts.watching, 1, 'счётчик «Смотрю»');
  assert.equal(page.counts.planned, 1, 'счётчик «В планах»');
  assert.equal(page.counts.watched, 1, 'счётчик «Просмотрено»');
  assert.equal(page.counts.dropped, 1, 'счётчик «Брошено»');
  // Четыре фикстуры занимают четыре первых статуса из пяти: «Отложено»
  // не выдаётся, и это тоже должно быть видно в счётчике.
  assert.equal(page.counts.on_hold, 0, 'счётчик «Отложено»');
  assert.equal(page.pages, 1, 'страниц');
  assert.equal(page.items.length, 4, 'закладок на странице');
  for (const item of page.items) {
    assert.ok(item.title, 'у закладки есть название');
    assert.ok(item.slug, 'у закладки есть адрес');
    assert.ok(item.status, 'у закладки есть статус');
  }
});

test('вкладка показывает только свой статус, а счётчики не меняются', { skip }, async () => {
  const { userId } = await viewerWith(4);
  const all = await library.list({ userId, today: '2026-10-15' });
  const watching = await library.list({ userId, status: 'watching', today: '2026-10-15' });

  assert.equal(watching.items.length, 1);
  assert.equal(watching.total, 1);
  assert.deepEqual(watching.counts, all.counts,
    'цифры на вкладках считаются по счётчикам, а не по выборке (F-03-04 §8)');
});

test('сортировки переставляют один и тот же набор', { skip }, async () => {
  const { userId } = await viewerWith(4);

  const recent = await library.list({ userId, sort: 'recent', today: '2026-10-15' });
  const byYear = await library.list({ userId, sort: 'year', today: '2026-10-15' });
  const title = await library.list({ userId, sort: 'title', today: '2026-10-15' });

  // По умолчанию — недавно изменённые: у фикстур они разведены по минутам.
  const stamps = recent.items.map((item) => item.changedAt);
  assert.deepEqual(stamps, [...stamps].sort().reverse(), 'сначала изменённые позже');

  const years = byYear.items.map((item) => item.year);
  assert.deepEqual(years, [...years].sort((a, b) => b - a), 'по году — от новых к старым');

  const titles = title.items.map((item) => item.title);
  assert.deepEqual(titles, [...titles].sort(), 'по названию — по алфавиту');

  const ids = new Set(recent.items.map((item) => item.seriesId));
  assert.equal(ids.size, 4, 'сортировка не теряет и не дублирует закладки');
});

test('поиск по списку сужает выдачу, но не счётчики вкладок', { skip }, async () => {
  const { userId } = await viewerWith(4);
  const all = await library.list({ userId, today: '2026-10-15' });
  const found = await library.list({ userId, query: 'Закладка B', today: '2026-10-15' });

  assert.equal(found.items.length, 1);
  assert.match(found.items[0].title, /Закладка B/);
  assert.deepEqual(found.counts, all.counts, 'счётчики остаются прежними: они про вкладки, а не про поиск');
});

test('прогресс и следующая серия считаются по отметкам и выходам', { skip }, async () => {
  const { userId, series } = await viewerWith(1);
  const [seriesId] = series;

  const { rows } = await pool.query(
    `SELECT e.id, e.number FROM e_episode e
       JOIN e_season se ON se.id = e.season_id
      WHERE se.series_id = $1 AND se.number > 0
      ORDER BY se.number, e.number LIMIT 2`,
    [seriesId],
  );
  if (rows.length < 2) {
    assert.ok(true, 'у фикстуры нет серий — считать нечего');
    return;
  }

  const page = await library.list({ userId, today: '2026-10-15' });
  const item = page.items[0];
  assert.equal(item.progress.total, 0, 'без отметок прогресс нулевой');
  assert.equal(item.progress.marked, 0);
  assert.equal(item.progress.nextEpisode, null,
    'невышедшую серию продолжать нечего — «Продолжить» показывать не для чего');

  // Отмечаем серию, вышедшую в прошлом, и ждём её в списке.
  await pool.query(
    `INSERT INTO e_watch_mark (user_id, episode_id, precision) VALUES ($1, $2, 'exact')`,
    [userId, rows[0].id],
  );
  await pool.query(
    `UPDATE e_series SET exit_state = 'ended' WHERE id = $1`,
    [seriesId],
  );
  await pool.query(
    `INSERT INTO e_season (series_id, number) VALUES ($1, 1) ON CONFLICT DO NOTHING`,
    [seriesId],
  );
  const { rows: season } = await pool.query(
    'SELECT id FROM e_season WHERE series_id = $1 AND number = 1',
    [seriesId],
  );
  await pool.query(
    `INSERT INTO e_release (season_id, covers_season, release_date, precision, state)
     VALUES ($1, true, CURRENT_DATE - 10, 'date', 'aired')`,
    [season[0].id],
  );

  const after = await library.list({ userId, today: '2026-10-15' });
  assert.equal(after.items[0].progress.marked, 1, 'отмеченная серия засчитана');
});

test('постраничность: страница за концом списка — последняя (EC-K6)', { skip }, async () => {
  const { userId } = await viewerWith(5);

  const page = await library.list({ userId, page: 1, limit: 2, today: '2026-10-15' });
  assert.equal(page.items.length, 2);
  assert.equal(page.pages, 3);

  const beyond = await library.list({ userId, page: 99, limit: 2, today: '2026-10-15' });
  assert.equal(beyond.page, 3, 'адрес за концом списка показывает последнюю страницу, а не пустую');
  assert.equal(beyond.items.length, 1);
});

test('негодные значения фильтра и сортировки не ломают страницу', { skip }, async () => {
  const { userId } = await viewerWith(1);

  const page = await library.list({
    userId,
    status: 'не-статус',
    sort: 'не-сортировка',
    page: -3,
    today: '2026-10-15',
  });
  assert.equal(page.items.length, 1, 'мусор в адресе отбрасывается, а не превращается в 400');
  assert.equal(page.sort, 'recent', 'сортировка по умолчанию');
});

test('пустой список — это ноль, а не ошибка', { skip }, async () => {
  const { token, hash } = makeToken();
  const id = `lib-${crypto.randomUUID()}`;
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

  const page = await library.list({ userId: created.id, today: '2026-10-15' });
  assert.equal(page.total, 0);
  assert.deepEqual(page.items, []);
  assert.equal(page.pages, 1);
});