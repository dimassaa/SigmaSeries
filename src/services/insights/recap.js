// Персональные итоги (M7, F-07-01).
//
// Итоги — представление существующих отметок: своих сущностей у модуля нет,
// ничего не копируется и не дублируется. Считаются только точные отметки:
// ретро-отметка «отметить всё до этой» говорит о нажатии, а не о вкусе, и
// включение её в «любимое время суток» дало бы правдоподобный, но
// бессмысленный результат.
//
// Слайд — одно утверждение и одно число. Текст собирает вид: сервис
// отдаёт данные, а не готовые фразы (R-I18N-14).

import pg from 'pg';

import { WRAPPED } from '../../config/settings.js';

/** Периоды: год, месяц, всё время. */
export const PERIODS = ['year', 'month', 'all'];

/**
 * Итоги человека.
 *
 * @param {pg.Pool} pool
 */
/**
 * @typedef {object} RecapSlide
 * @property {string} key ключ слайда
 * @property {number|string} value крупное число
 * @property {string|null} unit единица измерения числом
 * @property {Record<string, string|number>} params числа для текста
 * @property {{href: string, title: string}|null} link сериал, о котором слайд
 * @property {boolean} notePlural у текста есть множественное число
 */

/**
 * @typedef {object} RecapData
 * @property {string} period выбранный период
 * @property {number} year
 * @property {number} month
 * @property {string} timezone
 * @property {boolean} enough данных достаточно для слайдов
 * @property {number} marks точных отметок
 * @property {number} series сериалов с отметками
 * @property {number} hours часов по известным длительностям
 * @property {RecapSlide[]} slides
 */

export function pgRecap(pool) {
  /**
   * Год и месяц в часовом поясе человека.
   *
   * @param {number} userId
   * @returns {Promise<{timezone: string, year: number, month: number}|null>}
   */
  async function clock(userId) {
    const { rows } = await pool.query(
      `SELECT u.timezone AS tz,
              EXTRACT(YEAR FROM now() AT TIME ZONE u.timezone)::int AS year,
              EXTRACT(MONTH FROM now() AT TIME ZONE u.timezone)::int AS month
         FROM e_user u WHERE u.id = $1`,
      [userId],
    );
    const row = rows[0];
    if (!row) return null;
    return { timezone: row.tz, year: Number(row.year), month: Number(row.month) };
  }

  /**
   * Условие периода для отметок.
   *
   * Границы периода считаются в часовом поясе человека: его полночь и его
   * год — не московские (F-07-01 §8в).
   *
   * @param {string} period
   * @param {{year: number, month: number}} when
   * @returns {{sql: string, params: number[]}}
   */
  function periodFilter(period, when) {
    if (period === 'month') {
      return {
        sql: `AND EXTRACT(YEAR FROM m.marked_at AT TIME ZONE $2)::int = $3
                AND EXTRACT(MONTH FROM m.marked_at AT TIME ZONE $2)::int = $4`,
        params: [when.year, when.month],
      };
    }
    if (period === 'year') {
      return {
        sql: 'AND EXTRACT(YEAR FROM m.marked_at AT TIME ZONE $2)::int = $3',
        params: [when.year],
      };
    }
    return { sql: '', params: [] };
  }

  /**
   * Слайды итогов.
   *
   * @param {object} args
   * @param {number} args.userId
   * @param {string} [args.period]
   * @returns {Promise<RecapData|null>}
   */
  async function slides({ userId, period = 'year' }) {
    const when = await clock(userId);
    if (!when) return null;
    const filter = periodFilter(period, when);

    const { rows: marks } = await pool.query(
      `SELECT m.marked_at,
              EXTRACT(HOUR FROM m.marked_at AT TIME ZONE $2)::int AS hour_local,
              e.id AS episode_id, e.number AS episode_number, e.runtime_min,
              sn.number AS season_number,
              s.id AS series_id, s.slug AS series_slug,
              coalesce(s.title_ru, s.title_original) AS series_title,
              s.publication_state
         FROM e_watch_mark m
         JOIN e_episode e ON e.id = m.episode_id
         JOIN e_season sn ON sn.id = e.season_id
         JOIN e_series s ON s.id = sn.series_id
        WHERE m.user_id = $1 AND m.precision = 'exact' ${filter.sql}
        ORDER BY m.marked_at`,
      [userId, when.timezone, ...filter.params],
    );

    const { rows: [statuses] } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM e_watch_status
           WHERE user_id = $1 AND status = 'planned') AS planned,
         (SELECT count(*)::int FROM e_watch_status
           WHERE user_id = $1 AND status = 'dropped') AS dropped,
         (SELECT json_agg(x ORDER BY x.changed_at DESC) FROM (
            SELECT s.slug, coalesce(s.title_ru, s.title_original) AS title, ws.changed_at
              FROM e_watch_status ws JOIN e_series s ON s.id = ws.series_id
             WHERE ws.user_id = $1 AND ws.status = 'dropped' AND s.publication_state = 'published'
             LIMIT 1) x) AS dropped_series,
         (SELECT json_agg(x) FROM (
            SELECT s.slug, coalesce(s.title_ru, s.title_original) AS title
              FROM e_watch_status ws JOIN e_series s ON s.id = ws.series_id
             WHERE ws.user_id = $1 AND ws.status = 'planned' AND s.publication_state = 'published'
             LIMIT 1) x) AS planned_series`,
      [userId],
    );

    const { rows: [genre] } = await pool.query(
      `SELECT g.code, g.name_ru, g.name_en, count(*)::int AS n, avg(r.value) AS average,
              (SELECT s2.slug FROM e_rating r2
                 JOIN e_series_genre sg2 ON sg2.series_id = r2.series_id
                 JOIN e_series s2 ON s2.id = r2.series_id
                WHERE r2.user_id = r.user_id AND sg2.genre_code = g.code
                  AND r2.counted AND r2.object_type = 'series'
                  AND s2.publication_state = 'published'
                ORDER BY r2.value DESC, s2.id LIMIT 1) AS slug
         FROM e_rating r
         JOIN e_series_genre sg ON sg.series_id = r.series_id
         JOIN e_genre g ON g.code = sg.genre_code
        WHERE r.user_id = $1 AND r.counted AND r.object_type = 'series'
        GROUP BY g.code, g.name_ru, g.name_en, r.user_id
       HAVING count(*) >= 2
        ORDER BY average DESC, count(*) DESC
        LIMIT 2`,
      [userId],
    );

    // ── Сборка слайдов ────────────────────────────────────────────────────────
    const series = new Map();
    const hours = new Map();
    let minutes = 0;
    let knownRuntimes = 0;

    for (const mark of marks) {
      minutes += mark.runtime_min ?? 0;
      if (mark.runtime_min !== null) knownRuntimes += 1;
      hours.set(mark.hour_local, (hours.get(mark.hour_local) ?? 0) + 1);
      const entry = series.get(mark.series_id) ?? {
        title: mark.series_title,
        slug: mark.series_slug,
        live: mark.publication_state === 'published',
        episodes: [],
      };
      entry.episodes.push(mark);
      series.set(mark.series_id, entry);
    }

    const result = [];
    const markCount = marks.length;
    const seriesCount = series.size;

    // 1. Сколько сериалов и часов (F-07-01 §4).
    if (markCount > 0) {
      result.push({
        key: 'series',
        value: seriesCount,
        unit: 'series',
        notePlural: true,
        params: { count: Math.round(minutes / 60), unknown: markCount - knownRuntimes },
        link: null,
      });
    }

    // 2. Любимый сериал — тот, где отмечено больше всего серий.
    const live = [...series.values()].filter((entry) => entry.live);
    if (live.length) {
      const favourite = live.reduce((best, entry) => (entry.episodes.length > best.episodes.length ? entry : best));
      if (favourite.episodes.length > 1) {
        result.push({
          key: 'favourite',
          value: favourite.episodes.length,
          unit: 'episodes',
          params: { title: favourite.title },
          link: { href: `/series/${favourite.slug}`, title: favourite.title },
        });
      }
    }

    // 3. Любимое время суток отметок.
    if (hours.size) {
      const [hour, count] = [...hours.entries()].reduce((best, item) => (item[1] > best[1] ? item : best));
      if (count > 1) {
        result.push({
          key: 'hour',
          value: count,
          unit: 'marks',
          params: { hour },
          link: null,
        });
      }
    }

    // 4. Самый длинный марафон подряд: подряд идущие серии одного сериала.
    let marathon = null;
    for (const entry of live) {
      const sorted = [...entry.episodes].sort((a, b) => a.season_number - b.season_number
        || a.episode_number - b.episode_number);
      let run = 0;
      let previous = null;
      for (const mark of sorted) {
        const continues = previous
          && previous.season_number === mark.season_number
          && previous.episode_number + 1 === mark.episode_number;
        run = continues ? run + 1 : 1;
        previous = mark;
        if (!marathon || run > marathon.length) marathon = { length: run, entry };
      }
    }
    if (marathon && marathon.length > 1) {
      result.push({
        key: 'marathon',
        value: marathon.length,
        unit: 'episodes',
        params: { title: marathon.entry.title },
        link: { href: `/series/${marathon.entry.slug}`, title: marathon.entry.title },
      });
    }

    // 5. Любимый жанр — по средней оценке при не меньше двух сериалах.
    if (genre && genre.n >= 2) {
      result.push({
        key: 'genre',
        value: Math.round(Number(genre.average) * 10) / 10,
        unit: null,
        params: { title: genre.name_ru, count: genre.n, name: genre.name_en },
        link: genre.slug ? { href: `/series/${genre.slug}`, title: genre.name_ru } : null,
      });
    }

    // 6. Сериал, который брошен чаще всего.
    const droppedSeries = statuses?.dropped_series?.[0] ?? null;
    if (Number(statuses?.dropped ?? 0) > 0 && droppedSeries) {
      result.push({
        key: 'dropped',
        value: Number(statuses.dropped),
        unit: 'series',
        params: { title: droppedSeries.title },
        link: { href: `/series/${droppedSeries.slug}`, title: droppedSeries.title },
      });
    }

    // 7. Сколько сериалов осталось в планах.
    const plannedSeries = statuses?.planned_series?.[0] ?? null;
    if (Number(statuses?.planned ?? 0) > 0 && plannedSeries) {
      result.push({
        key: 'planned',
        value: Number(statuses.planned),
        unit: 'series',
        params: { title: plannedSeries.title },
        link: { href: `/series/${plannedSeries.slug}`, title: plannedSeries.title },
      });
    }

    const enough = markCount >= WRAPPED.minMarks || seriesCount >= WRAPPED.minSeries;

    return {
      period,
      year: when.year,
      month: when.month,
      timezone: when.timezone,
      enough,
      marks: markCount,
      series: seriesCount,
      hours: Math.round(minutes / 60),
      slides: result,
    };
  }

  /**
   * Приглашение к итогам считается прочитанным, когда человек открыл итоги.
   *
   * @param {number} userId
   * @param {number} year
   * @returns {Promise<void>}
   */
  async function markInviteRead(userId, year) {
    await pool.query(
      `UPDATE e_notification SET read_at = now()
        WHERE user_id = $1 AND kind = 'recap_ready' AND dedup_key = $2 AND read_at IS NULL`,
      [userId, `recap:${year}`],
    );
  }

  return { slides, clock, markInviteRead };
}
