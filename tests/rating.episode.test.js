// Оценка серии (F-04-02).
//
// Проверяется против настоящей базы: правила модуля серверные — серия не
// отмечена, адрес не подтверждён, серия ещё не вышла, — а расхождение между
// «оценка записана» и «среднее посчитано» видно только на строках.
//
// Среднее по серии не кэшируется: в модели кэш оценок описан как
// `E-SeriesRatingStat` и ключуется сериалом, а отдельной таблицы под серии нет
// (DOMAIN-MODEL §5). Отсюда два следствия, которые здесь и проверяются:
// среднее — простое, без априора (H-79), а дозревание голоса не двигает
// рейтинг сериала: у серии нет агрегата, который можно было бы испортить.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgRatings } from '../src/services/rating/store.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';
import { RATING } from '../src/config/settings.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — оценки серий не проверялись';

/** Прошедшая дата выхода и будущая: правило «не вышла» проверяется на обеих. */
const PAST_DATE = '2020-02-01';
const FUTURE_DATE = '2999-02-01';

let pool;
let ratings;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  ratings = pgRatings(pool);
});

test.after(async () => {
  if (!pool) return;
  // Уборка в порядке внешних ключей: оценки держат серию и серию-родителя
  // (RESTRICT), сезон тоже, поэтому сначала оценки, потом сезоны (за ними
  // каскадом уйдут серии и выходы), потом сам сериал. Префикс свой и не
  // вложенный в чужой (`eprate-store-`, а не `eprate-`): файлы идут
  // параллельно, и уборка одного не должна сносить фикстуры соседа —
  // `LIKE 'eprate-%'` захватывает и `eprate-http-...`.
  await pool.query(
    `DELETE FROM e_rating WHERE series_id IN (SELECT id FROM e_series WHERE slug LIKE 'eprate-store-%')`,
  );
  await pool.query(
    `DELETE FROM e_season WHERE series_id IN (SELECT id FROM e_series WHERE slug LIKE 'eprate-store-%')`,
  );
  await pool.query(`DELETE FROM e_series WHERE slug LIKE 'eprate-store-%'`);
  await pool.end();
});

/**
 * Сериал с сериями и датами выхода.
 *
 * @param {object} [args]
 * @param {number} [args.count] сколько серий
 * @param {string} [args.date] дата выхода всех серий
 */
async function seriesWith({ count = 2, date = PAST_DATE } = {}) {
  const slug = `eprate-store-${crypto.randomUUID().slice(0, 8)}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Оценка серии', 'Episode rating', $2, 'published', 'airing', 2024) RETURNING id, slug`,
    [slug, 986_000_000 + Math.floor(Math.random() * 900)],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [series.id],
  );

  const episodes = [];
  for (let number = 1; number <= count; number += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { rows: [episode] } = await pool.query(
      `INSERT INTO e_episode (season_id, number, title_ru, runtime_min)
       VALUES ($1, $2, 'Серия', 45) RETURNING id`,
      [season.id, number],
    );
    if (date) {
      // Выход один на дату в сезоне (uq_release_season_date), поэтому серии
      // разводятся по числам месяца.
      const day = String(number).padStart(2, '0');
      // eslint-disable-next-line no-await-in-loop
      const { rows: [release] } = await pool.query(
        `INSERT INTO e_release (season_id, episode_id, release_date)
         VALUES ($1, $2, $3) RETURNING id`,
        [season.id, episode.id, date.replace('01', day)],
      );
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        'INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)',
        [release.id, episode.id],
      );
    }
    episodes.push(episode.id);
  }

  return { seriesId: series.id, slug: series.slug, seasonId: season.id, episodes };
}

/**
 * Аккаунт для оценки.
 *
 * @param {object} [args]
 * @param {boolean} [args.confirmed] адрес подтверждён
 * @param {number} [args.ageHours] сколько часов прошло с регистрации
 */
async function viewer({ confirmed = true, ageHours = 24 * 30 } = {}) {
  const { hash } = makeToken();
  const created = await pgAuthStore(pool).createUser({
    email: `eprate-${crypto.randomUUID().slice(0, 8)}@example.com`,
    nickname: `eprate-${crypto.randomUUID().slice(0, 8)}`,
    passwordHash: '$argon2id$заглушка',
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed,
  });
  await pool.query(
    `UPDATE e_user SET registered_at = now() - ($2 || ' hours')::interval, email_confirmed = $3
      WHERE id = $1`,
    [created.id, String(ageHours), confirmed],
  );
  return created.id;
}

/** Отметка серии — условие права оценить (EC-V1, H-07). */
async function mark(userId, episodeId) {
  await pool.query(
    `INSERT INTO e_watch_mark (user_id, episode_id, precision) VALUES ($1, $2, 'exact')
     ON CONFLICT DO NOTHING`,
    [userId, episodeId],
  );
}

const today = '2026-10-18';

/** Оценка «как с формы»: серия из фикстуры, значение, сегодняшняя дата. */
const setRating = ({ userId, seriesId, episodeId, value }) => ratings.setEpisodeRating({
  userId, seriesId, episodeId, value, today,
});

// ─── Право оценить серию ─────────────────────────────────────────────────────

test('без отметки серии оценка не принимается (EC-V1)', { skip }, async () => {
  const { seriesId, episodes } = await seriesWith();
  const userId = await viewer();

  const result = await setRating({ userId, seriesId, episodeId: episodes[0], value: 8 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-mark', 'причина названа: человек должен понять, чего не хватает');
  assert.equal(await ratings.ownEpisodeRating(userId, episodes[0]), null);
});

test('неподтверждённый адрес оценить серию не может', { skip }, async () => {
  const { seriesId, episodes } = await seriesWith();
  const userId = await viewer({ confirmed: false });
  await mark(userId, episodes[0]);

  const result = await setRating({ userId, seriesId, episodeId: episodes[0], value: 8 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-confirmed');
});

test('серия не вышла — оценить нельзя, даже отметив её (M3)', { skip }, async () => {
  // Отметить будущую серию нельзя, но прямой запрос отметку не спрашивает:
  // правило «не вышла» проверяется на сервере отдельно от отметки.
  const { seriesId, episodes } = await seriesWith({ date: FUTURE_DATE });
  const userId = await viewer();
  await mark(userId, episodes[0]);

  const result = await setRating({ userId, seriesId, episodeId: episodes[0], value: 8 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-aired', 'серия впереди: ни отметки, ни оценки');
  assert.equal(await ratings.ownEpisodeRating(userId, episodes[0]), null);
});

test('без даты выхода серия тоже не оценивается (M3)', { skip }, async () => {
  const { seriesId, episodes } = await seriesWith({ date: null });
  const userId = await viewer();
  await mark(userId, episodes[0]);

  const result = await setRating({ userId, seriesId, episodeId: episodes[0], value: 8 });

  assert.equal(result.reason, 'not-aired', 'дата неизвестна — «вышла» не доказано');
});

test('оценка серии вне 1–10 не принимается', { skip }, async () => {
  const { seriesId, episodes } = await seriesWith();
  const userId = await viewer();
  await mark(userId, episodes[0]);

  for (const value of [0, 11, 7.5, -3]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await setRating({ userId, seriesId, episodeId: episodes[0], value });
    assert.equal(result.ok, false, `значение ${value} не должно приниматься`);
    assert.equal(result.reason, 'range');
  }
});

test('отметка одной серии не открывает оценку соседней (H-07)', { skip }, async () => {
  const { seriesId, episodes } = await seriesWith();
  const userId = await viewer();
  await mark(userId, episodes[0]);

  const result = await setRating({ userId, seriesId, episodeId: episodes[1], value: 9 });

  assert.equal(result.reason, 'no-mark', 'для серии нужна отметка этой серии, а не любой');
});

// ─── Запись и среднее ────────────────────────────────────────────────────────

test('оценка серии сохраняется и попадает в среднее', { skip }, async () => {
  const { seriesId, episodes } = await seriesWith();
  const userId = await viewer();
  await mark(userId, episodes[0]);

  const result = await setRating({ userId, seriesId, episodeId: episodes[0], value: 8 });

  assert.equal(result.ok, true);
  const summary = await ratings.episodeSummary(episodes[0]);
  assert.equal(summary.votes, 1);
  assert.equal(summary.sum, 8);
  assert.equal(summary.average, 8, 'среднее серии — простое: один голос даёт его значение');
});

test('повтор той же оценки не удваивает голос (EC-V20)', { skip }, async () => {
  const { seriesId, episodes } = await seriesWith();
  const userId = await viewer();
  await mark(userId, episodes[0]);

  await setRating({ userId, seriesId, episodeId: episodes[0], value: 9 });
  await setRating({ userId, seriesId, episodeId: episodes[0], value: 9 });

  const summary = await ratings.episodeSummary(episodes[0]);
  assert.equal(summary.votes, 1, 'один человек — одна оценка серии');
  assert.equal(summary.sum, 9);
});

test('смена оценки меняет среднее серии (EC-V3)', { skip }, async () => {
  const { seriesId, episodes } = await seriesWith();
  const userId = await viewer();
  await mark(userId, episodes[0]);

  await setRating({ userId, seriesId, episodeId: episodes[0], value: 10 });
  await setRating({ userId, seriesId, episodeId: episodes[0], value: 4 });

  const summary = await ratings.episodeSummary(episodes[0]);
  assert.equal(summary.votes, 1, 'голос остался один');
  assert.equal(summary.average, 4, 'среднее считается по новому значению');
});

test('снятие оценки убирает голос из среднего серии', { skip }, async () => {
  const { seriesId, episodes } = await seriesWith();
  const userId = await viewer();
  await mark(userId, episodes[0]);
  await setRating({ userId, seriesId, episodeId: episodes[0], value: 10 });

  const removed = await ratings.removeEpisodeRating({ userId, episodeId: episodes[0], today });

  assert.equal(removed.ok, true);
  assert.equal((await ratings.episodeSummary(episodes[0])).votes, 0);
  assert.equal(await ratings.ownEpisodeRating(userId, episodes[0]), null);
});

test('среднее серии не сглаживается априором (H-79)', { skip }, async () => {
  // Отличие серии от сериала: у серии мало голосов, и априор «среднее мнение»
  // показывал бы у всех серий одно и то же число.
  const { seriesId, episodes } = await seriesWith();
  const first = await viewer();
  const second = await viewer();
  await mark(first, episodes[0]);
  await mark(second, episodes[0]);

  await setRating({ userId: first, seriesId, episodeId: episodes[0], value: 2 });
  await setRating({ userId: second, seriesId, episodeId: episodes[0], value: 3 });

  const summary = await ratings.episodeSummary(episodes[0]);
  assert.equal(summary.average, 2.5, 'простое среднее, без априора');
  assert.equal(summary.shown, false, `порог показа серии — ${RATING.minVotesEpisode}`);
});

test('мало оценок: число появляется на третьем голосе', { skip }, async () => {
  const { seriesId, episodes } = await seriesWith();
  for (let i = 1; i <= RATING.minVotesEpisode; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const userId = await viewer();
    // eslint-disable-next-line no-await-in-loop
    await mark(userId, episodes[0]);
    // eslint-disable-next-line no-await-in-loop
    await setRating({ userId, seriesId, episodeId: episodes[0], value: i * 2 });
    // eslint-disable-next-line no-await-in-loop
    const summary = await ratings.episodeSummary(episodes[0]);
    assert.equal(
      summary.shown,
      i >= RATING.minVotesEpisode,
      `на ${i} голосах показ ${i >= RATING.minVotesEpisode ? 'открыт' : 'закрыт'}`,
    );
  }
});

test('оценки соседних серий не смешиваются', { skip }, async () => {
  const { seriesId, episodes } = await seriesWith();
  const userId = await viewer();
  await mark(userId, episodes[0]);
  await mark(userId, episodes[1]);

  await setRating({ userId, seriesId, episodeId: episodes[0], value: 3 });
  await setRating({ userId, seriesId, episodeId: episodes[1], value: 9 });

  assert.equal((await ratings.episodeSummary(episodes[0])).average, 3);
  assert.equal((await ratings.episodeSummary(episodes[1])).average, 9);
  assert.equal((await ratings.ownEpisodeRating(userId, episodes[0])).value, 3);
  assert.equal((await ratings.ownEpisodeRating(userId, episodes[1])).value, 9);
});

test('средние серий читаются пачкой, одной выборкой (измерение 14)', { skip }, async () => {
  const { seriesId, episodes } = await seriesWith({ count: 3 });
  const userId = await viewer();
  for (const episodeId of episodes) {
    // eslint-disable-next-line no-await-in-loop
    await mark(userId, episodeId);
  }
  await setRating({ userId, seriesId, episodeId: episodes[1], value: 6 });

  const summaries = await ratings.episodeSummaries(episodes);

  assert.equal(summaries.get(episodes[0]).votes, 0);
  assert.equal(summaries.get(episodes[1]).votes, 1);
  assert.equal(summaries.get(episodes[1]).average, 6);
  assert.equal(summaries.get(episodes[2]).votes, 0);
});

// ─── Возраст аккаунта (EC-V4) ────────────────────────────────────────────────

test('голос младшего аккаунта сохранён, но в среднее серии не входит (EC-V4)', { skip }, async () => {
  const { seriesId, episodes } = await seriesWith();
  const userId = await viewer({ ageHours: RATING.minAccountAgeH - 1 });
  await mark(userId, episodes[0]);

  const result = await setRating({ userId, seriesId, episodeId: episodes[0], value: 10 });

  assert.equal(result.ok, true, 'оценка сохранена — человек поставил её законно');
  assert.equal(result.counted, false, 'в рейтинг сайта она не входит');
  const summary = await ratings.episodeSummary(episodes[0]);
  assert.equal(summary.votes, 0, 'чужое мнение не сдвинуто');
  const own = await ratings.ownEpisodeRating(userId, episodes[0]);
  assert.equal(own.value, 10, 'оценка видна своему автору');
  assert.equal(own.counted, false);
  assert.ok(own.maturesAt instanceof Date, 'автору показано, когда голос учтут (EC-V4)');
});

test('дозревание голоса серии не двигает рейтинг сериала (EC-V4)', { skip }, async () => {
  // Дозревание — общий проход: он вводит и сериальные оценки, и серийные.
  // Серийный голос не имеет права попасть в агрегат сериала: тот считает
  // оценки сериала, а не серий.
  const { seriesId, episodes } = await seriesWith();
  const userId = await viewer({ ageHours: RATING.minAccountAgeH - 1 });
  await mark(userId, episodes[0]);
  await setRating({ userId, seriesId, episodeId: episodes[0], value: 5 });

  await pool.query(
    `UPDATE e_user SET registered_at = registered_at - interval '2 days' WHERE id = $1`, [userId],
  );
  await ratings.countMaturedRatings(new Date());

  const own = await ratings.ownEpisodeRating(userId, episodes[0]);
  assert.equal(own.counted, true, 'серийный голос дозрел');
  assert.equal(
    (await ratings.statOf(seriesId)).votes,
    0,
    'оценка серии не становится оценкой сериала',
  );
  assert.equal((await ratings.episodeSummary(episodes[0])).votes, 1, 'и вошла в среднее серии');
});
