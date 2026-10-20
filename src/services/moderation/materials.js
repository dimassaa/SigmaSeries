// «Мои материалы» (F-05-09, S-35).
//
// Автор должен видеть судьбу своих материалов: что опубликовано, что на
// проверке, что запрещено и почему. Текст материала в списке не показывается
// — список про состояния, а не про перечитывание своих слов (F-05-09 §7).
//
// Найденное модерацией слово автору не показывается ни здесь, ни в
// уведомлении: словарь не должен работать как оракул (R-MOD-12).

/** Состояния материала и подписи для человека. */
export const STATES = {
  published: 'published',
  approved: 'approved',
  checking: 'checking',
  flagged: 'flagged',
  rejected: 'rejected',
  hidden: 'hidden',
  deleted: 'deleted',
  draft: 'draft',
};

/**
 * Источник «Моих материалов».
 *
 * @param {import('pg').Pool} pool
 * @returns {object}
 */
export function pgMyMaterials(pool) {
  /**
   * Материалы пользователя: метаданные и состояние.
   *
   * @param {{userId: number, kind?: string|null, state?: string|null,
   *   page?: number, pageSize?: number}} input
   * @returns {Promise<{items: object[], total: number, page: number, pages: number,
   *   kinds: string[], states: string[]}>}
   */
  async function own({ userId, kind = null, state = null, page = 1, pageSize = 20 }) {
    const current = Math.max(1, Number(page) || 1);
    const size = Math.max(1, Number(pageSize) || 20);
    const params = [userId];
    const where = ['m.author_id = $1'];
    if (kind) {
      params.push(kind);
      where.push(`m.kind = $${params.length}`);
    }
    if (state) {
      params.push(state);
      where.push(`m.state = $${params.length}`);
    }

    const { rows: [tally] } = await pool.query(
      `SELECT count(*)::int AS total FROM e_material m WHERE ${where.join(' AND ')}`,
      params,
    );
    const total = Number(tally.total);
    const pages = Math.max(1, Math.ceil(total / size));

    const { rows } = await pool.query(
      `SELECT m.id, m.kind, m.state, m.series_id, m.created_at, m.submitted_at, m.decided_at,
              s.title_ru AS series_title, s.slug AS series_slug,
              (SELECT r.reason FROM e_editor_decision r
                WHERE r.material_id = m.id AND r.cancelled_at IS NULL
                ORDER BY r.decided_at DESC LIMIT 1) AS decision_reason
         FROM e_material m
         LEFT JOIN e_series s ON s.id = m.series_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.submitted_at DESC, m.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, size, (current - 1) * size],
    );

    const { rows: kinds } = await pool.query(
      'SELECT DISTINCT kind FROM e_material WHERE author_id = $1 ORDER BY kind',
      [userId],
    );
    const { rows: states } = await pool.query(
      'SELECT DISTINCT state FROM e_material WHERE author_id = $1 ORDER BY state',
      [userId],
    );

    return {
      items: rows.map((row) => ({
        id: Number(row.id),
        kind: row.kind,
        state: row.state,
        seriesId: row.series_id === null ? null : Number(row.series_id),
        seriesTitle: row.series_title,
        seriesSlug: row.series_slug,
        createdAt: row.created_at,
        submittedAt: row.submitted_at,
        decidedAt: row.decided_at,
        // Причина решения видна автору: «запрещён: спам» (F-05-09 §5).
        reason: row.decision_reason ?? null,
      })),
      total,
      page: current,
      pages,
      kinds: kinds.map((row) => row.kind),
      states: states.map((row) => row.state),
      applied: { kind, state },
    };
  }

  /**
   * Удалить свой материал — в любом состоянии, включая опубликованный и
   * ждущий проверки (F-05-09 §8а). Материал уходит из очереди, и решение
   * по нему не принимается.
   *
   * @param {{materialId: number, userId: number}} input
   * @returns {Promise<boolean>}
   */
  async function remove({ materialId, userId }) {
    const { rowCount } = await pool.query(
      `UPDATE e_material
          SET state = 'deleted', decided_at = now(),
              visible_body = NULL, visible_spoiler = FALSE
        WHERE id = $1 AND author_id = $2 AND state <> 'deleted'`,
      [materialId, userId],
    );
    return rowCount > 0;
  }

  return { own, remove };
}
