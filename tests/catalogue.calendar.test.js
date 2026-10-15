// Календарь (F-03-05, S-16, OP-08).
//
// Проверяется против живой базы: выходов 87 тысяч, из них будущих — десятки,
// и правила, которые видны на странице («все 8 серий», «не больше трёх записей
// в ячейке»), собираются из данных импорта, а не из фикстур.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';
import {
  DEFAULT_MAX_RANGE_DAYS,
  pgCalendar,
  shiftedDate,
} from '../src/services/catalogue/calendar.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — календарь не проверялся';

let pool;
let calendar;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  calendar = pgCalendar(pool);
});

test.after(async () => {
  if (pool) await pool.end();
});

/** Первый день месяца, в котором что-то выходит. */
async function monthWithReleases() {
  const { rows } = await pool.query(
    `SELECT date_trunc('month', release_date)::date AS month, count(*)::int AS n
       FROM e_release
      WHERE release_date > CURRENT_DATE
      GROUP BY 1 ORDER BY n DESC LIMIT 1`,
  );
  assert.ok(rows.length, 'в базе есть будущие выходы');
  return rows[0].month;
}

test('диапазон длиннее предела обрезается, а не отклоняется (F-03-05 §5)', { skip }, async () => {
  const { rows } = await pool.query(
    'SELECT value FROM e_system_setting WHERE key = $1',
    ['calendar.max_range_days'],
  );
  const limit = rows[0] ? Number(rows[0].value) : DEFAULT_MAX_RANGE_DAYS;
  assert.equal(limit, DEFAULT_MAX_RANGE_DAYS, 'предел в настройках совпадает с правилом модуля');

  const page = await calendar.days({ from: '2026-10-01', to: '2027-06-01' });
  assert.ok(page.to <= addDays('2026-10-01', limit - 1),
    `диапазон обрезан до ${limit} дней, а вышел до ${page.to}`);
});

test('выходы приходят по дням и внутри дня по времени, затем по названию', { skip }, async () => {
  const month = await monthWithReleases();
  const page = await calendar.days({ from: month, to: addDays(month, 30) });

  assert.ok(page.total > 0, 'в месяце есть выходы');
  const dates = [...page.days.keys()];
  assert.deepEqual(dates, [...dates].sort(), 'дни идут по порядку');

  for (const [date, entries] of page.days) {
    const times = entries.map((entry) => entry.time ?? '99:99');
    const sorted = [...entries].sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99')
      || a.seriesTitle.localeCompare(b.seriesTitle));
    assert.deepEqual(entries, sorted, `день ${date}: время, затем название`);
  }
});

test('выходы невидимых сериалов в календаре нет', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT s.slug FROM e_release r
       JOIN e_season se ON se.id = r.season_id
       JOIN e_series s ON s.id = se.series_id
      WHERE s.publication_state <> 'published' OR s.archived_at IS NOT NULL
      LIMIT 1`,
  );
  if (!rows.length) return;   // таких строк в базе нет

  const page = await calendar.days({ from: '1959-01-01', to: '2027-12-31' });
  const slugs = [...page.days.values()].flat().map((entry) => entry.seriesSlug);
  assert.ok(!slugs.includes(rows[0].slug),
    `в календаре виден неопубликованный сериал «${rows[0].slug}»`);
});

test('серии с одной датой образуют одну запись «N серий» (EC-D11, EC-T6)', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT r.release_date::text AS date, r.id, count(rle.episode_id)::int AS n
       FROM e_release r
       JOIN e_release_episode rle ON rle.release_id = r.id
      WHERE r.release_date > CURRENT_DATE
      GROUP BY r.id, r.release_date
     HAVING count(rle.episode_id) > 2
      LIMIT 1`,
  );
  if (!rows.length) {
    assert.ok(true, 'групп выхода в будущем нет — проверять нечего');
    return;
  }

  const page = await calendar.days({ from: rows[0].date, to: rows[0].date });
  const entries = page.days.get(rows[0].date) ?? [];
  const group = entries.find((entry) => entry.id === rows[0].id);

  assert.ok(group, 'запись группы видна в календаре');
  assert.equal(group.kind, 'group', 'больше одной серии — это группа, а не серия');
  assert.equal(group.episodeCount, rows[0].n, 'число серий в группе названо верно');
  assert.deepEqual(group.episodeNumbers, [], 'у группы нет одного номера — их несколько');
});

test('выход за весь сезон помечен явно, а не угадан по связям (DEC-056)', { skip }, async () => {
  const { rows: [seasonRow] } = await pool.query(
    `SELECT id, slug FROM e_series
      WHERE publication_state = 'published' AND archived_at IS NULL
        AND EXISTS (SELECT 1 FROM e_season se WHERE se.series_id = e_series.id AND se.number > 0)
      LIMIT 1`,
  );
  assert.ok(seasonRow, 'в каталоге есть опубликованный сериал с сезоном');

  const { rows: [season] } = await pool.query(
    'SELECT id FROM e_season WHERE series_id = $1 AND number > 0 LIMIT 1',
    [seasonRow.id],
  );
  const { rows: [whole] } = await pool.query(
    `INSERT INTO e_release (season_id, covers_season, release_date, precision, state)
     VALUES ($1, true, CURRENT_DATE + 5, 'date', 'scheduled') RETURNING id, release_date::text AS date`,
    [season.id],
  );
  const { rows: [one] } = await pool.query(
    `INSERT INTO e_release (season_id, covers_season, release_date, precision, state)
     VALUES ($1, false, CURRENT_DATE + 5, 'date', 'scheduled') RETURNING id, release_date::text AS date`,
    [season.id],
  );
  // Одна связь — выход одной серии: без колонки он неотличим от сезонного.
  const { rows: [episode] } = await pool.query(
    'SELECT id FROM e_episode WHERE season_id = $1 AND number > 0 LIMIT 1',
    [season.id],
  );
  await pool.query(
    'INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)',
    [one.id, episode.id],
  );

  try {
    const page = await calendar.days({ from: whole.date, to: whole.date });
    const entries = page.days.get(whole.date) ?? [];

    const seasonEntry = entries.find((item) => item.id === whole.id);
    assert.ok(seasonEntry, 'сезонный выход виден');
    assert.equal(seasonEntry.kind, 'season', 'помеченный сезон виден как сезон');

    const single = entries.find((item) => item.id === one.id);
    assert.equal(single?.kind, 'episode',
      'выход одной серии остаётся серией, а не превращается в сезон');
  } finally {
    await pool.query('DELETE FROM e_release_episode WHERE release_id IN ($1, $2)', [whole.id, one.id]);
    await pool.query('DELETE FROM e_release WHERE id IN ($1, $2)', [whole.id, one.id]);
  }
});

test('выход без состава и без отметки сезона в календарь не попадает', { skip }, async () => {
  const { rows: [season] } = await pool.query(
    `SELECT se.id FROM e_season se
       JOIN e_series s ON s.id = se.series_id
      WHERE s.publication_state = 'published' AND s.archived_at IS NULL AND se.number > 0
      LIMIT 1`,
  );
  assert.ok(season, 'в каталоге есть видимый сезон');

  const { rows: [empty] } = await pool.query(
    `INSERT INTO e_release (season_id, covers_season, release_date, precision, state)
     VALUES ($1, false, CURRENT_DATE + 6, 'date', 'scheduled')
     RETURNING id, release_date::text AS date`,
    [season.id],
  );

  try {
    const page = await calendar.days({ from: empty.date, to: empty.date });
    const entries = page.days.get(empty.date) ?? [];
    assert.ok(!entries.some((item) => item.id === empty.id),
      'запись без серий и без отметки сезона показать нечем — она молча убрана');
  } finally {
    await pool.query('DELETE FROM e_release WHERE id = $1', [empty.id]);
  }
});

test('состояние выхода доходит до записи: перенесённый виден как перенесённый', { skip }, async () => {
  const { rows: [season] } = await pool.query(
    `SELECT se.id FROM e_season se
       JOIN e_series s ON s.id = se.series_id
      WHERE s.publication_state = 'published' AND s.archived_at IS NULL AND se.number > 0
      LIMIT 1`,
  );
  const { rows: [postponed] } = await pool.query(
    `INSERT INTO e_release (season_id, covers_season, release_date, precision, state)
     VALUES ($1, true, CURRENT_DATE + 7, 'date', 'delayed') RETURNING id, release_date::text AS date`,
    [season.id],
  );

  try {
    const page = await calendar.days({ from: postponed.date, to: postponed.date });
    const entry = (page.days.get(postponed.date) ?? []).find((item) => item.id === postponed.id);
    assert.equal(entry?.state, 'delayed',
      'показать «12 октября» для перенесённого выхода — значит обмануть человека');
  } finally {
    await pool.query('DELETE FROM e_release WHERE id = $1', [postponed.id]);
  }
});

test('выход серии несёт номер и дату', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT r.release_date::text AS date, rle.episode_id, e.number, se.number AS season
       FROM e_release r
       JOIN e_release_episode rle ON rle.release_id = r.id
       JOIN e_episode e ON e.id = rle.episode_id
       JOIN e_season se ON se.id = r.season_id
      WHERE r.release_date > CURRENT_DATE AND se.number > 0
      LIMIT 1`,
  );
  if (!rows.length) return;   // будущих выходов серий нет

  const page = await calendar.days({ from: rows[0].date, to: rows[0].date });
  const entries = page.days.get(rows[0].date) ?? [];
  const found = entries.find((entry) => entry.kind === 'episode' && entry.seriesSlug);

  assert.ok(found, 'выход серии виден в календаре');
  assert.ok(found.episodeNumbers.includes(rows[0].number),
    `в записи есть номер серии ${rows[0].number}`);
  assert.ok(found.seasonNumber > 0, 'номер сезона известен — подпись «S2E5» его использует');
});

test('выходы по «моим» идут только по подписке', { skip }, async () => {
  const month = await monthWithReleases();
  const store = pgAuthStore(pool);
  const { token, hash } = makeToken();
  const id = `cal-${crypto.randomUUID()}`;
  const { user } = { user: await store.createUser({
    email: `${id}@example.com`,
    nickname: id,
    passwordHash: '$argon2id$заглушка',
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
  }) };
  void token;

  const { rows: [target] } = await pool.query(
    `SELECT s.id, s.slug FROM e_series s
      JOIN e_season se ON se.series_id = s.id
      JOIN e_release r ON r.season_id = se.id
     WHERE s.publication_state = 'published' AND s.archived_at IS NULL
       AND r.release_date >= $1 AND r.release_date <= $2
     LIMIT 1`,
    [month, addDays(month, 30)],
  );

  try {
    const all = await calendar.days({ from: month, to: addDays(month, 30) });
    assert.ok(all.total > 0, 'без фильтра выходы есть');

    const mine = await calendar.days({ from: month, to: addDays(month, 30), userId: user.id });
    assert.equal(mine.total, 0, 'без подписок «мои» пусты, а не показывают чужое');

    await pool.query(
      `INSERT INTO e_subscription (user_id, series_id, kind, source) VALUES ($1, $2, 'release', 'manual')`,
      [user.id, target.id],
    );
    const subscribed = await calendar.days({ from: month, to: addDays(month, 30), userId: user.id });
    const slugs = [...subscribed.days.values()].flat().map((entry) => entry.seriesSlug);
    assert.ok(subscribed.total > 0, 'после подписки выходы появились');
    assert.deepEqual([...new Set(slugs)], [target.slug],
      'видны только выходы того сериала, на который подписались');
  } finally {
    await pool.query('DELETE FROM e_subscription WHERE user_id = $1', [user.id]);
    await pool.query('DELETE FROM e_user WHERE id = $1', [user.id]);
    void store;
  }
});

test('выключенная подписка не показывает выходы', { skip }, async () => {
  const store = pgAuthStore(pool);
  const { token, hash } = makeToken();
  const id = `cal-${crypto.randomUUID()}`;
  const user = await store.createUser({
    email: `${id}@example.com`,
    nickname: id,
    passwordHash: '$argon2id$заглушка',
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
  });
  void token;

  const { rows: [target] } = await pool.query(
    `SELECT s.id FROM e_series s
       JOIN e_season se ON se.series_id = s.id
       JOIN e_release r ON r.season_id = se.id
      WHERE s.publication_state = 'published' AND s.archived_at IS NULL
        AND r.release_date > CURRENT_DATE LIMIT 1`,
  );
  if (!target) {
    await pool.query('DELETE FROM e_user WHERE id = $1', [user.id]);
    return;
  }

  try {
    await pool.query(
      `INSERT INTO e_subscription (user_id, series_id, kind, source, enabled)
       VALUES ($1, $2, 'release', 'manual', false)`,
      [user.id, target.id],
    );
    const page = await calendar.days({ from: '2026-01-01', to: '2027-12-31', userId: user.id });
    assert.equal(page.total, 0, 'выключенная подписка — это не подписка');
  } finally {
    await pool.query('DELETE FROM e_subscription WHERE user_id = $1', [user.id]);
    await pool.query('DELETE FROM e_user WHERE id = $1', [user.id]);
    void store;
  }
});

// ─── Правила без базы: часовой пояс (OP-08а, EC-T3, EC-T4) ────────────────

test('дата без времени не сдвигается при смене пояса (OP-08а)', () => {
  assert.equal(shiftedDate('2026-10-12', null, null, 'Asia/Tokyo'), '2026-10-12');
  assert.equal(shiftedDate('2026-10-12', null, null, 'America/Los_Angeles'), '2026-10-12');
});

test('дата со временем переезжает в соседний день пояса (EC-T3)', () => {
  // 23:30 в Лос-Анджелесе — уже следующий день в Токио.
  assert.equal(shiftedDate('2026-10-12', '23:30', 'America/Los_Angeles', 'Asia/Tokyo'), '2026-10-13');
  // И наоборот: раннее утро в Токио всё ещё вчерашнее в Лос-Анджелесе.
  assert.equal(shiftedDate('2026-10-12', '08:00', 'Asia/Tokyo', 'America/Los_Angeles'), '2026-10-11');
});

test('неизвестный пояс не ломает дату (EC-T4)', () => {
  assert.equal(shiftedDate('2026-10-12', '23:30', 'Europe/Minsk', 'Не/Существует'), '2026-10-12',
    'при негодном поясе остаётся дата из базы, а не пустота');
});

/** Дата через N дней, без часового пояса: арифметика календаря. */
function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}