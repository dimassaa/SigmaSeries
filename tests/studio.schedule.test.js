// График серий в студии (F-10-05).
//
// Проверяется то, что легко испортить: ручная дата закрывается от импорта,
// генератор считает даты по дням недели, а состояние выхода пересчитывается
// сразу после правки.

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { pgStudioSchedule } from '../src/services/studio/schedule.js';

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

const skip = CONN ? false : 'нет подключения к базе — график серий не проверялся';

/**
 * Дата из базы в виде строки: драйвер отдаёт объект Date.
 *
 * @param {Date|string|null} value
 * @returns {string}
 */
function iso(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

let pool;
let schedule;
let seriesId;
let seasonId;
let episodeId;

test.before(async () => {
  if (!CONN) return;
  pool = new pg.Pool(CONN);
  await pool.query('select 1');
  schedule = pgStudioSchedule(pool);

  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, imdb_key, title_ru, title_original, year_start, exit_state, publication_state, reasons, level)
     VALUES ($1, $2, 'Сериал для графика', 'Schedule series', 2020, 'announced', 'published', '{}', 'minimum')
     RETURNING id`,
    [`schedule-${crypto.randomUUID().slice(0, 8)}`, `tt${crypto.randomUUID().slice(0, 8)}`],
  );
  seriesId = series.id;

  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [seriesId],
  );
  seasonId = season.id;

  const { rows: [episode] } = await pool.query(
    'INSERT INTO e_episode (season_id, number) VALUES ($1, 1) RETURNING id', [seasonId],
  );
  episodeId = episode.id;
});

test.after(async () => {
  if (pool && seriesId) {
    // Сначала выходы, потом сезоны, потом сериал: ограничения на удаление
    // строгие, и порядок освобождения строк важен.
    await pool.query('DELETE FROM e_release WHERE season_id = $1', [seasonId]);
    await pool.query('DELETE FROM e_episode WHERE season_id = $1', [seasonId]);
    await pool.query('DELETE FROM e_season WHERE id = $1', [seasonId]);
    await pool.query('DELETE FROM e_series WHERE id = $1', [seriesId]);
  }
  if (pool) await pool.end();
});

test('сезоны сериала читаются с сериями (F-10-05 §4)', { skip }, async () => {
  const seasons = await schedule.forSeries(seriesId);
  assert.equal(seasons.length, 1);
  assert.equal(seasons[0].episodes.length, 1);
  assert.equal(seasons[0].episodes[0].number, 1);
});

test('ручная дата ставится и закрывается от импорта (F-10-05 §8а)', { skip }, async () => {
  const result = await schedule.setDate({
    seriesId, seasonId, episodeId, date: '2026-11-05', byId: null,
  });
  assert.equal(result.ok, true);

  const seasons = await schedule.forSeries(seriesId);
  const episode = seasons[0].episodes[0];
  assert.equal(iso(episode.date), '2026-11-05', 'дата стоит');
  assert.equal(episode.locked, true, 'дата закрыта от импорта');
});

test('генератор считает даты по дням недели с шагом в неделю (F-10-05 §19)', { skip }, async () => {
  // Вторник и четверг, начиная с понедельника 2 ноября 2026.
  const result = await schedule.generate({
    seriesId,
    seasonNumber: 1,
    count: 4,
    weekdays: ['tue', 'thu'],
    from: '2026-11-02',
    step: 'week',
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, 1, 'одна серия в сезоне получила дату');

  const { rows } = await pool.query(
    `SELECT release_date::text AS day FROM e_release
      WHERE season_id = $1 AND episode_id = $2`,
    [seasonId, episodeId],
  );
  const day = rows[0].day;
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  assert.ok(weekday === 2 || weekday === 4, `дата попала на вторник или четверг: ${day}`);
});

test('сдвиг дат меняет их на N дней (F-10-05 §4)', { skip }, async () => {
  const before = await schedule.forSeries(seriesId);
  const date = before[0].episodes[0].date;
  const moved = await schedule.shift({ seriesId, days: 3, byId: null });
  assert.ok(moved >= 1, 'даты сдвинуты');

  const after = await schedule.forSeries(seriesId);
  const diff = (new Date(after[0].episodes[0].date) - new Date(date)) / 86_400_000;
  assert.equal(diff, 3, 'сдвиг ровно на три дня');
});

test('состояние выхода пересчитывается после правки (F-10-05 §8д)', { skip }, async () => {
  const { rows } = await pool.query('SELECT exit_state FROM e_series WHERE id = $1', [seriesId]);
  assert.ok(['airing', 'announced', 'waiting'].includes(rows[0].exit_state),
    `состояние выхода осмысленное: ${rows[0].exit_state}`);
});

test('некорректная дата отклоняется (F-10-05 §9)', { skip }, async () => {
  const result = await schedule.setDate({
    seriesId, seasonId, episodeId, date: 'не дата', byId: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'date');
});
