// График серий: даты выходов (F-10-05, S-75 «Серии»).
//
// Даты приходят из импорта, и импорт знает их не всегда. Админ правит их
// руками, и ручная дата закрывается от перезаписи (H-41): смена даты
// в `e_release.locked` — и импорт её больше не трогает.
//
// Генератор: «сезон N: K серий, по средам, с 15.10, каждую неделю» —
// вторая неделя пропускается, а не сдвигается. Все серии в один день —
// одна группа с общей датой (`covers_season`).

/** Состояния выхода, которые можно поставить вручную. */
const RELEASE_STATES = ['tba', 'scheduled', 'aired', 'delayed', 'cancelled'];

/** Дни недели по-русски: 1 — понедельник. */
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * График серий студии.
 *
 * @param {import('pg').Pool} pool
 */
export function pgStudioSchedule(pool) {
  /**
   * Сезоны сериала с сериями и их датами.
   *
   * @param {number} seriesId
   * @returns {Promise<object[]>}
   */
  async function forSeries(seriesId) {
    const { rows: seasons } = await pool.query(
      `SELECT id, number, title_ru, title_en
         FROM e_season WHERE series_id = $1 ORDER BY number`,
      [seriesId],
    );

    const seasonsOut = [];
    for (const season of seasons) {
      const { rows: episodes } = await pool.query(
        `SELECT e.id, e.number, e.title_ru, e.title_en, e.runtime_min,
                r.id AS release_id, r.release_date, r.release_time, r.precision,
                r.state, r.locked, r.covers_season
           FROM e_episode e
           LEFT JOIN LATERAL (
             -- Выход связан с серией через таблицу e_release_episode:
             -- колонка episode_id есть, но импорт её не заполняет (F-12-06).
             SELECT r.* FROM e_release r
               JOIN e_release_episode re ON re.release_id = r.id
              WHERE re.episode_id = e.id
              ORDER BY r.release_date LIMIT 1
           ) r ON true
          WHERE e.season_id = $1
          ORDER BY e.number`,
        [season.id],
      );
      const { rows: groupReleases } = await pool.query(
        `SELECT id, release_date, release_time, precision, state, locked, covers_season
           FROM e_release
          WHERE season_id = $1 AND episode_id IS NULL
          ORDER BY release_date`,
        [season.id],
      );

      seasonsOut.push({
        id: Number(season.id),
        number: Number(season.number),
        titleRu: season.title_ru,
        titleEn: season.title_en,
        episodes: episodes.map((episode) => ({
          id: Number(episode.id),
          number: Number(episode.number),
          titleRu: episode.title_ru,
          titleEn: episode.title_en,
          runtime: episode.runtime_min,
          releaseId: episode.release_id === null ? null : Number(episode.release_id),
          date: episode.release_date,
          time: episode.release_time,
          precision: episode.precision,
          state: episode.state,
          locked: Boolean(episode.locked),
        })),
        // Группы: несколько серий с одной датой.
        groups: groupReleases.map((group) => ({
          id: Number(group.id),
          date: group.release_date,
          time: group.release_time,
          precision: group.precision,
          state: group.state,
          locked: Boolean(group.locked),
          coversSeason: Boolean(group.covers_season),
        })),
      });
    }
    return seasonsOut;
  }

  /**
   * Поставить дату серии.
   *
   * @param {object} input
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function setDate({ seriesId, seasonId, episodeId = null, date, time = null, state = 'scheduled', byId = null }) {
    const when = String(date ?? '').trim();
    if (when && !/^\d{4}-\d{2}-\d{2}$/.test(when)) return { ok: false, reason: 'date' };
    if (!RELEASE_STATES.includes(state)) return { ok: false, reason: 'state' };

    const { rows: [season] } = await pool.query(
      'SELECT id FROM e_season WHERE id = $1 AND series_id = $2', [seasonId, seriesId],
    );
    if (!season) return { ok: false, reason: 'not_found' };

    // Выход серии ищется через таблицу связей: импорт кладёт связь туда, и
    // колонка episode_id у выхода не заполняется.
    const existing = await pool.query(
      `SELECT r.id FROM e_release r
         JOIN e_release_episode re ON re.release_id = r.id
        WHERE r.season_id = $1 AND re.episode_id = $2
        ORDER BY r.release_date LIMIT 1`,
      [seasonId, episodeId],
    );
    const row = existing.rows[0];

    if (!when) {
      // Дата снята: выход остаётся, но без даты (TBA).
      if (row) {
        await pool.query(
          `UPDATE e_release SET release_date = $2, release_time = NULL, state = 'tba',
                  precision = 'date', locked = TRUE
            WHERE id = $1`,
          [row.id, '1900-01-01'],
        );
      }
      return { ok: true, cleared: true };
    }

    if (row) {
      await pool.query(
        `UPDATE e_release
            SET release_date = $2, release_time = $3, state = $4,
                precision = $5, locked = TRUE
          WHERE id = $1`,
        [row.id, when, time, state, time ? 'exact' : 'date'],
      );
    } else {
      // Новый выход: строка выхода и связь с серией. Связь — в своей таблице,
      // так же, как её пишет импорт.
      const { rows: [created] } = await pool.query(
        `INSERT INTO e_release (season_id, release_date, release_time, precision, state, locked)
         VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id`,
        [seasonId, when, time, time ? 'exact' : 'date', state],
      );
      if (episodeId !== null) {
        await pool.query(
          `INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [created.id, episodeId],
        );
      }
    }
    await refreshExitState(seriesId);
    return { ok: true };
  }

  /**
   * Сдвинуть все даты сериала на N дней.
   *
   * @param {{seriesId: number, days: number, byId: number|null}} input
   * @returns {Promise<number>} сколько дат сдвинуто
   */
  async function shift({ seriesId, days, byId = null }) {
    const offset = Number(days);
    if (!Number.isInteger(offset) || offset === 0) return 0;
    const { rowCount } = await pool.query(
      `UPDATE e_release r
          SET release_date = r.release_date + ($3 || ' days')::interval
         FROM e_season se
        WHERE se.id = r.season_id AND se.series_id = $1 AND r.release_date > '1900-01-01'
          AND (r.locked OR $2)`,
      [seriesId, false, String(offset)],
    );
    await refreshExitState(seriesId);
    return rowCount;
  }

  /**
   * Сгенерировать даты сезона.
   *
   * @param {object} input
   * @returns {Promise<{ok: boolean, reason?: string, created?: number}>}
   */
  async function generate({
    seriesId, seasonNumber, count, weekdays = ['wed'], from, step = 'week', time = null, byId = null,
  }) {
    const total = Number(count);
    if (!Number.isInteger(total) || total < 1 || total > 500) return { ok: false, reason: 'count' };
    const start = String(from ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return { ok: false, reason: 'date' };
    const days = weekdays.map((day) => WEEKDAYS.indexOf(day)).filter((day) => day >= 0);
    if (!days.length) return { ok: false, reason: 'weekdays' };
    const period = step === 'biweek' ? 14 : 7;

    const { rows: [season] } = await pool.query(
      'SELECT id FROM e_season WHERE series_id = $1 AND number = $2', [seriesId, Number(seasonNumber)],
    );
    if (!season) return { ok: false, reason: 'season' };

    const { rows: episodes } = await pool.query(
      'SELECT id, number FROM e_episode WHERE season_id = $1 ORDER BY number', [season.id],
    );
    if (!episodes.length) return { ok: false, reason: 'no_episodes' };

    // Даты по дням недели: от первой указанной даты берём ближайший нужный
    // день, дальше — с шагом в неделю или две.
    const dates = [];
    const cursor = new Date(`${start}T00:00:00Z`);
    while (dates.length < total) {
      const weekday = (cursor.getUTCDay() + 6) % 7;
      if (days.includes(weekday)) {
        dates.push(cursor.toISOString().slice(0, 10));
        if (dates.length === total) break;
        cursor.setUTCDate(cursor.getUTCDate() + period);
        continue;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let created = 0;
      for (let i = 0; i < episodes.length && i < total; i += 1) {
        const date = dates[i];
        const { rows: existing } = await client.query(
          `SELECT r.id FROM e_release r
             JOIN e_release_episode re ON re.release_id = r.id
            WHERE r.season_id = $1 AND re.episode_id = $2
            ORDER BY r.release_date LIMIT 1`,
          [season.id, episodes[i].id],
        );
        if (existing.length) {
          // Чужая дата не переписывается: сперва её снимают, потом ставят.
          await client.query(
            `UPDATE e_release SET release_date = $2, release_time = $3, state = 'scheduled',
                    precision = $4, locked = TRUE
              WHERE id = $1`,
            [existing[0].id, date, time, time ? 'exact' : 'date'],
          );
        } else {
          const { rows: [created] } = await client.query(
            `INSERT INTO e_release (season_id, release_date, release_time, precision, state, locked)
             VALUES ($1, $2, $3, $4, 'scheduled', TRUE) RETURNING id`,
            [season.id, date, time, time ? 'exact' : 'date'],
          );
          await client.query(
            `INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [created.id, episodes[i].id],
          );
        }
        created += 1;
      }
      await client.query('COMMIT');
      await refreshExitState(seriesId);
      return { ok: true, created };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Пересчитать состояние выхода сериала по его датам (F-10-05 §8д).
   *
   * @param {number} seriesId
   * @returns {Promise<void>}
   */
  async function refreshExitState(seriesId) {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM e_season se
            JOIN e_release r ON r.season_id = se.id
           WHERE se.series_id = $1 AND r.release_date <= CURRENT_DATE
             AND r.state IN ('scheduled','aired')) AS aired,
         (SELECT count(*)::int FROM e_season se
            JOIN e_release r ON r.season_id = se.id
           WHERE se.series_id = $1 AND r.release_date > CURRENT_DATE
             AND r.state = 'scheduled') AS planned,
         (SELECT count(*)::int FROM e_episode e
            JOIN e_season se ON se.id = e.season_id
           WHERE se.series_id = $1) AS episodes`,
      [seriesId],
    );
    const row = rows[0];
    const state = row.aired > 0 ? 'airing' : row.planned > 0 ? 'announced' : 'waiting';
    await pool.query(
      'UPDATE e_series SET exit_state = $2 WHERE id = $1 AND exit_state IN (\'airing\',\'announced\',\'waiting\')',
      [seriesId, state],
    );
  }

  return { forSeries, setDate, shift, generate };
}
