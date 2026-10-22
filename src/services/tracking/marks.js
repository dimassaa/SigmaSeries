// Отметки серий (F-03-02, OP-10 — пересчёт прогресса).
//
// Три правила, на которых держится вся фича:
//
//  1. Отметить можно только то, что вышло (EC-T2), и отказ называет дату —
//     иначе человек думает, что кнопка сломалась.
//  2. Запросы «поставить» и «снять», а не «переключить»: двойной клик и
//     повтор с двух устройств не должны оставлять две отметки (EC-T1, EC-T18).
//  3. Массовые действия отменяемы: отмена возвращает именно то, что было до
//     неё, и не трогает отметки, поставленные позже.
//
// Точность `retro` ставится массовым действиям: человек смотрел это до того,
// как появилась кнопка, и время нажатия ничего не значит (F-03-02 §8б).

import pg from 'pg';

import { syncSubscriptionForStatus } from './status.js';
import { recompute as refreshProgress } from './progress.js';

/** `tracking.undo_window_s` (M3 §0): десять секунд на отмену. */
export const UNDO_WINDOW_SECONDS = 10;

export function pgMarks(pool) {
  return {
    /**
     * Отметки зрителя по сериалу.
     *
     * @param {number} userId
     * @param {number} seriesId
     * @returns {Promise<{episodeId: number, episodeNumber: number, precision: string}[]>}
     */
    async markedOf(userId, seriesId) {
      const { rows } = await pool.query(
        `SELECT m.episode_id, e.number AS episode_number, m.precision
           FROM e_watch_mark m
           JOIN e_episode e ON e.id = m.episode_id
           JOIN e_season se ON se.id = e.season_id
          WHERE m.user_id = $1 AND se.series_id = $2
          ORDER BY se.number, e.number`,
        [userId, seriesId],
      );
      return rows.map((row) => ({
        episodeId: row.episode_id,
        episodeNumber: row.episode_number,
        precision: row.precision,
      }));
    },

    /**
     * Поставить или снять отметку одной серии.
     *
     * @param {object} args
     * @param {number} args.userId
     * @param {number} args.episodeId
     * @param {boolean} args.on `true` — поставить, `false` — снять
     * @param {string} [args.today] сегодня пояса зрителя `YYYY-MM-DD`
     * @returns {Promise<{ok: boolean, reason?: string, date?: string, marked?: number}>}
     */
    async setMark({ userId, episodeId, on, today = isoToday() }) {
      const episode = await episodeWithRelease(pool, episodeId);
      if (!episode) return { ok: false, reason: 'missing' };
      // Скрытая админом серия: отметка остаётся, но её больше нельзя поставить и
      // снять из интерфейса — в прогрессе она исключена (EC-T9).
      if (!episode.visible) return { ok: false, reason: 'hidden' };

      if (on) {
        if (!episode.releaseDate) return { ok: false, reason: 'no-date' };
        if (episode.releaseDate > today) return { ok: false, reason: 'not-aired', date: episode.releaseDate };

        await pool.query(
          `INSERT INTO e_watch_mark (user_id, episode_id, precision)
           VALUES ($1, $2, 'exact')
           ON CONFLICT (user_id, episode_id) DO NOTHING`,
          [userId, episodeId],
        );
      } else {
        await pool.query('DELETE FROM e_watch_mark WHERE user_id = $1 AND episode_id = $2', [userId, episodeId]);
      }

      await afterChange(pool, { userId, seriesId: episode.seriesId });
      return { ok: true };
    },

    /**
     * Отметить все вышедшие серии сезона (EC-T6).
     *
     * @param {object} args
     * @param {number} args.userId
     * @param {number} args.seasonId
     * @param {string} [args.today]
     * @returns {Promise<{ok: boolean, marked?: number, batchId?: number, reason?: string}>}
     */
    async markSeason({ userId, seasonId, today = isoToday() }) {
      const season = await seasonWithEpisodes(pool, seasonId, today);
      if (!season) return { ok: false, reason: 'missing' };
      if (!season.aired.length) return { ok: false, reason: 'nothing-aired' };

      const batchId = await bulkMark(pool, { userId, episodeIds: season.aired.map((row) => row.id) });
      await afterChange(pool, { userId, seriesId: season.seriesId });
      return { ok: true, marked: season.aired.length, batchId };
    },

    /**
     * Отметить все вышедшие серии до выбранной включительно (F-03-02 §4).
     *
     * Порядок — по (сезон, номер), а не по дате: пропуски в нумерации не должны
     * выбрасывать из действия серии предыдущих сезонов (EC-T11).
     *
     * @param {object} args
     * @param {number} args.userId
     * @param {number} args.seriesId
     * @param {number} args.season
     * @param {number} args.episode
     * @param {string} [args.today]
     */
    async markUpTo({ userId, seriesId, season, episode, today = isoToday() }) {
      const { rows } = await pool.query(
        `SELECT e.id,
                (SELECT min(r.release_date)::text FROM e_release_episode rle
                   JOIN e_release r ON r.id = rle.release_id
                  WHERE rle.episode_id = e.id) AS release_date
           FROM e_episode e
           JOIN e_season se ON se.id = e.season_id
          WHERE se.series_id = $1 AND se.number > 0
            AND (se.number, e.number) <= ($2, $3)
          ORDER BY se.number, e.number`,
        [seriesId, season, episode],
      );

      const aired = rows.filter((row) => row.release_date && row.release_date <= today);
      if (!aired.length) return { ok: false, reason: 'nothing-aired' };

      const batchId = await bulkMark(pool, { userId, episodeIds: aired.map((row) => row.id) });
      await afterChange(pool, { userId, seriesId });
      return { ok: true, marked: aired.length, batchId };
    },

    /**
     * Отменить массовую отметку.
     *
     * @param {object} args
     * @param {number} args.userId
     * @param {number} args.batchId
     * @param {string} [args.today]
     */
    async undo({ userId, batchId, today = isoToday() }) {
      const { rows } = await pool.query(
        'SELECT id, undone_at FROM e_mark_batch WHERE id = $1 AND user_id = $2',
        [batchId, userId],
      );
      // Чужой или повторно отменённый пакет: молча успешным ответом было бы
      // враньём — человек решит, что отменил, а ничего не изменилось.
      if (!rows.length || rows[0].undone_at) return { ok: false, reason: 'not-found' };

      // Сериалы собираются ДО удаления отметок: после удаления связь пропала бы,
      // и прогресс с ними остался бы прежним — а человек увидел бы «3 из 3»
      // после того, как отменил всё.
      const { rows: affected } = await pool.query(
        `SELECT DISTINCT se.series_id
           FROM e_watch_mark m
           JOIN e_episode e ON e.id = m.episode_id
           JOIN e_season se ON se.id = e.season_id
          WHERE m.user_id = $1 AND m.batch_id = $2`,
        [userId, batchId],
      );

      await pool.query('UPDATE e_mark_batch SET undone_at = now() WHERE id = $1', [batchId]);
      const removed = await pool.query(
        'DELETE FROM e_watch_mark WHERE user_id = $1 AND batch_id = $2',
        [userId, batchId],
      );

      for (const { series_id: seriesId } of affected) {
        await afterChange(pool, { userId, seriesId, today });
      }

      return { ok: true, removed: removed.rowCount };
    },

  };
}

/**
 * Массовая отметка одним пакетом.
 *
 * @param {pg.Pool} pool
 * @param {object} args
 * @param {number} args.userId
 * @param {number[]} args.episodeIds
 * @returns {Promise<number>} номер пакета для отмены
 */
async function bulkMark(pool, { userId, episodeIds }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO e_mark_batch (user_id) VALUES ($1) RETURNING id',
      [userId],
    );
    const batchId = rows[0].id;

    // `ON CONFLICT DO NOTHING`: уже отмеченная серия не меняет своей точности.
    // Ретро-отметка поверх точной сделала бы «когда посмотрел» недостоверным,
    // а наоборот — точной поверх ретро: человек только что нажал кнопку.
    await client.query(
      `INSERT INTO e_watch_mark (user_id, episode_id, precision, batch_id)
       SELECT $1, unnest($2::bigint[]), 'retro', $3
       ON CONFLICT (user_id, episode_id) DO NOTHING`,
      [userId, episodeIds, batchId],
    );
    await client.query('COMMIT');
    return batchId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Что пересчитывается после смены отметок (F-03-02 §8д).
 *
 * Порядок важен: сначала прогресс (он считает статус), потом статус, иначе
 * статус пересчитался бы по устаревшему прогрессу. Пересчёт живёт в
 * `progress.js` — тем же кодом, который читает кэш.
 */
async function afterChange(pool, { userId, seriesId, today = isoToday() }) {
  const progress = await refreshProgress(pool, { userId, seriesId, today });
  await applyStatusAfterMarks(pool, { userId, seriesId, progress, today });
}

/**
 * Статус после отметок (H-69, EC-T20).
 *
 * Правило узкое и намеренно: первая отметка при отсутствующем статусе, «В
 * планах», «Отложено» или «Брошено» переводит в «Смотрю». У идущего сериала
 * статус сам не меняется, а «Просмотрено» не откатывается в «Смотрю» из-за
 * одной новой отметки.
 */
async function applyStatusAfterMarks(pool, { userId, seriesId, progress, today }) {
  const { rows } = await pool.query(
    'SELECT status, source FROM e_watch_status WHERE user_id = $1 AND series_id = $2',
    [userId, seriesId],
  );
  const current = rows[0]?.status ?? null;
  const source = rows[0]?.source ?? 'manual';

  // Сняли все отметки: статус, который поставил человек, остаётся (EC-T12), а
  // автоматический — отменяется вместе с отметками, которые его вызвали.
  if (!progress.marked) {
    if (current && source === 'auto') {
      await pool.query('DELETE FROM e_watch_status WHERE user_id = $1 AND series_id = $2', [userId, seriesId]);
      await syncSubscriptionForStatus(pool, { userId, seriesId, enabled: false });
    }
    return;
  }
  // Ручной «Просмотрено» или «Смотрю» — не трогаем: человек сказал, что он
  // думает о сериале, и отметки не должны перебивать его решение.
  if (current === 'watching' || (current === 'watched' && source === 'manual')) return;

  const { rows: series } = await pool.query(
    "SELECT exit_state FROM e_series WHERE id = $1",
    [seriesId],
  );
  const ended = series[0]?.exit_state === 'ended';
  const complete = progress.aired > 0 && progress.marked === progress.aired;

  // Автопереход в «Просмотрено» — только завершённому сериалу: у идущего статус
  // сам не меняется (H-69, EC-T20).
  if (complete && ended) {
    await setStatus(pool, { userId, seriesId, status: 'watched' });
    await syncSubscriptionForStatus(pool, { userId, seriesId, enabled: false });
    return;
  }

  // Откат автоматического «Просмотрено», когда выход перестал быть полным:
  // «Просмотрено» человека не трогаем (см. выше), автоматическое — можно.
  if (current === 'watched') {
    await setStatus(pool, { userId, seriesId, status: 'watching' });
    await syncSubscriptionForStatus(pool, { userId, seriesId, enabled: true });
    return;
  }

  await setStatus(pool, { userId, seriesId, status: 'watching' });
  // Статус «Смотрю» включает подписку на выходы (H-70), как и кнопка статуса.
  await syncSubscriptionForStatus(pool, { userId, seriesId, enabled: true });
}

/**
 * Запись статуса с пометкой источника.
 *
 * @param {import('pg').Pool} pool
 * @param {object} args
 * @param {number} args.userId
 * @param {number} args.seriesId
 * @param {string} args.status
 * @param {'manual'|'auto'} [args.source]
 */
async function setStatus(pool, { userId, seriesId, status, source = 'auto' }) {
  await pool.query(
    `INSERT INTO e_watch_status (user_id, series_id, status, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, series_id) DO UPDATE
       SET status = EXCLUDED.status, source = EXCLUDED.source, changed_at = now()`,
    [userId, seriesId, status, source],
  );
}

/** Серия с датой выхода и видимостью её сериала. */
async function episodeWithRelease(pool, episodeId) {
  const { rows } = await pool.query(
    `SELECT e.id, se.series_id,
            (SELECT min(r.release_date)::text FROM e_release_episode rle
               JOIN e_release r ON r.id = rle.release_id
              WHERE rle.episode_id = e.id) AS release_date,
            s.publication_state = 'published' AND s.archived_at IS NULL AS visible
       FROM e_episode e
       JOIN e_season se ON se.id = e.season_id
       JOIN e_series s ON s.id = se.series_id
      WHERE e.id = $1`,
    [episodeId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    seriesId: row.series_id,
    releaseDate: row.release_date,
    visible: row.visible === true,
  };
}

async function seasonWithEpisodes(pool, seasonId, today) {
  const { rows } = await pool.query(
    `SELECT se.series_id, e.id,
            (SELECT min(r.release_date)::text FROM e_release_episode rle
               JOIN e_release r ON r.id = rle.release_id
              WHERE rle.episode_id = e.id) AS release_date
       FROM e_season se
       JOIN e_episode e ON e.season_id = se.id
       JOIN e_series s ON s.id = se.series_id
      WHERE se.id = $1 AND se.number > 0
        AND s.publication_state = 'published' AND s.archived_at IS NULL`,
    [seasonId],
  );
  if (!rows.length) return null;
  return {
    seriesId: rows[0].series_id,
    aired: rows.filter((row) => row.release_date && row.release_date <= today),
  };
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}