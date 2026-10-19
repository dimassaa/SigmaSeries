// Оценка сериала (F-04-01, OP-03).
//
// Проверяется против настоящей базы: заглушка не отличает «оценка записана»
// от «агрегат пересчитан», а именно расхождение между ними и есть главный
// риск этого модуля. Плюс правила, которые видно только на сервере: оценить
// без отметки, оценить неподтверждённым, оценить дважды.
//
// Агрегат приходит из `e_series_rating_stat`, а не подсчётом по строкам:
// рейтинг читается на каждой странице сериала, и подсчёт на странице — это
// двадцать запросов там, где нужен один (M4 §0, измерение 14).

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
  : 'нет PGHOST/PGUSER/PGDATABASE — оценки не проверялись';

let pool;
let ratings;
const fixtures = { series: [], users: [] };

test.before(async () => {
  if (!available) return;
  pool = createPool();
  ratings = pgRatings(pool);
});

test.after(async () => {
  if (!pool) return;
  // Фикстуры убираются в порядке внешних ключей: оценки и сезоны ссылаются на
  // сериал, а удалить сериал раньше них нельзя (ON DELETE RESTRICT). Без
  // уборки они остались бы в общей базе и мешали чужим проверкам — например,
  // поиску по названию.
  //
  // Префикс только свой: файлы идут параллельно, и уборка по общему `rating-`
  // сносила бы фикстуры соседа — тот падал на внешнем ключе посреди проверки.
  const prefix = 'rating-store-%';
  await pool.query(
    `DELETE FROM e_rating WHERE series_id IN (SELECT id FROM e_series WHERE slug LIKE $1)`, [prefix],
  );
  await pool.query(
    `DELETE FROM e_season WHERE series_id IN (SELECT id FROM e_series WHERE slug LIKE $1)`, [prefix],
  );
  await pool.query(`DELETE FROM e_series WHERE slug LIKE $1`, [prefix]);
  await pool.end();
});

/** Сериал с одной серией: без неё оценка невозможна (EC-V1). */
async function seriesWith() {
  const slug = `rating-store-${crypto.randomUUID().slice(0, 8)}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Оценка фикстуры', 'Rating fixture', $2, 'published', 'airing', 2024) RETURNING id, slug`,
    [slug, 987_000_000 + Math.floor(Math.random() * 900)],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [series.id],
  );
  const { rows: [episode] } = await pool.query(
    `INSERT INTO e_episode (season_id, number, title_ru, runtime_min)
     VALUES ($1, 1, 'Серия', 45) RETURNING id`, [season.id],
  );
  fixtures.series.push(series.id);
  return { seriesId: series.id, episodeId: episode.id };
}

/**
 * Аккаунт для оценки.
 *
 * @param {object} args
 * @param {boolean} [args.confirmed] адрес подтверждён
 * @param {number} [args.ageHours] сколько часов прошло с регистрации
 */
async function viewer({ confirmed = true, ageHours = 24 * 30 } = {}) {
  const { hash } = makeToken();
  const created = await pgAuthStore(pool).createUser({
    email: `rate-${crypto.randomUUID().slice(0, 8)}@example.com`,
    nickname: `rate-${crypto.randomUUID().slice(0, 8)}`,
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
  fixtures.users.push(created.id);
  return created.id;
}

/** Отметка просмотра — условие права оценить (EC-V1, H-07). */
async function mark(userId, episodeId) {
  await pool.query(
    'INSERT INTO e_watch_mark (user_id, episode_id, precision) VALUES ($1, $2, $3)'
    + ' ON CONFLICT DO NOTHING',
    [userId, episodeId, 'exact'],
  );
}

// ─── Право оценить ───────────────────────────────────────────────────────────

test('без отметки просмотра оценка не принимается (EC-V1)', { skip }, async () => {
  const { seriesId } = await seriesWith();
  const userId = await viewer();

  const result = await ratings.setSeriesRating({ userId, seriesId, value: 8 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-mark', 'причина названа: человек должен понять, чего не хватает');
  assert.equal(await ratings.ownRating(userId, seriesId), null);
});

test('неподтверждённый адрес оценить не может', { skip }, async () => {
  const { seriesId, episodeId } = await seriesWith();
  const userId = await viewer({ confirmed: false });
  await mark(userId, episodeId);

  const result = await ratings.setSeriesRating({ userId, seriesId, value: 8 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-confirmed');
});

test('отметка чужого сериала не открывает оценку чужого сериала', { skip }, async () => {
  const first = await seriesWith();
  const second = await seriesWith();
  const userId = await viewer();
  await mark(userId, first.episodeId);

  const result = await ratings.setSeriesRating({ userId, seriesId: second.seriesId, value: 9 });

  assert.equal(result.reason, 'no-mark', 'отметка привязана к своему сериалу');
});

test('оценка вне 1–10 не принимается', { skip }, async () => {
  const { seriesId, episodeId } = await seriesWith();
  const userId = await viewer();
  await mark(userId, episodeId);

  for (const value of [0, 11, 7.5, -3]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await ratings.setSeriesRating({ userId, seriesId, value });
    assert.equal(result.ok, false, `значение ${value} не должно приниматься`);
    assert.equal(result.reason, 'range');
  }
});

// ─── Запись и агрегаты ───────────────────────────────────────────────────────

test('оценка сохраняется и попадает в агрегат', { skip }, async () => {
  const { seriesId, episodeId } = await seriesWith();
  const userId = await viewer();
  await mark(userId, episodeId);

  const result = await ratings.setSeriesRating({ userId, seriesId, value: 8 });

  assert.equal(result.ok, true);
  assert.equal(result.stat.votes, 1);
  assert.equal(result.stat.sum, 8);
  const summary = await ratings.summary(seriesId);
  assert.equal(summary.votes, 1);
  assert.equal(summary.histogram.get(8), 1);
});

test('повтор той же оценки не удваивает голос (EC-V20)', { skip }, async () => {
  const { seriesId, episodeId } = await seriesWith();
  const userId = await viewer();
  await mark(userId, episodeId);

  await ratings.setSeriesRating({ userId, seriesId, value: 8 });
  const again = await ratings.setSeriesRating({ userId, seriesId, value: 8 });

  assert.equal(again.stat.votes, 1, 'один человек — один голос');
  assert.equal(again.stat.sum, 8);
});

test('смена оценки пересчитывает агрегат (EC-V3)', { skip }, async () => {
  const { seriesId, episodeId } = await seriesWith();
  const userId = await viewer();
  await mark(userId, episodeId);

  await ratings.setSeriesRating({ userId, seriesId, value: 8 });
  const changed = await ratings.setSeriesRating({ userId, seriesId, value: 5 });

  assert.equal(changed.stat.votes, 1, 'голос остался один');
  assert.equal(changed.stat.sum, 5, 'сумма пересчитана');
});

test('снятие оценки убирает голос из агрегата', { skip }, async () => {
  const { seriesId, episodeId } = await seriesWith();
  const userId = await viewer();
  await mark(userId, episodeId);
  await ratings.setSeriesRating({ userId, seriesId, value: 10 });

  const removed = await ratings.removeSeriesRating({ userId, seriesId });

  assert.equal(removed.stat.votes, 0);
  assert.equal(removed.stat.sum, 0);
  assert.equal(await ratings.ownRating(userId, seriesId), null);
});

test('аккаунт младше суток сохраняет оценку, но агрегат не трогает (EC-V4)', { skip }, async () => {
  const { seriesId, episodeId } = await seriesWith();
  const userId = await viewer({ ageHours: RATING.minAccountAgeH - 1 });
  await mark(userId, episodeId);

  const result = await ratings.setSeriesRating({ userId, seriesId, value: 10 });

  assert.equal(result.ok, true, 'оценка сохранена — человек поставил её законно');
  assert.equal(result.counted, false, 'в рейтинг сайта она не входит');
  assert.equal(result.stat.votes, 0);
  const own = await ratings.ownRating(userId, seriesId);
  assert.equal(own.value, 10, 'оценка видна своему автору');
  assert.equal(own.counted, false, 'и видно, что в рейтинг она пока не вошла');
  assert.ok(own.maturesAt instanceof Date, 'автору показано, когда голос учтут (EC-V4)');
});

test('дозревший голос входит в агрегат (EC-V4)', { skip }, async () => {
  // Оценка аккаунта, созданного час назад, сохранена, но агрегат не тронут.
  // Через сутки голос должен войти сам — и один раз: повторный проход задачи
  // не должен увеличивать счётчик.
  const { seriesId, episodeId } = await seriesWith();
  const userId = await viewer({ ageHours: RATING.minAccountAgeH - 1 });
  await mark(userId, episodeId);
  await ratings.setSeriesRating({ userId, seriesId, value: 6 });
  assert.equal((await ratings.statOf(seriesId)).votes, 0, 'до возраста голос не считается');

  // Проход задачи общий, и база общая: сколько всего голосов он введёт —
  // не его свойство. Проверяется голос самого человека, а не число со всего
  // сервера: иначе проверка зависела бы от чужих строк, оставшихся от других
  // прогонов.
  await ratings.countMaturedRatings(new Date());
  const stillYoung = await pool.query(
    'SELECT counted FROM e_rating WHERE user_id = $1 AND series_id = $2', [userId, seriesId],
  );
  assert.equal(stillYoung.rows[0].counted, false, 'аккаунт ещё не дозрел: голос не введён');

  // Часы аккаунта перематываются вместо ожидания суток.
  await pool.query(
    `UPDATE e_user SET registered_at = registered_at - interval '2 days' WHERE id = $1`, [userId],
  );
  await ratings.countMaturedRatings(new Date());

  assert.equal((await ratings.statOf(seriesId)).votes, 1, 'голос вошёл в агрегат');
  assert.equal((await ratings.statOf(seriesId)).sum, 6);

  // И один раз: повторный проход ничего не удваивает.
  await ratings.countMaturedRatings(new Date());
  assert.equal((await ratings.statOf(seriesId)).votes, 1, 'повторный проход ничего не удваивает');
});

// ─── Среднее со сглаживанием (H-24, OP-03) ──────────────────────────────────

test('среднее сглаживается априором: один голос не даёт «10 из 10» (EC-V5)', { skip }, async () => {
  const { seriesId, episodeId } = await seriesWith();
  const userId = await viewer();
  await mark(userId, episodeId);
  await ratings.setSeriesRating({ userId, seriesId, value: 10 });

  const summary = await ratings.summary(seriesId);
  // Априор читается из строки, а не берётся из настроек: с F-04-03 в нём лежит
  // среднее по сайту, и пересчёт соседнего файла не должен ронять проверку.
  const stat = await ratings.statOf(seriesId);
  const expected = (10 + stat.priorMean * stat.priorWeight) / (1 + stat.priorWeight);

  assert.equal(summary.votes, 1, 'голос один');
  assert.equal(summary.average, expected, 'среднее считается с априором, а не делением на голоса');
  assert.ok(summary.average < 10, 'десятка от одного человека не показывается как десятка');
});

test('при пороге голосов среднее не показывается вовсе', { skip }, async () => {
  const { seriesId, episodeId } = await seriesWith();
  const userId = await viewer();
  await mark(userId, episodeId);
  await ratings.setSeriesRating({ userId, seriesId, value: 9 });

  const summary = await ratings.summary(seriesId);
  assert.equal(summary.votes, 1);
  assert.equal(summary.shown, false, `порог M4 §0 — ${RATING.minVotesDisplay}`);
  // Само число остаётся: им пользуются порядок и пересчёт, а за то, чтобы
  // человек его не увидел, отвечает представление, а не сервис.
  assert.ok(typeof summary.average === 'number', 'среднее посчитано и доступно');
});

// ─── Среднее по сайту и гистограмма (F-04-03) ───────────────────────────────

test('формула рейтинга: R = 8,0, v = 10, C = 7,0, m = 10 → 7,5 (F-04-03 §18)', { skip }, async () => {
  const { seriesId, episodeId } = await seriesWith();
  // Десять голосов «8» и априор из приёмки: (80 + 7·10) / 20 = 7,5.
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const userId = await viewer();
    // eslint-disable-next-line no-await-in-loop
    await mark(userId, episodeId);
    // eslint-disable-next-line no-await-in-loop
    const result = await ratings.setSeriesRating({ userId, seriesId, value: 8 });
    assert.equal(result.ok, true, `голос ${i + 1} принят`);
  }
  await pool.query(
    'UPDATE e_series_rating_stat SET prior_mean = 7.0 WHERE series_id = $1', [seriesId],
  );

  const summary = await ratings.summary(seriesId);

  assert.equal(summary.votes, 10);
  assert.equal(summary.average, 7.5, 'сглаженное среднее совпадает с приёмкой OP-03');
  assert.equal(summary.shown, true, 'десяти голосов хватает на показ');
  const bars = [...summary.histogram.values()].reduce((sum, count) => sum + count, 0);
  assert.equal(bars, summary.votes, 'сумма гистограммы равна числу голосов (F-04-03 §9)');
});

test('среднее по сайту — по учитываемым сериальным голосам, в априоре каждой строки (F-04-03 §7–§8)', { skip }, async () => {
  const first = await seriesWith();
  const second = await seriesWith();
  const adult = await viewer();
  const young = await viewer({ ageHours: 1 });
  await mark(adult, first.episodeId);
  await mark(adult, second.episodeId);
  await mark(young, first.episodeId);
  await ratings.setSeriesRating({ userId: adult, seriesId: first.seriesId, value: 9 });
  await ratings.setSeriesRating({ userId: adult, seriesId: second.seriesId, value: 8 });
  // Недозревший голос: сохраняется, но в C не входит (EC-V4).
  await ratings.setSeriesRating({ userId: young, seriesId: first.seriesId, value: 1 });
  // Голос серии — строкой, а не маршрутом: маршрут требует вышедшую серию, а
  // здесь проверяется ровно то, что сериальные и серийные голоса не путаются.
  await pool.query(
    `INSERT INTO e_rating (user_id, object_type, episode_id, series_id, value, counted)
     VALUES ($1, 'episode', $2, $3, 9, TRUE)`,
    [adult, first.episodeId, first.seriesId],
  );

  // Пересчёт трогает априор у всех сериалов, включая фикстуры параллельных
  // файлов: их прежние значения возвращаются на место после проверки.
  const { rows: saved } = await pool.query(
    'SELECT series_id, prior_mean::float AS prior FROM e_series_rating_stat',
  );
  let result;
  let means;
  let afterDelete;
  try {
    result = await ratings.refreshSiteAverage();
    ({ rows: means } = await pool.query(
      'SELECT DISTINCT prior_mean::float AS prior FROM e_series_rating_stat',
    ));
    // EC-V6: голос обезличенного аккаунта остаётся в рейтинге (H-61) — счёт
    // смотрит на строку оценки, а не на состояние человека.
    await pool.query(`UPDATE e_user SET status = 'deleted' WHERE id = $1`, [adult]);
    afterDelete = await ratings.refreshSiteAverage();
  } finally {
    for (const row of saved) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        'UPDATE e_series_rating_stat SET prior_mean = $2 WHERE series_id = $1',
        [row.series_id, row.prior],
      );
    }
  }

  assert.equal(means.length, 1, 'среднее по сайту одно: априор у всех сериалов одинаков');
  assert.ok(result.votes >= 2, 'наши два учитываемых голоса в C вошли');
  assert.ok(afterDelete.votes >= result.votes, 'голос обезличенного аккаунта из C не пропал');

  // Точное значение зависит от голосов соседних файлов, идущих в это же время,
  // поэтому сравнивается с тем же средним по тем же условиям — с допуском в шаг
  // округления колонки (`prior_mean` хранит десятые).
  const { rows: [truth] } = await pool.query(
    `SELECT avg(value)::float AS c FROM e_rating WHERE object_type = 'series' AND counted`,
  );
  assert.ok(Math.abs(means[0].prior - truth.c) <= 0.1, `C ≈ ${truth.c}, а в строках ${means[0].prior}`);

  // Верхняя граница ловит лишнее: голос серии и недозревший голос в счёт не
  // входят, и голосов в C не может быть больше, чем учитываемых сериальных.
  const { rows: [counted] } = await pool.query(
    `SELECT count(*)::int AS n FROM e_rating WHERE object_type = 'series' AND counted`,
  );
  assert.ok(result.votes <= counted.n, 'в C нет ни голосов серий, ни недозревших');
});

test('исключённый из рейтинга голос не входит ни в число, ни в гистограмму (F-04-03 §18)', { skip }, async () => {
  const { seriesId, episodeId } = await seriesWith();
  const counted = await viewer();
  const banned = await viewer();
  await mark(counted, episodeId);
  await mark(banned, episodeId);
  await ratings.setSeriesRating({ userId: counted, seriesId, value: 9 });
  await ratings.setSeriesRating({ userId: banned, seriesId, value: 1 });

  // Бан — действие M9 (EC-V5): оно снимает флаг, а пересчёт агрегата делает
  // та же команда. Здесь проверяется чтение после пересчёта: единицы
  // забаненного нет ни в числе голосов, ни в распределении.
  await pool.query(
    `UPDATE e_rating SET counted = FALSE WHERE user_id = $1 AND series_id = $2`,
    [banned, seriesId],
  );
  await pool.query(
    'UPDATE e_series_rating_stat SET votes = 1, sum_value = 9 WHERE series_id = $1', [seriesId],
  );

  const summary = await ratings.summary(seriesId);

  assert.equal(summary.votes, 1);
  assert.equal(summary.histogram.get(1) ?? 0, 0, 'единицы забаненного в гистограмме нет');
  assert.equal(summary.histogram.get(9), 1);
});