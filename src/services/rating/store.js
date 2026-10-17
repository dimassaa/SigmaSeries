// Оценка сериала (F-04-01, OP-03).
//
// Три правила, из-за которых сервис и существует:
//
//  1. Право проверяется на сервере, а не тем, что кнопка нарисована (EC-V1,
//     H-07): оценить сериал можно, только отметив хотя бы одну его серию,
//     и только подтверждённым адресом. Скрытая кнопка обходится прямым
//     запросом, и правило, объявленное только в интерфейсе, правилом не
//     является.
//  2. Агрегат живёт в `e_series_rating_stat` и меняется приращением, а не
//     пересчётом: рейтинг читается на каждой странице сериала (M4 §0,
//     измерение 14 — «пересчёт агрегатов приращением»). Пересчёт по всем
//     строкам при каждой оценке означал бы запрос по всей истории голосов.
//  3. Голос аккаунта младше `rating.min_account_age_h` сохраняется, но в
//     агрегат не входит (EC-V4, H-74): оценка человека, созданного час на
//     назад, не должна сдвигать число, которое увидят другие. Войдёт, когда
//     возраст будет достигнут — это делает ежечасный проход.

import pg from 'pg';

import { RATING } from '../../config/settings.js';
import { HOUR } from '../../config/settings.js';

/** Причина отказа — короткая строка, по ней маршрут выбирает текст. */
export const REASONS = {
  NO_MARK: 'no-mark',
  NOT_CONFIRMED: 'not-confirmed',
  RANGE: 'range',
  MISSING: 'missing',
};

/**
 * Источник данных оценок.
 *
 * @param {pg.Pool} pool
 */
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
     * @returns {Promise<number|null>}
     */
    async ownRating(userId, seriesId) {
      const { rows } = await pool.query(
        `SELECT value FROM e_rating
          WHERE user_id = $1 AND series_id = $2
            AND object_type = 'series' AND episode_id IS NULL`,
        [userId, seriesId],
      );
      return rows[0]?.value ?? null;
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
        `SELECT sum_value::float AS sum, votes, prior_weight, prior_mean
           FROM e_series_rating_stat WHERE series_id = $1`,
        [seriesId],
      );
      const row = rows[0] ?? { sum: 0, votes: 0, prior_weight: RATING.priorWeight, prior_mean: RATING.priorMeanDefault };
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

    /** Сырые голос и сумма — для проверок и пересчёта. */
    async statOf(seriesId) {
      const { rows } = await pool.query(
        'SELECT votes, sum_value::float AS sum FROM e_series_rating_stat WHERE series_id = $1',
        [seriesId],
      );
      return {
        votes: Number(rows[0]?.votes ?? 0),
        sum: Number(rows[0]?.sum ?? 0),
      };
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
            RETURNING r.series_id, r.value`,
          [at, at, String(RATING.minAccountAgeH)],
        );
        if (!promoted.rowCount) {
          await client.query('COMMIT');
          return 0;
        }

        // Агрегат двигается суммой по сериалам: голоса могли дозреть сразу у
        // нескольких человек по разным сериалам, и поход по каждому отдельно
        // означал бы запрос на каждую строку.
        const delta = new Map();
        for (const row of promoted.rows) {
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