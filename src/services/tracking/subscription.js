// Подписки на выходы (F-03-07, H-70).
//
// Два правила, из-за которых файл и существует:
//
//  1. Решение человека и решение автоматики не смешиваются (EC-T19). Ручное
//     выключение переживает смену статуса, ручное включение — тоже. Поэтому
//     колокольчик всегда переписывает строку как `source = 'manual'`, а
//     автоматика (H-70, `status.js`) обновляет только строки `source = 'auto'`.
//     Пока в `ON CONFLICT` автоматики нет этого условия, отказаться от
//     уведомлений невозможно: «Смотрю» включит их обратно.
//  2. Подписка — это про то, о чём сообщать, а не про закладку. Поэтому
//     сериал, снятый с публикации, подписку не принимает (EC-T8): уведомление
//     о выходе серии несуществующего в каталоге сериала — шум.

import pg from 'pg';

/** Виды подписки. `announce` («сообщить, когда объявят дату») — P1, см. H-26. */
export const KINDS = ['release', 'announce'];

/** `subs.max_per_user` (M3 §0). */
export const MAX_PER_USER = 500;

/**
 * Источник данных подписок.
 *
 * @param {pg.Pool} pool
 */
export function pgSubscriptions(pool) {
  return {
    /**
     * Состояние подписки одного вида для одного сериала.
     *
     * @param {number|null} userId `null` у гостя — подписки у него нет
     * @param {number} seriesId
     * @param {string} [kind]
     * @returns {Promise<{kind: string, enabled: boolean, source: string}|null>}
     */
    async state(userId, seriesId, kind = 'release') {
      if (!userId) return null;

      const { rows } = await pool.query(
        `SELECT kind, source, enabled
           FROM e_subscription
          WHERE user_id = $1 AND series_id = $2 AND kind = $3`,
        [userId, seriesId, kind],
      );
      return rows[0] ?? null;
    },

    /**
     * Состояния подписок сразу по всем сериалам — для списка закладок.
     *
     * Один запрос на страницу: двадцать четыре карточки — это двадцать четыре
     * запроса, если читать по одному, а список открывают целиком и часто.
     * Сериалы без строки тоже попадают в ответ: карточке нужно знать, что
     * колокольчик выключен, а не молчать.
     *
     * @param {number} userId
     * @param {number[]} seriesIds
     * @param {string} [kind]
     * @returns {Promise<Map<number, {kind: string, enabled: boolean, source: string}>>}
     */
    async listOf(userId, seriesIds, kind = 'release') {
      const result = new Map();
      for (const seriesId of seriesIds) {
        result.set(seriesId, { kind, enabled: false, source: 'none' });
      }
      if (!userId || !seriesIds.length) return result;

      const { rows } = await pool.query(
        `SELECT series_id, kind, source, enabled
           FROM e_subscription
          WHERE user_id = $1 AND series_id = ANY($2::bigint[]) AND kind = $3`,
        [userId, seriesIds, kind],
      );
      for (const row of rows) {
        result.set(row.series_id, { kind: row.kind, source: row.source, enabled: row.enabled });
      }
      return result;
    },

    /**
     * Включить или выключить подписку вручную.
     *
     * Операция «поставить» и «снять», а не «переключить»: двойной клик и
     * повтор с двух устройств не должны включать то, что человек выключил
     * (EC-T1, EC-T18).
     *
     * @param {object} args
     * @param {number} args.userId
     * @param {number} args.seriesId
     * @param {boolean} args.on
     * @param {string} [args.kind]
     * @returns {Promise<{ok: boolean, reason?: string, enabled?: boolean, source?: string}>}
     */
    async toggle({ userId, seriesId, on, kind = 'release' }) {
      if (!KINDS.includes(kind)) return { ok: false, reason: 'unknown-kind' };

      const series = await seriesState(pool, seriesId);
      if (!series) return { ok: false, reason: 'missing' };
      // Снятый с публикации сериал: сохранить подписку можно было бы, но
      // уведомлений всё равно не будет (EC-T8), и человек решит, что кнопка
      // сломалась.
      if (series.archived) return { ok: false, reason: 'archived' };

      const current = await this.state(userId, seriesId, kind);
      // Уже включено: повтор ничего не меняет и не должен упираться в потолок —
      // эта подписка уже учтена в нём.
      if (current?.enabled === on) {
        return { ok: true, enabled: on, source: current.source };
      }

      if (on) {
        const { rows: [row] } = await pool.query(
          'SELECT count(*)::int AS n FROM e_subscription WHERE user_id = $1 AND enabled',
          [userId],
        );
        if (row.n >= MAX_PER_USER) return { ok: false, reason: 'limit' };
      }

      await pool.query(
        `INSERT INTO e_subscription (user_id, series_id, kind, source, enabled)
         VALUES ($1, $2, $3, 'manual', $4)
         ON CONFLICT (user_id, series_id, kind) DO UPDATE
           SET enabled = EXCLUDED.enabled, source = 'manual'`,
        [userId, seriesId, kind, on],
      );
      return { ok: true, enabled: on, source: 'manual' };
    },

    /**
     * Получатели уведомлений по сериалам — для задачи F-03-08.
     *
     * Снятые с публикации сериалы отбрасываются здесь, а не в задаче: уведомление
     * о выходе серии сериала, которого нет в каталоге, — это шум, и человек
     * ничего не может с ним сделать (EC-T8).
     *
     * @param {number[]} seriesIds
     * @param {string} [kind]
     * @returns {Promise<{userId: number, seriesId: number}[]>}
     */
    async recipientsOf(seriesIds, kind = 'release') {
      if (!seriesIds.length) return [];

      const { rows } = await pool.query(
        `SELECT sub.user_id, sub.series_id
           FROM e_subscription sub
           JOIN e_series s ON s.id = sub.series_id
          WHERE sub.series_id = ANY($1::bigint[])
            AND sub.kind = $2 AND sub.enabled
            AND s.publication_state = 'published' AND s.archived_at IS NULL
          ORDER BY sub.series_id, sub.user_id`,
        [seriesIds, kind],
      );
      return rows.map((row) => ({ userId: row.user_id, seriesId: row.series_id }));
    },
  };
}

/**
 * Состояние сериала в смысле каталога.
 *
 * `publication_state = 'imported'` — это не «сериал есть, но его не видно»,
 * а «сериал ещё не опубликован»: для зрителя он не существует вовсе.
 *
 * @param {pg.Pool} pool
 * @param {number} seriesId
 */
async function seriesState(pool, seriesId) {
  const { rows } = await pool.query(
    `SELECT id, archived_at FROM e_series
      WHERE id = $1 AND publication_state <> 'imported'`,
    [seriesId],
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, archived: row.archived_at !== null };
}
