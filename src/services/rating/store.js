// Оценка сериала (F-04-01, OP-03) и оценка серии (F-04-02).
//
// Четыре правила, из-за которых сервис и существует:
//
//  1. Право проверяется на сервере, а не тем, что кнопка нарисована (EC-V1,
//     H-07): оценить сериал можно, только отметив хотя бы одну его серию,
//     серию — только отметив её саму, и только подтверждённым адресом.
//     Скрытая кнопка обходится прямым запросом, и правило, объявленное только
//     в интерфейсе, правилом не является.
//  2. Агрегат сериала живёт в `e_series_rating_stat` и меняется приращением, а
//     не пересчётом: рейтинг читается на каждой странице сериала (M4 §0,
//     измерение 14 — «пересчёт агрегатов приращением»). Пересчёт по всем
//     строкам при каждой оценке означал бы запрос по всей истории голосов.
//  3. У серии агрегата нет: его считает та же выборка, что показывает список
//     серий, — один запрос на сезон. Кэш оценок в модели описан сущностью
//     `E-SeriesRatingStat` и ключуется сериалом (DOMAIN-MODEL §5); вторая
//     таблица ради суммы по трём голосам добавила бы второе место, где
//     значение может разойтись с голосами. Отсюда же простое среднее без
//     априора: у серии голосов мало, и априор показывал бы у всех серий одно
//     и то же число (H-79).
//  4. Голос аккаунта младше `rating.min_account_age_h` сохраняется, но в
//     рейтинг не входит (EC-V4, H-74): оценка человека, созданного час назад,
//     не должна сдвигать число, которое увидят другие. Войдёт, когда возраст
//     будет достигнут — это делает ежечасный проход.
//  5. Среднее по сайту C (F-04-03) — тоже априор, и живёт он в `prior_mean`
//     каждой строки: тем же ежечасным проходом, что вводит дозревшие голоса.
//     При каждой оценке его не пересчитать — это запрос по всей истории
//     голосов сайта; страница же читает C вместе со своей строкой статистики.

import pg from 'pg';

import { RATING } from '../../config/settings.js';
import { HOUR } from '../../config/settings.js';

/** Причина отказа — короткая строка, по ней маршрут выбирает текст. */
export const REASONS = {
  NO_MARK: 'no-mark',
  NOT_CONFIRMED: 'not-confirmed',
  NOT_AIRED: 'not-aired',
  RANGE: 'range',
  MISSING: 'missing',
};

/** Сегодняшняя дата по часам сервера — запасной вариант, когда пояс не передан. */
const serverToday = () => new Date().toISOString().slice(0, 10);

/**
 * Причина, по которой оценить нельзя, или `null`, если можно.
 *
 * Одна формулировка правила на два места: запись (проверяет базу) и показ
 * (берёт отметку и дату из страницы). Разойтись они не могут, пока считают
 * одним кодом, — а разойтись значило бы, что кнопка нарисована там, где
 * сервер откажет (EC-V1).
 *
 * @param {{confirmed: boolean, marked: boolean, aired: boolean}} state
 * @returns {string|null}
 */
export function rateReason({ confirmed, marked, aired }) {
  if (!confirmed) return REASONS.NOT_CONFIRMED;
  if (!marked) return REASONS.NO_MARK;
  if (!aired) return REASONS.NOT_AIRED;
  return null;
}

/**
 * Голос человека: значение, попадает ли в рейтинг и когда попадёт.
 *
 * @param {{value: number|string, counted: boolean, matures_at: Date}} row
 * @returns {{value: number, counted: boolean, maturesAt: Date}}
 */
function voiceOf(row) {
  return { value: Number(row.value), counted: row.counted, maturesAt: row.matures_at };
}

/**
 * Среднее по серии из суммы и числа голосов.
 *
 * `shown` — порог показа числа `< rating.min_votes_display` для серии: при
 * двух голосах среднее есть, но показывать его нельзя (F-04-02 §состояния).
 *
 * @param {{votes: number|string, sum: number|string}} row
 * @returns {{votes: number, sum: number, average: number|null, shown: boolean}}
 */
function episodeSummaryOf(row) {
  const votes = Number(row.votes);
  const sum = Number(row.sum);
  return {
    votes,
    sum,
    average: votes ? sum / votes : null,
    shown: votes >= RATING.minVotesEpisode,
  };
}

/**
 * Источник данных оценок.
 *
 * @param {pg.Pool} pool
 */
/**
 * Повтор запроса после взаимоблокировки.
 *
 * PostgreSQL выбирает жертвой одну из двух встречных транзакций; тот, кто
 * повторит, оказывается прав. Ждать недолго: при разборе блокировок жертва
 * освобождает строки сразу.
 *
 * @param {Function} run запрос
 * @param {number} [attempts] сколько раз пробовать
 * @returns {Promise<*>}
 */
export async function withDeadlockRetry(run, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (error?.code !== '40P01' || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}

export function pgRatings(pool) {
  return {
    /**
     * Может ли человек оценить сериал.
     *
     * @param {{userId: number, seriesId: number}} input
     * @returns {Promise<{ok: boolean, reason?: string}>}
     */
    async canRate({ userId, seriesId }) {
      const { rows } = await pool.query(
        `SELECT u.email_confirmed,
                EXISTS (SELECT 1
                          FROM e_watch_mark m
                          JOIN e_episode e ON e.id = m.episode_id
                          JOIN e_season s ON s.id = e.season_id
                         WHERE m.user_id = $1 AND m.precision = 'exact'
                           AND s.series_id = $2) AS marked
           FROM e_user u
          WHERE u.id = $1`,
        [userId, seriesId],
      );
      const row = rows[0];
      if (!row) return { ok: false, reason: REASONS.MISSING };
      if (!row.email_confirmed) return { ok: false, reason: REASONS.NOT_CONFIRMED };
      if (!row.marked) return { ok: false, reason: REASONS.NO_MARK };
      return { ok: true };
    },

    /**
     * Ставит оценку сериалу.
     *
     * Значение меняет голос, а не добавляет: повтор той же оценки идемпотентен
     * (EC-V20), и агрегат после неё не меняется. Снятие — отдельный вызов,
     * потому что «убрать» приходит из другого места интерфейса.
     *
     * @param {{userId: number, seriesId: number, value: number, at?: Date}} input
     * @returns {Promise<{ok: boolean, reason?: string, counted?: boolean,
     *   own?: number, stat?: {votes: number, sum: number}}>}
     */
    async setSeriesRating({ userId, seriesId, value, at = new Date() }) {
      if (!Number.isInteger(value) || value < 1 || value > 10) {
        return { ok: false, reason: REASONS.RANGE };
      }

      const allowed = await this.canRate({ userId, seriesId });
      if (!allowed.ok) return allowed;

      // EC-V4: возраст аккаунта решает судьбу голоса, а не право его поставить.
      const counted = await this.ageReached(userId, at);

      return this.write({ userId, seriesId, value, counted, at });
    },

    /** Снимает оценку сериала. Голоса, как и у «поставить», нет — он один. */
    async removeSeriesRating({ userId, seriesId, at = new Date() }) {
      const counted = await this.ageReached(userId, at);
      return this.write({ userId, seriesId, value: null, counted, at });
    },

    /**
     * Оценка человека по сериалу — для блока «Ваша оценка».
     *
     * Возвращается не одно число, а состояние голоса: человеку нужно знать не
     * только свою оценку, но и то, что она пока не входит в рейтинг (EC-V4 —
     * «автору показано, когда будет учтена»).
     *
     * @returns {Promise<{value: number, counted: boolean, maturesAt: Date}|null>}
     */
    async ownRating(userId, seriesId) {
      const { rows } = await pool.query(
        `SELECT r.value, r.counted,
                u.registered_at + ($3 || ' hours')::interval AS matures_at
           FROM e_rating r JOIN e_user u ON u.id = r.user_id
          WHERE r.user_id = $1 AND r.series_id = $2
            AND r.object_type = 'series' AND r.episode_id IS NULL`,
        [userId, seriesId, String(RATING.minAccountAgeH)],
      );
      return rows[0] ? voiceOf(rows[0]) : null;
    },

    /**
     * Агрегат по сериалу: голоса, сумма, среднее и гистограмма.
     *
     * Среднее сглажено априором (H-24): без него один человек с оценкой 1
     * показывал бы сериалу единицу, а десять человек с той же единицей —
     * то же самое. Пока голосов меньше `rating.min_votes_display`, число не
     * показывается вовсе, но остаётся доступным: рейтинг всё равно нужен для
     * порядка и для пересчёта.
     *
     * @param {number} seriesId
     * @returns {Promise<{votes: number, sum: number, average: number|null,
     *   shown: boolean, histogram: Map<number, number>}>}
     */
    async summary(seriesId) {
      const { rows } = await pool.query(
        `SELECT s.sum_value::float AS sum, s.votes, s.prior_weight, s.prior_mean,
                (SELECT a.frozen FROM e_rating_anomaly a
                  WHERE a.series_id = s.series_id AND a.state = 'open' LIMIT 1) AS frozen
           FROM e_series_rating_stat s
          WHERE s.series_id = $1`,
        [seriesId],
      );
      const row = rows[0] ?? { sum: 0, votes: 0, prior_weight: RATING.priorWeight, prior_mean: RATING.priorMeanDefault };
      // Открытая аномалия (F-04-08, DEC-065) держит снимок блока на момент
      // срабатывания — показ формулы из «учитываемых» строк заморожен до
      // решения админа. Подзапрос в том же чтении: лишний маршрут на каждую
      // страницу сериала для нормального большинства недопустим.
      if (row.frozen && typeof row.frozen === 'object') {
        const snapshot = row.frozen.summary ?? {};
        return {
          votes: Number(snapshot.votes ?? 0),
          sum: Number(snapshot.sum ?? 0),
          average: snapshot.average ?? null,
          shown: Boolean(snapshot.shown),
          histogram: new Map(Object.entries(snapshot.histogram ?? {}).map(
            ([value, n]) => [Number(value), Number(n)],
          )),
        };
      }
      const votes = Number(row.votes ?? 0);
      const sum = Number(row.sum ?? 0);
      const weight = Number(row.prior_weight ?? RATING.priorWeight);
      const mean = Number(row.prior_mean ?? RATING.priorMeanDefault);
      const average = votes + weight === 0 ? null : (sum + mean * weight) / (votes + weight);

      const bars = await pool.query(
        `SELECT value, count(*)::int AS n FROM e_rating
          WHERE series_id = $1 AND object_type = 'series' AND episode_id IS NULL AND counted
          GROUP BY value`,
        [seriesId],
      );
      const histogram = new Map(bars.rows.map((bar) => [bar.value, bar.n]));

      return {
        votes,
        sum,
        average,
        shown: votes >= RATING.minVotesDisplay,
        histogram,
      };
    },

    /**
     * Подтверждён ли адрес человека.
     *
     * Нужно списку серий: отметка и дата выхода у каждой строки свои, а
     * подтверждение адреса одно на человека, и спрашивать его на каждую
     * строку значило бы двадцать запросов вместо одного (EC-V1).
     *
     * @param {number} userId
     * @returns {Promise<boolean>}
     */
    async emailConfirmed(userId) {
      const { rows } = await pool.query(
        'SELECT email_confirmed FROM e_user WHERE id = $1',
        [userId],
      );
      return Boolean(rows[0]?.email_confirmed);
    },

    /**
     * Может ли человек оценить серию (F-04-02, EC-V1).
     *
     * Та же проверка, что у сериала, плюс третье условие: серия должна выйти.
     * Отметить будущую серию нельзя (M3), но прямой запрос отметку не
     * спрашивает — поэтому «вышла» проверяется здесь, а не только тем, что
     * флажок нарисован неактивным.
     *
     * @param {{userId: number, episodeId: number, today?: string}} input дата
     *   `today` — в поясе посетителя, как и на странице сезона: серия,
     *   вышедшая «сегодня» в одном поясе, в другом ещё впереди
     * @returns {Promise<{ok: boolean, reason?: string}>}
     */
    async canRateEpisode({ userId, episodeId, today = null }) {
      const { rows } = await pool.query(
        `SELECT u.email_confirmed,
                EXISTS (SELECT 1 FROM e_watch_mark m
                         WHERE m.user_id = $1 AND m.episode_id = $2
                           AND m.precision = 'exact') AS marked,
                (SELECT min(rl.release_date)
                   FROM e_release rl
                   JOIN e_release_episode rle ON rle.release_id = rl.id
                  WHERE rle.episode_id = $2) <= $3::date AS aired
           FROM e_user u
          WHERE u.id = $1`,
        [userId, episodeId, today ?? serverToday()],
      );
      const row = rows[0];
      if (!row) return { ok: false, reason: REASONS.MISSING };

      const reason = rateReason({
        confirmed: row.email_confirmed,
        marked: row.marked,
        aired: Boolean(row.aired),
      });
      return reason ? { ok: false, reason } : { ok: true };
    },

    /**
     * Ставит оценку серии (F-04-02).
     *
     * Повтор той же оценки идемпотентен, снятие — отдельный вызов (EC-V20).
     * Агрегат не двигается: среднее серии читается из голосов, и двигать
     * нечего — поэтому же дозревание голоса (EC-V4) для серии не требует
     * отдельного прохода.
     *
     * @param {{userId: number, seriesId: number, episodeId: number,
     *   value: number, today?: string, at?: Date}} input
     * @returns {Promise<{ok: boolean, reason?: string, counted?: boolean,
     *   own?: number, summary?: object}>}
     */
    async setEpisodeRating({ userId, seriesId, episodeId, value, today = null, at = new Date() }) {
      if (!Number.isInteger(value) || value < 1 || value > 10) {
        return { ok: false, reason: REASONS.RANGE };
      }

      const allowed = await this.canRateEpisode({ userId, episodeId, today });
      if (!allowed.ok) return allowed;

      const counted = await this.ageReached(userId, at);
      await this.writeEpisode({ userId, seriesId, episodeId, value, counted, at });

      return { ok: true, counted, own: value, summary: await this.episodeSummary(episodeId) };
    },

    /** Снимает оценку серии. Голосов, как и у «поставить», нет — он один. */
    async removeEpisodeRating({ userId, episodeId, at = new Date() }) {
      const counted = await this.ageReached(userId, at);
      await this.writeEpisode({ userId, episodeId, value: null, counted, at });
      return { ok: true, counted, own: null, summary: await this.episodeSummary(episodeId) };
    },

    /**
     * Среднее по серии — простое, без сглаживания (H-79).
     *
     * @param {number} episodeId
     * @returns {Promise<{votes: number, sum: number, average: number|null,
     *   shown: boolean}>}
     */
    async episodeSummary(episodeId) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS votes, coalesce(sum(value), 0)::float AS sum
           FROM e_rating
          WHERE episode_id = $1 AND object_type = 'episode' AND counted`,
        [episodeId],
      );
      return episodeSummaryOf(rows[0]);
    },

    /**
     * Средние по нескольким сериям одной выборкой.
     *
     * Список серий — это страница сезона: отдельный запрос на каждую серию
     * означал бы двадцать запросов там, где нужен один (M4 §0, измерение 14).
     * Серия без голосов тоже попадает в ответ: страница не должна отличать
     * «нет оценок» от «серия не найдена».
     *
     * @param {Array<number|string>} episodeIds
     * @returns {Promise<Map<number, object>>}
     */
    async episodeSummaries(episodeIds) {
      const wanted = [...new Set(episodeIds.map(Number).filter(Number.isInteger))];
      const summaries = new Map(wanted.map((id) => [id, episodeSummaryOf({ votes: 0, sum: 0 })]));
      if (!wanted.length) return summaries;

      const { rows } = await pool.query(
        `SELECT episode_id, count(*)::int AS votes, coalesce(sum(value), 0)::float AS sum
           FROM e_rating
          WHERE episode_id = ANY($1::bigint[]) AND object_type = 'episode' AND counted
          GROUP BY episode_id`,
        [wanted],
      );
      for (const row of rows) summaries.set(Number(row.episode_id), episodeSummaryOf(row));
      return summaries;
    },

    /**
     * Оценка человека по серии — для блока «Ваша оценка».
     *
     * @returns {Promise<{value: number, counted: boolean, maturesAt: Date}|null>}
     */
    async ownEpisodeRating(userId, episodeId) {
      const found = await this.ownEpisodeRatings(userId, [episodeId]);
      return found.get(Number(episodeId)) ?? null;
    },

    /**
     * Оценки человека по нескольким сериям одной выборкой.
     *
     * @param {number} userId
     * @param {Array<number|string>} episodeIds
     * @returns {Promise<Map<number, {value: number, counted: boolean,
     *   maturesAt: Date}>>}
     */
    async ownEpisodeRatings(userId, episodeIds) {
      const wanted = [...new Set(episodeIds.map(Number).filter(Number.isInteger))];
      if (!wanted.length) return new Map();

      const { rows } = await pool.query(
        `SELECT r.episode_id, r.value, r.counted,
                u.registered_at + ($3 || ' hours')::interval AS matures_at
           FROM e_rating r JOIN e_user u ON u.id = r.user_id
          WHERE r.user_id = $1 AND r.episode_id = ANY($2::bigint[])
            AND r.object_type = 'episode'`,
        [userId, wanted, String(RATING.minAccountAgeH)],
      );
      return new Map(rows.map((row) => [Number(row.episode_id), voiceOf(row)]));
    },

    /**
     * Достиг ли аккаунт возраста, с которого его голос входит в рейтинг.
     *
     * @param {number} userId
     * @param {Date} at
     * @returns {Promise<boolean>}
     */
    async ageReached(userId, at) {
      const { rows } = await pool.query(
        'SELECT registered_at FROM e_user WHERE id = $1', [userId],
      );
      const registered = rows[0]?.registered_at;
      if (!registered) return false;
      return at.getTime() - new Date(registered).getTime() >= RATING.minAccountAgeH * HOUR;
    },

    /**
     * Запись оценки и движение агрегата — одной транзакцией.
     *
     * Блокировки именно на строках: два устройства одного человека, нажавшие
     * «оценить» одновременно, должны дать один голос и одно состояние
     * агрегата (EC-V20), а не две записи или разъехавшийся счётчик.
     *
     * @param {{userId: number, seriesId: number, value: number|null,
     *   counted: boolean, at: Date}} input
     */
    async write({ userId, seriesId, value, counted, at }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const before = await client.query(
          `SELECT value, counted FROM e_rating
            WHERE user_id = $1 AND series_id = $2
              AND object_type = 'series' AND episode_id IS NULL
            FOR UPDATE`,
          [userId, seriesId],
        );
        const previous = before.rows[0] ?? null;

        if (value === null) {
          await client.query(
            `DELETE FROM e_rating
              WHERE user_id = $1 AND series_id = $2
                AND object_type = 'series' AND episode_id IS NULL`,
            [userId, seriesId],
          );
        } else {
          // Индекс уникальности частичный — по виду оценки, — поэтому в
          // `ON CONFLICT` повторяется и условие: без него PostgreSQL не поймёт,
          // о каком индексе речь. На сериальной оценке сработает `uq_rating_series`.
          await client.query(
            `INSERT INTO e_rating
               (user_id, object_type, episode_id, series_id, value, created_at, updated_at, counted)
             VALUES ($1, 'series', NULL, $2, $3, $4, $4, $5)
             ON CONFLICT (user_id, series_id) WHERE object_type = 'series'
             DO UPDATE SET value = EXCLUDED.value, counted = EXCLUDED.counted,
                           updated_at = EXCLUDED.updated_at`,
            [userId, seriesId, value, at, counted],
          );
        }

        // Разница для агрегата: что ушло и что пришло, с учётом того, входит
        // ли голос в рейтинг. Голос, который не учитывался и не учитывается,
        // не двигает ничего.
        const wasCounted = previous?.counted ? Number(previous.value) : 0;
        const isCounted = value !== null && counted ? value : 0;

        await client.query(
          `INSERT INTO e_series_rating_stat (series_id, sum_value, votes, recalculated_at)
           VALUES ($1, 0, 0, $2) ON CONFLICT (series_id) DO NOTHING`,
          [seriesId, at],
        );
        await client.query(
          `UPDATE e_series_rating_stat
              SET sum_value = sum_value + ($2::numeric - $3::numeric),
                  votes = votes + ($4::int - $5::int),
                  recalculated_at = $6
            WHERE series_id = $1`,
          [seriesId, isCounted, wasCounted, isCounted ? 1 : 0, wasCounted ? 1 : 0, at],
        );

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      const stat = await this.statOf(seriesId);
      return { ok: true, counted, own: value, stat };
    },

    /**
     * Запись оценки серии.
     *
     * Одной командой: агрегата у серии нет, двигать нечего, а строку держит
     * уникальный индекс `uq_rating_episode` — повторный запрос обновляет её же,
     * а не заводит вторую (EC-V20).
     *
     * @param {{userId: number, episodeId: number, seriesId?: number,
     *   value: number|null, counted: boolean, at: Date}} input
     */
    async writeEpisode({ userId, episodeId, seriesId = null, value, counted, at }) {
      if (value === null) {
        await pool.query(
          `DELETE FROM e_rating
            WHERE user_id = $1 AND episode_id = $2 AND object_type = 'episode'`,
          [userId, episodeId],
        );
        return;
      }

      // Индекс уникальности частичный — по виду оценки, — поэтому в
      // `ON CONFLICT` повторяется и условие: без него PostgreSQL не поймёт,
      // о каком индексе речь. Здесь он `uq_rating_episode`.
      await pool.query(
        `INSERT INTO e_rating
           (user_id, object_type, episode_id, series_id, value, created_at, updated_at, counted)
         VALUES ($1, 'episode', $2, $3, $4, $5, $5, $6)
         ON CONFLICT (user_id, episode_id) WHERE object_type = 'episode'
         DO UPDATE SET value = EXCLUDED.value, counted = EXCLUDED.counted,
                       updated_at = EXCLUDED.updated_at`,
        [userId, episodeId, seriesId, value, at, counted],
      );
    },

    /** Сырые голос, сумма и априор — для проверок и пересчёта. */
    async statOf(seriesId) {
      const { rows } = await pool.query(
        `SELECT votes, sum_value::float AS sum, prior_mean::float AS prior_mean,
                prior_weight::float AS prior_weight
           FROM e_series_rating_stat WHERE series_id = $1`,
        [seriesId],
      );
      return {
        votes: Number(rows[0]?.votes ?? 0),
        sum: Number(rows[0]?.sum ?? 0),
        priorMean: Number(rows[0]?.prior_mean ?? RATING.priorMeanDefault),
        priorWeight: Number(rows[0]?.prior_weight ?? RATING.priorWeight),
      };
    },

    /**
     * Пересчитывает среднее по сайту C (F-04-03 §4, §7–§8).
     *
     * C — среднее учитываемых сериальных голосов всего сайта; если голосов нет,
     * C равен настройке `rating.prior_mean_default`. Хранится он не отдельной
     * таблицей, а в `prior_mean` каждой строки статистики: в модели кэш сайта —
     * та же `E-SeriesRatingStat`, а формула `(v·R + m·C) / (v + m)` читается на
     * каждой странице сериала. Второе место для того же числа означало бы два
     * значения, которые могут разойтись.
     *
     * Проход ежечасный, а не при каждой оценке: при оценке C двигался бы
     * запросом по всей истории голосов, а рейтинг читается на каждой странице
     * (M4 §0, измерение 14). Голоса серий в C не входят — у серии своего
     * агрегата нет (F-04-02).
     *
     * @param {Date} at
     * @returns {Promise<{votes: number, average: number, defaulted: boolean}>}
     */
    async refreshSiteAverage(at = new Date()) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS votes, coalesce(sum(value), 0)::float AS sum
           FROM e_rating r
          WHERE r.object_type = 'series' AND r.counted
            AND NOT EXISTS (
              SELECT 1 FROM e_restriction ban
               WHERE ban.user_id = r.user_id AND ban.kind = 'ban'
                 AND ban.revoked_at IS NULL) `,
      );
      const votes = Number(rows[0].votes);
      const sum = Number(rows[0].sum);
      const average = votes ? sum / votes : RATING.priorMeanDefault;

      // Проход переписывает априор у всех сериалов сразу, а параллельная
      // запись может держать одну из этих строк: PostgreScript в такой встрече
      // выбирает жертвой одну из транзакций, и проход падает с 40P01. Повтор
      // через мгновение — обычная практика для массовых обновлений.
      await withDeadlockRetry(() => pool.query(
        'UPDATE e_series_rating_stat SET prior_mean = $1, recalculated_at = $2',
        [average, at],
      ));

      return { votes, average, defaulted: votes === 0 };
    },

    /**
     * Вводит в агрегат оценки аккаунтов, дожидавших своего возраста (EC-V4).
     *
     * Голос сохранялся, но не учитывался: человек поставил оценку сразу после
     * регистрации, и его мнение не должно было сдвигать число, которое увидят
     * другие. Через `rating.min_account_age_h` оно входит — и входит один раз,
     * с движением агрегата, как и любая другая запись.
     *
     * @param {Date} at
     * @returns {Promise<number>} сколько голосов введено
     */
    async countMaturedRatings(at = new Date()) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const promoted = await client.query(
          // Возраст считается в SQL, а приходит временная метка: сравнение
          // интервала с параметром без типа PostgreSQL не разрешает.
          `UPDATE e_rating r
              SET counted = TRUE, updated_at = $1::timestamptz
             FROM e_user u
            WHERE u.id = r.user_id AND NOT r.counted
              AND $2::timestamptz - u.registered_at >= ($3 || ' hours')::interval
            RETURNING r.series_id, r.value, r.object_type`,
          [at, at, String(RATING.minAccountAgeH)],
        );
        if (!promoted.rowCount) {
          await client.query('COMMIT');
          return 0;
        }

        // Агрегат двигается суммой по сериалам: голоса могли дозреть сразу у
        // нескольких человек по разным сериалам, и поход по каждому отдельно
        // означал бы запрос на каждую строку. Оценки серий (F-04-02) в него не
        // идут: `e_series_rating_stat` считает голоса за сериал, а у серии
        // агрегата нет вовсе — её среднее читается из строк.
        const delta = new Map();
        for (const row of promoted.rows) {
          if (row.object_type !== 'series') continue;
          const seen = delta.get(row.series_id) ?? { sum: 0, votes: 0 };
          seen.sum += Number(row.value);
          seen.votes += 1;
          delta.set(row.series_id, seen);
        }
        for (const [seriesId, seen] of delta) {
          // eslint-disable-next-line no-await-in-loop
          await client.query(
            `INSERT INTO e_series_rating_stat (series_id, sum_value, votes, recalculated_at)
             VALUES ($1, 0, 0, $2) ON CONFLICT (series_id) DO NOTHING`,
            [seriesId, at],
          );
          // eslint-disable-next-line no-await-in-loop
          await client.query(
            `UPDATE e_series_rating_stat
                SET sum_value = sum_value + $2::numeric, votes = votes + $3::int,
                    recalculated_at = $4
              WHERE series_id = $1`,
            [seriesId, seen.sum, seen.votes, at],
          );
        }

        await client.query('COMMIT');
        return promoted.rowCount;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}