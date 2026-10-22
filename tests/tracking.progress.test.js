// Прогресс и «следующая серия» (F-03-03, OP-10).
//
// Считается по отметкам и выходам, а не берётся из одного места: кэш
// `e_progress` ускоряет список закладок, но решение «что показывать» принимается
// здесь, потому что правила OP-10 живут в коде и должны проверяться тестом.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';
import { pgProgress } from '../src/services/tracking/progress.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — прогресс не проверялся';

let pool;
let progress;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  progress = pgProgress(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_watch_mark WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)', ['pg-%']);
  await pool.query('DELETE FROM e_mark_batch WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)', ['pg-%']);
  await pool.query('DELETE FROM e_progress WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)', ['pg-%']);
  await pool.query('DELETE FROM e_watch_status WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)', ['pg-%']);
  await pool.query('DELETE FROM e_subscription WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)', ['pg-%']);
  await pool.query('DELETE FROM e_season WHERE series_id IN (SELECT id FROM e_series WHERE slug LIKE $1)', ['pg-%']);
  await pool.query('DELETE FROM e_episode WHERE season_id IN (SELECT id FROM e_season WHERE series_id IN (SELECT id FROM e_series WHERE slug LIKE $1))', ['pg-%']);
  await pool.query('DELETE FROM e_series WHERE slug LIKE $1', ['pg-%']);
  await pool.query('DELETE FROM e_user WHERE nickname LIKE $1', ['pg-%']);
  await pool.end();
});

function shift(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Сериал-фикстура: сезон с восемью вышедшими сериями и одна будущая.
 *
 * @param {object} options
 * @param {any} [options.aired]
 * @param {any} [options.future]
 * @param {number[]} [options.markedWith] номера отмеченных серий
 */
async function fixture({ markedWith = [], aired = 8, future = true } = {}) {
  const { token, hash } = makeToken();
  const id = `pg-${crypto.randomUUID()}`;
  void token;
  const user = await pgAuthStore(pool).createUser({
    email: `${id}@example.com`,
    nickname: id,
    passwordHash: '$argon2id$заглушка',
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
  });

  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Прогресс: фикстура', 'Progress fixture', $2, 'published', 'airing', 2020) RETURNING id`,
    [id, 996000000 + (Number(id.replace(/\D/g, '').slice(0, 4)) || 1)],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id',
    [series.id],
  );

  const episodes = [];
  for (let number = 1; number <= aired + (future ? 1 : 0); number += 1) {
    const { rows: [episode] } = await pool.query(
      'INSERT INTO e_episode (season_id, number, runtime_min) VALUES ($1, $2, 45) RETURNING id, number',
      [season.id, number],
    );
    episodes.push(episode);
  }

  for (let index = 0; index < aired; index += 1) {
    const { rows: [release] } = await pool.query(
      `INSERT INTO e_release (season_id, covers_season, release_date, precision, state)
       VALUES ($1, false, $2::date, 'date', 'aired') RETURNING id`,
      [season.id, shift(-(aired - index))],
    );
    await pool.query('INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)', [release.id, episodes[index].id]);
  }
  if (future) {
    const { rows: [release] } = await pool.query(
      `INSERT INTO e_release (season_id, covers_season, release_date, precision, state)
       VALUES ($1, false, $2::date, 'date', 'scheduled') RETURNING id`,
      [season.id, shift(3)],
    );
    await pool.query('INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)', [release.id, episodes[aired].id]);
  }

  for (const number of markedWith) {
    await pool.query(
      `INSERT INTO e_watch_mark (user_id, episode_id, precision) VALUES ($1, $2, 'exact')
       ON CONFLICT DO NOTHING`,
      [user.id, episodes[number - 1].id],
    );
  }

  return { userId: user.id, seriesId: series.id, episodes };
}

test('прогресс — отмеченные из вышедших (OP-10а)', { skip }, async () => {
  const f = await fixture({ markedWith: [1, 2, 3, 5] });

  const p = await progress.of({ userId: f.userId, seriesId: f.seriesId });
  assert.equal(p.aired, 8, 'восемь вышедших серий в знаменателе');
  assert.equal(p.marked, 4);
  assert.equal(p.percent, 50);
  assert.equal(p.state, 'in-progress');
  assert.equal(p.totalEpisodes, 8, 'в знаменателе только вышедшие: девятая ещё не вышла');
});

test('следующая — первая неотмеченная после последней отмеченной (OP-10б)', { skip }, async () => {
  const f = await fixture({ markedWith: [1, 2, 3, 5] });

  const p = await progress.of({ userId: f.userId, seriesId: f.seriesId });
  assert.equal(p.marked, 4, 'отмечено четыре серии из восьми вышедших');
  assert.equal(p.nextEpisode, 6,
    'после пятой отмеченной идёт шестая: предлагать четвёртую — значит предлагать то, что человек пролистал');
  assert.equal(p.skipped, 1, 'четвёртая помечена пропущенной');
});

test('всё вышедшее отмечено — «ждём серию», а не «следующая» (EC-T10)', { skip }, async () => {
  const f = await fixture({ markedWith: [1, 2, 3, 4, 5, 6, 7, 8] });

  const p = await progress.of({ userId: f.userId, seriesId: f.seriesId });
  assert.equal(p.nextEpisode, null, 'смотреть нечего: все вышедшие отмечены');
  assert.equal(p.state, 'all-aired-watched');
  assert.equal(p.awaitingDate, shift(3), 'и показано, когда выйдет следующая');
});

test('пропуск до последней отмеченной виден и не путается с «следующей» (EC-T11)', { skip }, async () => {
  const f = await fixture({ markedWith: [1, 2, 5, 6] });

  const p = await progress.of({ userId: f.userId, seriesId: f.seriesId });
  assert.equal(p.nextEpisode, 7, 'следующая — после шестой, а не с начала');
  assert.equal(p.skipped, 2, 'третья и четвёртая — пропуски');
  assert.equal(p.marked, 4);
});

test('пропуск внутри просмотренного не ломает «следующую» (EC-T11)', { skip }, async () => {
  const f = await fixture({ markedWith: [1, 3] });

  const p = await progress.of({ userId: f.userId, seriesId: f.seriesId });
  assert.equal(p.nextEpisode, 4, 'после третьей отмеченной идёт четвёртая');
  assert.equal(p.skipped, 1, 'вторая — пропуск');
});

test('ничего не отмечено — «не начато», а не «нулевой прогресс»', { skip }, async () => {
  const f = await fixture({ markedWith: [] });

  const p = await progress.of({ userId: f.userId, seriesId: f.seriesId });
  assert.equal(p.marked, 0);
  assert.equal(p.state, 'not-started');
  assert.equal(p.nextEpisode, 1, 'продолжать есть с чего — по вкусу человека');
});

test('нет вышедших серий — «график уточняется» (F-03-03 §5)', { skip }, async () => {
  const f = await fixture({ markedWith: [], aired: 0, future: true });

  const p = await progress.of({ userId: f.userId, seriesId: f.seriesId });
  assert.equal(p.aired, 0);
  assert.equal(p.state, 'no-airdates');
  assert.equal(p.nextEpisode, null, 'смотреть нечего: ни одна серия не вышла');
});

test('чужой прогресс не показывается (R-SEC-10)', { skip }, async () => {
  const mine = await fixture({ markedWith: [1] });
  const theirs = await fixture({ markedWith: [1, 2, 3] });

  const mineView = await progress.of({ userId: mine.userId, seriesId: mine.seriesId });
  assert.equal(mineView.marked, 1, 'у первого зрителя своя одна отметка');

  const theirsView = await progress.of({ userId: theirs.userId, seriesId: theirs.seriesId });
  assert.equal(theirsView.marked, 3);
});

test('кэш переживает удаление и строится заново', { skip }, async () => {
  const f = await fixture({ markedWith: [1, 2] });

  await pool.query('DELETE FROM e_progress WHERE user_id = $1 AND series_id = $2', [f.userId, f.seriesId]);
  const p = await progress.of({ userId: f.userId, seriesId: f.seriesId });
  assert.equal(p.marked, 2, 'без кэша прогресс посчитан заново');

  const { rows } = await pool.query(
    'SELECT marked, aired FROM e_progress WHERE user_id = $1 AND series_id = $2',
    [f.userId, f.seriesId],
  );
  assert.equal(rows.length, 1, 'и кэш снова на месте');
  assert.equal(rows[0].marked, 2);
});

test('кэш для списка закладок считает все сериалы разом', { skip }, async () => {
  const a = await fixture({ markedWith: [1, 2, 3] });
  const b = await fixture({ markedWith: [1] });

  const many = await progress.forSeries({ userId: a.userId, seriesIds: [a.seriesId, b.seriesId] });
  assert.equal(many.size, 2, 'по одному сериалу на запись');
  assert.equal(many.get(a.seriesId).marked, 3);
  assert.equal(many.get(b.seriesId).marked, 0, 'у чужого сериала при этом зрителе отметок нет');
});

test('скрытая админом серия исключается из знаменателя, отметки остаются (EC-T9)', { skip }, async () => {
  const f = await fixture({ markedWith: [1] });
  await pool.query("UPDATE e_series SET archived_at = now() WHERE id = $1", [f.seriesId]);

  try {
    const hidden = await progress.of({ userId: f.userId, seriesId: f.seriesId });
    assert.equal(hidden.visible, false, 'скрытый сериал не показывается как активный');

    await pool.query('UPDATE e_series SET archived_at = NULL WHERE id = $1', [f.seriesId]);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM e_watch_mark WHERE user_id = $1 AND episode_id = ANY($2::bigint[])',
      [f.userId, f.episodes.map((episode) => episode.id)],
    );
    assert.equal(rows[0].n, 1, 'отметка не исчезла вместе со снятием с публикации');
  } finally {
    await pool.query('UPDATE e_series SET archived_at = NULL WHERE id = $1', [f.seriesId]);
  }
});