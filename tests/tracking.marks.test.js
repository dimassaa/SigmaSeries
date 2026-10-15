// Отметки серий (F-03-02).
//
// Проверяется против живой базы: «вышла серия или нет» решается по датам
// выхода из каталога, и подставные серии без выходов проверку бы не прошли.
// Каждая фикстура создаётся и убирается сама.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';
import { pgMarks } from '../src/services/tracking/marks.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — отметки не проверялись';

let pool;
let marks;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  marks = pgMarks(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_watch_mark WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)', ['mk-%']);
  await pool.query('DELETE FROM e_mark_batch WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)', ['mk-%']);
  await pool.query('DELETE FROM e_progress WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)', ['mk-%']);
  await pool.query('DELETE FROM e_watch_status WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)', ['mk-%']);
  await pool.query('DELETE FROM e_subscription WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)', ['mk-%']);
  await pool.query('DELETE FROM e_season WHERE series_id IN (SELECT id FROM e_series WHERE slug LIKE $1)', ['mk-%']);
  await pool.query('DELETE FROM e_episode WHERE season_id IN (SELECT id FROM e_season WHERE series_id IN (SELECT id FROM e_series WHERE slug LIKE $1))', ['mk-%']);
  await pool.query('DELETE FROM e_series WHERE slug LIKE $1', ['mk-%']);
  await pool.query('DELETE FROM e_user WHERE nickname LIKE $1', ['mk-%']);
  await pool.end();
});

/**
 * Сериал-фикстура: сезон, четыре серии, у трёх даты выхода в прошлом.
 *
 * @param {object} options
 * @param {number} options.aired сколько серий уже вышло
 */
async function fixture({ aired = 3, future = true } = {}) {
  const { token, hash } = makeToken();
  const id = `mk-${crypto.randomUUID()}`;
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
     VALUES ($1, 'Отметки: фикстура', 'Marks fixture', $2, 'published', 'airing', 2020) RETURNING id`,
    [id, 998000000 + (Number(id.replace(/\D/g, '').slice(0, 4)) || 1)],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id',
    [series.id],
  );

  const episodes = [];
  for (let number = 1; number <= 4; number += 1) {
    const { rows: [episode] } = await pool.query(
      'INSERT INTO e_episode (season_id, number, runtime_min) VALUES ($1, $2, 45) RETURNING id, number',
      [season.id, number],
    );
    episodes.push(episode);
  }

  // Первые `aired` серий вышли: у каждой свой выход в прошлом.
  for (let index = 0; index < aired; index += 1) {
    const { rows: [release] } = await pool.query(
      `INSERT INTO e_release (season_id, covers_season, release_date, precision, state)
       VALUES ($1, false, $2::date, 'date', 'aired') RETURNING id`,
      [season.id, daysAgo(aired - index)],
    );
    await pool.query(
      'INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)',
      [release.id, episodes[index].id],
    );
  }

  // Не вышедшая серия: дата выхода известна и находится в будущем — именно её
  // и должен назвать отказ (EC-T2).
  if (future) {
    const { rows: [release] } = await pool.query(
      `INSERT INTO e_release (season_id, covers_season, release_date, precision, state)
       VALUES ($1, false, $2::date, 'date', 'scheduled') RETURNING id`,
      [season.id, daysAhead(2)],
    );
    await pool.query(
      'INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)',
      [release.id, episodes[aired].id],
    );
  }

  return { userId: user.id, seriesId: series.id, seasonId: season.id, episodes };
}

/** Дата `days` дней назад в формате `YYYY-MM-DD`. */
function daysAgo(days) {
  return shift(-days);
}

/** Дата `days` дней вперёд. */
function daysAhead(days) {
  return shift(days);
}

function shift(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test('не вышедшая серия не отмечается, а отказ называет дату (EC-T2)', { skip }, async () => {
  const f = await fixture({ aired: 2, future: true });
  const future = f.episodes[2];

  const result = await marks.setMark({ userId: f.userId, episodeId: future.id, on: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-aired');
  assert.match(result.date ?? '', /^\d{4}-\d{2}-\d{2}$/,
    'отказ называет дату выхода: «Серия выйдет 12 октября»');

  const marked = await marks.markedOf(f.userId, f.seriesId);
  assert.equal(marked.length, 0, 'состояние не изменилось');
});

test('серия без даты выхода не отмечается и говорит об этом отдельно', { skip }, async () => {
  const f = await fixture({ aired: 2, future: false });
  const undated = f.episodes.at(-1);

  const result = await marks.setMark({ userId: f.userId, episodeId: undated.id, on: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-date', 'нет даты — это не «выйдет», это «уточняется»');
  assert.equal(result.date, undefined, 'назвать нечего, и выдумывать дату нельзя');
});

test('две быстрые отметки дают одну строку (EC-T1)', { skip }, async () => {
  const f = await fixture({ aired: 3 });

  await marks.setMark({ userId: f.userId, episodeId: f.episodes[0].id, on: true });
  const second = await marks.setMark({ userId: f.userId, episodeId: f.episodes[0].id, on: true });

  assert.equal(second.ok, true, 'повтор «поставить» не ошибка');

  const { rows } = await pool.query(
    'SELECT count(*)::int AS n, min(precision) AS precision FROM e_watch_mark WHERE user_id = $1 AND episode_id = $2',
    [f.userId, f.episodes[0].id],
  );
  assert.equal(rows[0].n, 1, 'отметка одна, а не две');
  assert.equal(rows[0].precision, 'exact', 'отметка кнопкой — точная');
});

test('снятие отметки идемпотентно', { skip }, async () => {
  const f = await fixture({ aired: 3 });
  await marks.setMark({ userId: f.userId, episodeId: f.episodes[1].id, on: true });

  const off = await marks.setMark({ userId: f.userId, episodeId: f.episodes[1].id, on: false });
  assert.equal(off.ok, true);
  const again = await marks.setMark({ userId: f.userId, episodeId: f.episodes[1].id, on: false });
  assert.equal(again.ok, true, 'снятие отсутствующей отметки не ошибка');

  const marked = await marks.markedOf(f.userId, f.seriesId);
  assert.equal(marked.length, 0);
});

test('первая отметка переводит статус в «Смотрю» (F-03-01 §8а)', { skip }, async () => {
  const f = await fixture({ aired: 3 });

  await marks.setMark({ userId: f.userId, episodeId: f.episodes[0].id, on: true });

  const { rows } = await pool.query(
    'SELECT status FROM e_watch_status WHERE user_id = $1 AND series_id = $2',
    [f.userId, f.seriesId],
  );
  assert.equal(rows[0].status, 'watching',
    'отметка без статуса — это начало просмотра');
});

test('отметка не трогает статус «Просмотрено» у идущего сериала (H-69, EC-T20)', { skip }, async () => {
  const f = await fixture({ aired: 3 });
  await pool.query(
    "INSERT INTO e_watch_status (user_id, series_id, status) VALUES ($1, $2, 'watched')",
    [f.userId, f.seriesId],
  );

  await marks.setMark({ userId: f.userId, episodeId: f.episodes[0].id, on: true });

  const { rows } = await pool.query(
    'SELECT status FROM e_watch_status WHERE user_id = $1 AND series_id = $2',
    [f.userId, f.seriesId],
  );
  assert.equal(rows[0].status, 'watched', 'статус сам не меняется: у идущего сериала это неверно');
});

test('«Отметить сезон» отмечает только вышедшие серии и даёт отмену', { skip }, async () => {
  const f = await fixture({ aired: 3 });

  const result = await marks.markSeason({ userId: f.userId, seasonId: f.seasonId });
  assert.equal(result.ok, true);
  assert.equal(result.marked, 3, 'отмечены три вышедшие серии');
  assert.ok(result.batchId, 'массовая отметка обязана быть отменяемой');

  const marked = await marks.markedOf(f.userId, f.seriesId);
  assert.equal(marked.length, 3);
  assert.ok(marked.every((item) => item.precision === 'retro'),
    'массовая отметка ретро: человек смотрел это раньше');

  const undo = await marks.undo({ userId: f.userId, batchId: result.batchId });
  assert.equal(undo.ok, true);
  assert.equal((await marks.markedOf(f.userId, f.seriesId)).length, 0,
    'отмена вернула прежнее состояние');
});

test('отменённую отметку нельзя отменить дважды (EC-T1)', { skip }, async () => {
  const f = await fixture({ aired: 2 });
  const result = await marks.markSeason({ userId: f.userId, seasonId: f.seasonId });

  await marks.undo({ userId: f.userId, batchId: result.batchId });
  const again = await marks.undo({ userId: f.userId, batchId: result.batchId });
  assert.equal(again.ok, false, 'повторная отмена ничего не делает и об этом говорит');

  await marks.setMark({ userId: f.userId, episodeId: f.episodes[0].id, on: true });
  assert.equal((await marks.markedOf(f.userId, f.seriesId)).length, 1,
    'отмена не съела новую отметку, поставленную после неё');
});

test('«Все до этой» отмечает серии по порядку, включая выбранную', { skip }, async () => {
  const f = await fixture({ aired: 3 });

  const result = await marks.markUpTo({
    userId: f.userId,
    seriesId: f.seriesId,
    season: 1,
    episode: 2,
  });
  assert.equal(result.ok, true);
  assert.equal(result.marked, 2);

  const marked = await marks.markedOf(f.userId, f.seriesId);
  assert.deepEqual(marked.map((item) => item.episodeNumber).sort((a, b) => a - b), [1, 2]);
});

test('отметки разных зрителей не путаются (R-SEC-10)', { skip }, async () => {
  const mine = await fixture({ aired: 2 });
  const theirs = await fixture({ aired: 2 });

  await marks.setMark({ userId: mine.userId, episodeId: mine.episodes[0].id, on: true });

  assert.equal((await marks.markedOf(mine.userId, mine.seriesId)).length, 1, 'у первого зрителя есть отметка');
  assert.equal((await marks.markedOf(theirs.userId, theirs.seriesId)).length, 0,
    'у второго — ничего: чужие отметки не видны и не появляются');
});

test('снятый с публикации сериал не отмечается, а его отметки остаются (EC-T9)', { skip }, async () => {
  const f = await fixture({ aired: 2 });
  await marks.setMark({ userId: f.userId, episodeId: f.episodes[0].id, on: true });

  await pool.query("UPDATE e_series SET archived_at = now() WHERE id = $1", [f.seriesId]);
  try {
    const refused = await marks.setMark({ userId: f.userId, episodeId: f.episodes[1].id, on: true });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'hidden');

    assert.equal((await marks.markedOf(f.userId, f.seriesId)).length, 1,
      'прежняя отметка на месте: её исключают из прогресса, а не стирают');
  } finally {
    await pool.query('UPDATE e_series SET archived_at = NULL WHERE id = $1', [f.seriesId]);
  }
});

test('после отметок прогресс пересчитывается и лежит в кэше', { skip }, async () => {
  const f = await fixture({ aired: 3 });
  await marks.setMark({ userId: f.userId, episodeId: f.episodes[0].id, on: true });

  const { rows } = await pool.query(
    'SELECT marked, aired FROM e_progress WHERE user_id = $1 AND series_id = $2',
    [f.userId, f.seriesId],
  );
  assert.equal(rows.length, 1, 'кэш прогресса обновился вместе с отметкой (F-03-02 §8д)');
  assert.equal(rows[0].aired, 3, 'в знаменателе три вышедшие серии');
  assert.equal(rows[0].marked, 1);
});