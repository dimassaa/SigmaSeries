// Статус просмотра (F-03-01, OP-10 — часть про подписку).
//
// Статус — это и есть закладка: список S-30 строится по строкам `e_watch_status`,
// отдельной таблицы закладок в чтении не участвует. Смена статуса по H-70
// двигает подписку на выходы — иначе фильтр «Мои» в календаре всегда был бы
// пустым.
//
// Правило автоматики и правило человека не смешиваются (EC-T19): строка
// подписки, созданная вручную, автоматикой не переписывается ни в ту, ни в
// другую сторону. Именно поэтому в `ON CONFLICT` стоит `WHERE source = 'auto'`:
// без него «Смотрю» после ручного выключения снова включил бы подписку, а
// человек так и не смог бы от неё отказаться.

import pg from 'pg';

/** Статусы — из `CHECK` в схеме; порядок как в интерфейсе. */
export const STATUSES = ['watching', 'planned', 'watched', 'dropped', 'on_hold'];

/** Статусы, при которых подписка на выходы включена (H-70). */
const SUBSCRIBED = new Set(['watching', 'planned']);

/**
 * Источник данных статусов.
 *
 * @param {pg.Pool} pool
 */
export function pgWatchStatus(pool) {
  return {
    /**
     * Статус пользователя для сериала.
     *
     * @param {number|null} userId `null` у гостя — статуса у него нет
     * @param {number} seriesId
     * @returns {Promise<{status: string, changedAt: string}|null>}
     */
    async of(userId, seriesId) {
      if (!userId) return null;

      const { rows } = await pool.query(
        'SELECT status, changed_at::text FROM e_watch_status WHERE user_id = $1 AND series_id = $2',
        [userId, seriesId],
      );
      const row = rows[0];
      return row ? { status: row.status, changedAt: row.changed_at } : null;
    },

    /**
     * Статусы пользователя для списка S-30 вместе со счётчиками по статусам.
     *
     * @param {number} userId
     * @returns {Promise<{rows: object[], counts: Record<string, number>}>}
     */
    async listOf(userId) {
      const { rows } = await pool.query(
        `SELECT ws.series_id, ws.status, ws.changed_at::text AS changed_at,
                s.slug, coalesce(s.title_ru, s.title_en, s.title_original) AS title,
                s.year_start, s.publication_state, s.archived_at IS NOT NULL AS archived,
                s.exit_state,
                (SELECT iv.width FROM e_image_variant iv
                   JOIN e_image i ON i.id = iv.image_id
                  WHERE i.series_id = s.id AND i.role = 'poster'
                  ORDER BY iv.width LIMIT 1) AS poster_width
           FROM e_watch_status ws
           JOIN e_series s ON s.id = ws.series_id
          WHERE ws.user_id = $1
          ORDER BY ws.changed_at DESC`,
        [userId],
      );

      const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
      for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;

      return { rows, counts, total: rows.length };
    },

    /**
     * Поставить статус.
     *
     * Повторная отправка того же значения безопасна: операция «поставить»
     * идемпотентна, поэтому двойной клик и перезагрузка страницы не создают
     * двух строк (EC-T1).
     *
     * @param {object} args
     * @param {number} args.userId
     * @param {number} args.seriesId
     * @param {string} args.status
     * @returns {Promise<{ok: boolean, reason?: string, status?: string, subscribed?: boolean}>}
     */
    async set({ userId, seriesId, status }) {
      if (!STATUSES.includes(status)) return { ok: false, reason: 'unknown' };

      const visible = await visibleSeries(pool, seriesId);
      // Снятый с публикации сериал статус не меняет: сохранить можно было бы,
      // но человек не увидит результата и решит, что кнопка сломана (EC-T8).
      if (!visible || visible.archived) return { ok: false, reason: 'archived' };

      // `source` всегда `manual`: это нажатие кнопки, даже если человек
      // выбрал то же значение, что поставил бы код.
      await pool.query(
        `INSERT INTO e_watch_status (user_id, series_id, status, source)
         VALUES ($1, $2, $3, 'manual')
         ON CONFLICT (user_id, series_id) DO UPDATE
           SET status = EXCLUDED.status, source = 'manual', changed_at = now()`,
        [userId, seriesId, status],
      );

      const subscribed = SUBSCRIBED.has(status);
      await syncSubscriptionForStatus(pool, { userId, seriesId, enabled: subscribed });
      return { ok: true, status, subscribed };
    },

    /**
     * Убрать сериал из закладок, не трогая отметки серий.
     *
     * Отметки сохраняются на случай возврата (F-03-01 §18): человек убрал
     * сериал из списка, а через месяц вернулся — и не должен заново отмечать
     * всё подряд.
     *
     * @param {object} args
     * @param {number} args.userId
     * @param {number} args.seriesId
     * @returns {Promise<{ok: boolean}>}
     */
    async remove({ userId, seriesId }) {
      await pool.query('DELETE FROM e_watch_status WHERE user_id = $1 AND series_id = $2', [userId, seriesId]);
      await syncSubscriptionForStatus(pool, { userId, seriesId, enabled: false });
      return { ok: true };
    },
  };
}

/**
 * Подписка на выходы вслед за статусом (H-70).
 *
 * Экспортируется потому, что статус меняется не только кнопкой: первая отметка
 * серии тоже переводит его в «Смотрю» (`marks.js`), и там нужно то же правило,
 * а не его копия.
 *
 * Строка, созданная человеком вручную, не трогается: и ручное выключение, и
 * ручное включение переживают смену статуса (EC-T19).
 *
 * @param {pg.Pool} pool
 * @param {object} args
 * @param {number} args.userId
 * @param {number} args.seriesId
 * @param {boolean} args.enabled
 */
export async function syncSubscriptionForStatus(pool, { userId, seriesId, enabled }) {
  await pool.query(
    `INSERT INTO e_subscription (user_id, series_id, kind, source, enabled)
     VALUES ($1, $2, 'release', 'auto', $3)
     ON CONFLICT (user_id, series_id, kind) DO UPDATE
       SET enabled = EXCLUDED.enabled
       WHERE e_subscription.source = 'auto'`,
    [userId, seriesId, enabled],
  );
}

async function visibleSeries(pool, seriesId) {
  const { rows } = await pool.query(
    'SELECT id, archived_at FROM e_series WHERE id = $1 AND publication_state <> $2',
    [seriesId, 'imported'],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, archived: row.archived_at !== null };
}