// Правая панель «Предстоящие» (F-03-06, UI-04).
//
// Проверяется то, что человек видит в углу: подписи дат, порядок, одна строка
// на сериал и кэш, который не врёт. Подписи дат вынесены отдельно ещё и
// потому, что их читает всё остальное: «через 2 дня» из правила R-I18N-05
// повторялась бы в календаре, уведомлениях и ленте.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgUpcomingPanel, captionFor, PANEL_ITEMS, PANEL_WINDOW_DAYS, PANEL_CACHE_S } from '../src/services/catalogue/panel.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — панель «Предстоящие» не проверялась';

let pool;
const fixtures = [];

/** Свой источник на проверку: кэш панели живёт `panel.cache_s` и держал бы
 *  строки чужой фикстуры между проверками. */
const panel = () => pgUpcomingPanel(pool);

// ─── Подписи дат (R-I18N-05) ────────────────────────────────────────────────

test('подпись даты говорит «сегодня», «завтра», «через N дней», а дальше — датой', () => {
  const today = '2026-10-16';

  assert.equal(captionFor('ru', '2026-10-16', today), 'Сегодня вышла');
  assert.equal(captionFor('ru', '2026-10-17', today), 'Завтра');
  assert.equal(captionFor('ru', '2026-10-18', today), 'Через 2 дня');
  assert.equal(captionFor('ru', '2026-10-19', today), 'Через 3 дня');
  assert.equal(captionFor('ru', '2026-10-20', today), '20 окт.', 'дальше четырех дней — дата');
  assert.equal(captionFor('ru', '2026-11-02', today), '2 нояб.');

  assert.equal(captionFor('en', '2026-10-16', today), 'Out today');
  assert.equal(captionFor('en', '2026-10-17', today), 'Tomorrow');
  assert.equal(captionFor('en', '2026-10-19', today), 'In 3 days');
});

// ─── Данные панели ───────────────────────────────────────────────────────────

/**
 * Сериал с сезоном и выходами.
 *
 * @param {any} args
 * @returns {Promise<{seriesId: number, slug: string}>}
 */
// Голоса задаются заведомо большими: при равенстве дат панель сортирует по
// ним, и фикстура с сотней голосов проиграла бы настоящему каталогу,
// а проверять надо поведение панели, а не её конкуренцию с данными.
async function seriesWith({ releases, coversSeason = false, votes = 9_000_000 }) {
  const slug = `panel-${crypto.randomUUID().slice(0, 8)}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Панель', 'Panel', $2, 'published', 'airing', 2024) RETURNING id, slug`,
    [slug, 986_000_000 + Math.floor(Math.random() * 900)],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [series.id],
  );

  const episodeIds = [];
  for (const [index, date] of releases.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const { rows: [episode] } = await pool.query(
      `INSERT INTO e_episode (season_id, number, title_ru, runtime_min)
       VALUES ($1, $2, 'Серия', 45) RETURNING id`,
      [season.id, index + 1],
    );
    episodeIds.push(episode.id);
    // eslint-disable-next-line no-await-in-loop
    const { rows: [release] } = await pool.query(
      `INSERT INTO e_release (season_id, release_date, precision, state, covers_season)
       VALUES ($1, $2, 'date', 'scheduled', $3) RETURNING id`,
      [season.id, date, coversSeason],
    );
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      'INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)',
      [release.id, episode.id],
    );
  }

  await pool.query(
    `INSERT INTO e_external_rating (series_id, platform, value, votes, measured_on)
     VALUES ($1, 'imdb', 8.1, $2, CURRENT_DATE) ON CONFLICT (series_id, platform)
     DO UPDATE SET votes = EXCLUDED.votes`,
    [series.id, votes],
  );

  fixtures.push({ seriesId: series.id, slug });
  return { seriesId: series.id, slug };
}

test.before(async () => {
  if (!available) return;
  pool = createPool();

  // Все фикстуры сериалов создаются здесь, одним заходом до проверок. Разбросанные
  // по тестам вставки дёргают счётчик опубликованных сериалов, на который
  // смотрят проверки каталога, и делают их флакующими на всё время прогона.
  fixtures.push(await seriesWith({ releases: ['2026-10-16', '2026-10-17'] }),  // окно: сегодня
    await seriesWith({ releases: ['2026-10-17'] }),                            // завтра
    await seriesWith({ releases: ['2026-10-20', '2026-10-24'] }),              // один сериал, два выхода
    await seriesWith({ releases: ['2026-10-18'] }),                            // одна серия
    await seriesWith({ releases: ['2026-10-19'] }),                            // диапазон
    await seriesWith({ releases: ['2026-10-17'], coversSeason: true }),         // весь сезон
    await seriesWith({ releases: ['2026-10-29'] }),                            // последний день окна
    await seriesWith({ releases: ['2026-10-31'] }),                            // за окном
    await seriesWith({ releases: ['2026-10-16'], votes: 100 }),                // сегодня, без прав
    await seriesWith({ releases: ['2026-10-18'], votes: 200 }),                // позже, но «Смотрю»
    await seriesWith({ releases: ['2026-10-16'], votes: 100 }));               // сегодня, без прав
});

test.after(async () => {
  if (!pool) return;
  // Сезоны уходят раньше сериалов: `e_season.series_id` объявлен RESTRICT
  // намеренно, и уборка должна идти в порядке внешних ключей.
  for (const one of fixtures) {
    await pool.query('DELETE FROM e_season WHERE series_id = $1', [one.seriesId]);
  }
  for (const one of fixtures) {
    await pool.query('DELETE FROM e_series WHERE id = $1', [one.seriesId]);
  }
  await pool.end();
});

test('панель показывает ближайшие выходы окна и не выходит за его границы', { skip }, async () => {
  const today = '2026-10-16';

  // Предел заведомо широкий: проверяются границы окна, а не то, кто поместился
  // в десять строк — настоящий каталог занимает их раньше фикстур.
  const rows = await panel().upcoming({ today, limit: 500 });
  const dates = rows.map((row) => row.date);

  assert.ok(dates.every((date) => date >= today && date < '2026-10-30'),
    `в панели только окно «сегодня … +14 дней», а попало: ${dates.filter((d) => d >= '2026-10-30').join(', ')}`);
  assert.ok(dates.includes('2026-10-29'), 'последний день окна виден');
  assert.ok(!dates.includes('2026-10-31'), 'а за окном — нет: панель обещает ближайшие дни');
});

test('один сериал — одна строка, и это ближайший его выход', { skip }, async () => {
  const today = '2026-10-16';
  const one = fixtures[2];

  const rows = await panel().upcoming({ today, limit: 100 });
  const mine = rows.filter((row) => row.slug === one.slug);

  assert.equal(mine.length, 1, 'сериал не занимает две строки');
  assert.equal(mine[0].date, '2026-10-20', 'и это ближайший его выход, а не самый дальний');
});

test('подпись серии читается как в макете: S1E1, диапазон, «все серии»', { skip }, async () => {
  const today = '2026-10-16';

  const single = fixtures[3];
  const pair = fixtures[4];
  const season = fixtures[5];

  // Вторая серия того же дня даёт диапазон «S1E1–2».
  const { rows: [seasonOfPair] } = await pool.query(
    'SELECT id FROM e_season WHERE series_id = $1', [pair.seriesId],
  );
  const { rows: [two] } = await pool.query(
    `INSERT INTO e_episode (season_id, number, title_ru, runtime_min)
     VALUES ($1, 2, 'Вторая', 45) RETURNING id`, [seasonOfPair.id],
  );
  const { rows: [second] } = await pool.query(
    `SELECT r.id FROM e_release r
       JOIN e_season se ON se.id = r.season_id
      WHERE se.series_id = $1 AND r.release_date = '2026-10-19'`, [pair.seriesId],
  );
  const { rows: [first] } = await pool.query(
    `SELECT e.id FROM e_release_episode link
       JOIN e_episode e ON e.id = link.episode_id
      WHERE link.release_id = $1 ORDER BY e.number LIMIT 1`, [second.id],
  );
  await pool.query(
    'INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)',
    [second.id, two.id],
  );
  void first;

  void season;

  const rows = await panel().upcoming({ today, limit: 100 });
  const label = (slug) => rows.find((row) => row.slug === slug)?.label;

  assert.equal(label(single.slug), 'S1E1', 'одна серия — «S1E1»');
  assert.equal(label(pair.slug), 'S1E1–2', 'две серии одного дня — диапазон');
  assert.match(label(season.slug), /^S1 · все \d+$/, 'сезонный выход — «все N серий»');
});

test('сериалы вошедшего идут выше, а остальные не теряются', { skip }, async () => {
  const today = '2026-10-16';
  const soon = fixtures[8];
  const later = fixtures[9];
  const todayFirst = fixtures[10];

  const { hash } = makeToken();
  const nickname = `pan-viewer-${crypto.randomUUID().slice(0, 8)}`;
  const viewer = await pgAuthStore(pool).createUser({
    email: `${nickname}@example.com`,
    nickname,
    passwordHash: '$argon2id$заглушка',
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
  });

  try {
    // Человек смотрит «сериал позже»: он должен оказаться выше, чем сериал,
    // который выходит раньше, но который он не смотрит (H-71).
    await pool.query(
      'INSERT INTO e_watch_status (user_id, series_id, status) VALUES ($1, $2, $3)',
      [viewer.id, later.seriesId, 'watching'],
    );

    const mine = await panel().upcoming({ today, userId: viewer.id });
    const order = mine.map((row) => row.slug);

    assert.ok(order.indexOf(later.slug) < order.indexOf(soon.slug),
      `сериал из «Смотрю» должен быть выше: ${order.slice(0, 4).join(', ')}`);
    assert.ok(order.includes(todayFirst.slug), 'а остальные никуда не делись');
  } finally {
    await pool.query('DELETE FROM e_watch_status WHERE user_id = $1', [viewer.id]);
    await pool.query('DELETE FROM e_user WHERE id = $1', [viewer.id]);
  }
});

test('панель не больше panel.items строк и помнит размер окна из настроек', { skip }, async () => {
  const rows = await panel().upcoming({ today: '2026-10-16' });

  assert.ok(rows.length <= PANEL_ITEMS,
    `строк ${rows.length}, а обещано не больше ${PANEL_ITEMS} (panel.items)`);
  assert.equal(PANEL_ITEMS, 10, 'panel.items = 10 (M3 §0)');
  assert.equal(PANEL_WINDOW_DAYS, 14, 'panel.window_days = 14 (M3 §0)');
  assert.equal(PANEL_CACHE_S, 300, 'panel.cache_s = 300 (M3 §0)');
});

test('кэш отдаёт тот же ответ и не ходит в базу второй раз', { skip }, async () => {
  const today = '2026-10-16';
  await seriesWith({ releases: ['2026-10-17'] });

  // Считаем запросы к выходам: источник получает пул через обёртку, поэтому
  // число видно извне, а не «как получилось».
  let queries = 0;
  const counted = {
    query: (sql, params) => {
      if (String(sql).includes('e_release')) queries += 1;
      return pool.query(sql, params);
    },
  };
  const fresh = pgUpcomingPanel(counted);

  await fresh.upcoming({ today });
  const afterFirst = queries;
  await fresh.upcoming({ today });

  assert.ok(afterFirst > 0, 'первый проход действительно сходил в базу');
  assert.equal(queries, afterFirst, 'второй проход обслужился кэшем — панель на каждой странице');
});

test('панель переживает ошибку базы: пусто, а не 500 на всей странице', { skip }, async () => {
  const broken = { query: async () => { throw new Error('база недоступна'); } };

  assert.deepEqual(await pgUpcomingPanel(broken).upcoming({ today: '2026-10-16' }), [],
    'ошибка данных не должна валить страницу, где панель лишь дополнение');
});