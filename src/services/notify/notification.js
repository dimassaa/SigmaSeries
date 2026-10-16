// Уведомления о выходах: данные (F-03-08, OP-09).
//
// Три правила, из-за которых файл и написан:
//
//  1. Один выход — одно уведомление человеку (EC-T6), и держит это ключ
//     дедупликации, а не проверка «есть ли уже». Проверка проигрывает гонке с
//     двумя шагами задачи, а `ON CONFLICT DO NOTHING` — нет: второй шаг,
//     повтор после сбоя и два процесса после перезапуска дают один результат.
//  2. Ключ строится по **выходу**, а не по дате и не по локали. Смена часового
//     пояса сдвигает «сегодня», но не должна прислать то же самое ещё раз
//     (EC-T4), поэтому ни дата, ни текст в ключ не входят.
//  3. Уведомление не доставляется самому себе: получатель отбирается по
//     активному аккаунту, включённой подписке, видимому сериалу и локальной
//     дате подписчика. «Локальная дата» считается в его поясе, а не в
//     серверном: в Минске «сегодня» наступает на шесть часов позже, чем в
//     Лос-Анджелесе, и человек в Калифорнии получил бы уведомление ночью.

import pg from 'pg';

import { categoryOf } from './types.js';

/** Шаг создания: `notify.max_per_user` соседних строк за один запрос (F-03-08 §9). */
export const STEP = 500;

/** Ключ настройки, где задача помнит, докудала она дошла. */
export const CURSOR_KEY = 'notify.last_sweep_at';

/**
 * Источник данных уведомлений.
 *
 * @param {pg.Pool} pool
 */
export function pgNotifications(pool) {
  return {
    /**
     * Выходы, у которых локальная дата уже могла наступить.
     *
     * Границы шире, чем нужно: точную дату каждого подписчика считать в SQL
     * дорого, а лишние выходы отсеются при отборе получателей. Окно вниз
     * ограничено курсором задачи — иначе каждый час читались бы все 87 тысяч
     * вышедших выходов.
     *
     * @param {object} args
     * @param {string} args.from `YYYY-MM-DD`,exclusive
     * @param {string} args.to `YYYY-MM-DD`, включительно
     * @param {number} [args.limit]
     * @returns {Promise<object[]>}
     */
    async dueReleases({ from, to, limit = STEP }) {
      const { rows } = await pool.query(
        `SELECT r.id, r.release_date::text AS date, r.covers_season, se.number AS season,
                s.id AS series_id, s.slug, s.title_ru, s.title_original,
                (SELECT array_agg(e.number ORDER BY e.number) FROM e_release_episode x
                   JOIN e_episode e ON e.id = x.episode_id
                  WHERE x.release_id = r.id) AS episodes
           FROM e_release r
           JOIN e_season se ON se.id = r.season_id
           JOIN e_series s ON s.id = se.series_id
          WHERE r.release_date > $1::date AND r.release_date <= $2::date
            AND (r.covers_season
                 OR EXISTS (SELECT 1 FROM e_release_episode x WHERE x.release_id = r.id))
          ORDER BY r.release_date, r.id
          LIMIT $3`,
        [from, to, limit],
      );
      return rows.map((row) => ({ ...row, episodes: row.episodes ?? [] }));
    },

    /**
     * Получатели уведомления о выходе.
     *
     * `requireStarted` различает два разных вопроса: «серия уже вышла у этого
     * человека» (локальная дата наступила) и «этот человек следит за сериалом»
     * (перенос или отмена — их интересует и будущая дата). Смешать их нельзя:
     * с проверкой даты перенос на три дня вперёд пришёл бы только в день выхода,
     * а это ровно то новостное событие, ради которого человек и следит.
     *
     * @param {object} args
     * @param {number} args.releaseId
     * @param {string} args.date `YYYY-MM-DD` дата выхода
     * @param {number} args.maxPerUser
     * @param {boolean} [args.requireStarted]
     * @param {number[]} [args.skip] пользователи, у которых уже полный список
     * @returns {Promise<number[]>}
     */
    async recipientsOfRelease({ releaseId, date, maxPerUser, requireStarted = true, skip = [] }) {
      const { rows } = await pool.query(
        `SELECT sub.user_id
           FROM e_subscription sub
           JOIN e_user u ON u.id = sub.user_id
           JOIN e_series s ON s.id = sub.series_id
          WHERE sub.series_id = (SELECT se.series_id FROM e_release r
                                   JOIN e_season se ON se.id = r.season_id
                                  WHERE r.id = $1)
            AND sub.kind = 'release' AND sub.enabled
            AND s.publication_state = 'published' AND s.archived_at IS NULL
            AND u.status = 'active' AND u.deleted_at IS NULL
            AND u.notifications_enabled
            AND ($5::boolean IS FALSE OR $2::date <= (now() AT TIME ZONE u.timezone)::date)
            AND NOT (sub.user_id = ANY($3::bigint[]))
            AND (SELECT count(*) FROM e_notification n WHERE n.user_id = sub.user_id) < $4
          ORDER BY sub.user_id`,
        [releaseId, date, skip, maxPerUser, requireStarted],
      );
      return rows.map((row) => row.user_id);
    },

    /**
     * Создать уведомление пачкой.
     *
     * @param {object} args
     * @param {number[]} args.userIds
     * @param {string} args.kind
     * @param {object} args.params
     * @param {string} args.dedupKey
     * @param {number} [args.step]
     * @returns {Promise<{created: number, steps: number}>}
     */
    async create({ userIds, kind, params, dedupKey, step = STEP }) {
      let created = 0;
      let steps = 0;

      for (let offset = 0; offset < userIds.length; offset += step) {
        steps += 1;
        const chunk = userIds.slice(offset, offset + step);
        // eslint-disable-next-line no-await-in-loop
        const { rowCount } = await pool.query(
          `INSERT INTO e_notification (user_id, kind, category, params, dedup_key)
           SELECT u, $1, $2, $3::jsonb, $4 FROM unnest($5::bigint[]) AS u
           ON CONFLICT DO NOTHING`,
          [kind, categoryOf(kind), JSON.stringify(params), dedupKey, chunk],
        );
        created += rowCount;
      }

      return { created, steps };
    },

    /**
     * Перенос: обновить вчерашнее уведомление вместо нового.
     *
     * §8(б): изменения за 24 часа схлопываются в последнее. Уведомление
     * старше суток не трогается — человек уже прочитал «на 12 октября», и
     * молчаливая правка старого текста выглядела бы как ошибка (EC-T5).
     *
     * @param {object} args
     * @param {number[]} args.userIds
     * @param {string} args.kind
     * @param {object} args.params
     * @param {string} args.dedupKey
     * @returns {Promise<{updated: number, created: number}>}
     */
    async upsertChanged({ userIds, kind, params, dedupKey }) {
      const { rows: touched } = await pool.query(
        `INSERT INTO e_notification (user_id, kind, category, params, dedup_key)
         SELECT u, $1, $2, $3::jsonb, $4 FROM unnest($5::bigint[]) AS u
         ON CONFLICT (user_id, dedup_key) DO UPDATE
            SET params = EXCLUDED.params, created_at = now(), read_at = NULL
          WHERE e_notification.created_at > now() - interval '24 hours'
         RETURNING (xmax = 0) AS inserted`,
        [kind, categoryOf(kind), JSON.stringify(params), dedupKey, userIds],
      );

      return {
        created: touched.filter((row) => row.inserted).length,
        updated: touched.filter((row) => !row.inserted).length,
      };
    },

    /**
     * Кому сегодня пришло столько, что пора свернуть в сводку (F-03-08 §5).
     *
     * @param {object} args
     * @param {string} args.kind
     * @param {number} args.threshold
     * @returns {Promise<{userId: number, series: object[], count: number}[]>}
     */
    async digestCandidates({ kind, threshold }) {
      const { rows } = await pool.query(
        `SELECT n.user_id,
                count(*)::int AS n,
                jsonb_agg(jsonb_build_object(
                  'slug', n.params->>'seriesSlug',
                  'title', n.params->>'seriesTitle',
                  'season', n.params->>'season',
                  'episodes', n.params->'episodes',
                  'date', n.params->>'date'
                ) ORDER BY n.params->>'date', n.params->>'seriesTitle') AS series
           FROM e_notification n
           JOIN e_user u ON u.id = n.user_id
          WHERE n.kind = $1
            AND n.dedup_key NOT LIKE 'digest:%'
            AND n.params->>'date' = (now() AT TIME ZONE u.timezone)::date::text
          GROUP BY n.user_id
         HAVING count(*) >= $2`,
        [kind, threshold],
      );
      return rows.map((row) => ({ userId: row.user_id, count: row.n, series: row.series }));
    },

    /**
     * Заменить сводку дня одной записью.
     *
     * @param {object} args
     * @param {number} args.userId
     * @param {string} args.kind
     * @param {number} args.count
     * @param {object[]} args.series
     * @param {string} args.date `YYYY-MM-DD`
     * @returns {Promise<boolean>} `true`, если сводка создана
     */
    async storeDigest({ userId, kind, count, series, date }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `DELETE FROM e_notification
            WHERE user_id = $1 AND kind = $2
              AND params->>'date' = $3 AND dedup_key NOT LIKE 'digest:%'`,
          [userId, kind, date],
        );
        const { rowCount } = await client.query(
          `INSERT INTO e_notification (user_id, kind, category, params, dedup_key)
           VALUES ($1, $2, $3, $4::jsonb, $5)
           ON CONFLICT (user_id, dedup_key) DO NOTHING`,
          [userId, kind, categoryOf(kind), JSON.stringify({ digest: { count, series, date } }),
            `digest:${date}`],
        );
        await client.query('COMMIT');
        return rowCount > 0;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    /**
     * Момент последнего прохода — докат догоняется от него (EC-T17).
     *
     * @returns {Promise<string|null>}
     */
    async cursor() {
      const { rows } = await pool.query(
        'SELECT value FROM e_system_setting WHERE key = $1', [CURSOR_KEY],
      );
      return rows[0]?.value ?? null;
    },

    /**
     * @param {string} value ISO-момент
     * @returns {Promise<void>}
     */
    async saveCursor(value) {
      await pool.query(
        `INSERT INTO e_system_setting (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, changed_at = now()`,
        [CURSOR_KEY, value],
      );
    },
  };
}