// Массовые операции над каталогом (F-10-11).
//
// Одно действие сразу у многих карточек. Часть карточек может не подойти —
// публиковать без минимума нельзя, — и такие пропускаются с причиной, а
// остальные выполняются (EC-S15).
//
// Одна запись аудита на операцию и версия у каждой затронутой карточки:
// журнал должен показать, что сделал админ, а не засорён деталями.

/** Сколько карточек можно взять за одну операцию (F-10-11 §8). */
export const MAX_BULK = 200;

/** Действия, которые знает студия. */
export const BULK_ACTIONS = ['publish', 'archive', 'add_genre', 'remove_genre', 'accept_reason'];

/**
 * Массовые операции.
 *
 * @param {import('pg').Pool} pool
 */
export function pgBulkOperations(pool) {
  /**
   * Что изменится, если выполнить действие.
   *
   * @param {object} input
   * @returns {Promise<{ok: boolean, reason?: string, affected: number, skipped: object[], sample: object[]}>}
   */
  async function preview({ action, ids = [], genre = null, reason = null }) {
    if (!BULK_ACTIONS.includes(action)) return { ok: false, reason: 'action' };
    const list = [...new Set(ids.map(Number).filter(Number.isInteger))];
    if (!list.length) return { ok: false, reason: 'empty' };
    if (list.length > MAX_BULK) return { ok: false, reason: 'too_many' };

    const { rows } = await pool.query(
      `SELECT id, slug, title_ru, title_original, publication_state, level, reasons,
              (SELECT count(*)::int FROM e_series_genre sg WHERE sg.series_id = s.id) AS genres
         FROM e_series s WHERE id = ANY($1::bigint[])`,
      [list],
    );

    const skipped = [];
    const sample = [];
    for (const row of rows) {
      const problem = problemOf(action, row, { genre, reason });
      if (problem) {
        skipped.push({ id: Number(row.id), title: row.title_ru || row.title_original, reason: problem });
      } else if (sample.length < 5) {
        sample.push({ id: Number(row.id), title: row.title_ru || row.title_original });
      }
    }
    return {
      ok: true,
      affected: rows.length - skipped.length,
      skipped,
      sample,
      total: rows.length,
      ids: rows.map((row) => Number(row.id)),
    };
  }

  /**
   * Выполнить действие над выбранными карточками.
   *
   * @param {object} input
   * @returns {Promise<object>}
   */
  async function run({ action, ids = [], genre = null, reason = null, byId = null }) {
    const plan = await preview({ action, ids, genre, reason });
    if (!plan.ok) return plan;

    const client = await pool.connect();
    const done = [];
    const skipped = [];
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT id, slug, title_ru, title_original, publication_state, level, reasons,'
        + ' (SELECT count(*)::int FROM e_series_genre sg WHERE sg.series_id = s.id) AS genres'
        + ' FROM e_series s WHERE id = ANY($1::bigint[]) FOR UPDATE',
        [[...new Set(ids.map(Number).filter(Number.isInteger))]],
      );

      for (const row of rows) {
        const problem = problemOf(action, row, { genre, reason });
        if (problem) {
          skipped.push({ id: Number(row.id), title: row.title_ru || row.title_original, reason: problem });
          continue;
        }
        await applyOne(client, action, row, { genre, reason });
        done.push(Number(row.id));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { ok: true, affected: done.length, skipped, total: done.length + skipped.length };
  }

  return { preview, run };
}

/**
 * Почему действие не подходит этой карточке.
 *
 * @param {string} action
 * @param {object} row
 * @param {{genre: string|null, reason: string|null}} extra
 * @returns {string|null}
 */
function problemOf(action, row, { genre, reason }) {
  if (action === 'publish') {
    const reasons = row.reasons ?? [];
    if (row.publication_state === 'published') return 'already_published';
    if (reasons.includes('no_genre')) return 'no_genre';
    if (reasons.includes('no_tmdb') || reasons.includes('pair_doubt')) return 'no_pair';
    if (!row.title_ru && !row.title_original) return 'no_title';
    return null;
  }
  if (action === 'archive') {
    if (row.publication_state === 'archived') return 'already_archived';
    return null;
  }
  if (action === 'add_genre') {
    if (!genre) return 'no_genre_code';
    return null;
  }
  if (action === 'remove_genre') {
    if (!genre) return 'no_genre_code';
    if (!row.genres) return 'no_genres';
    return null;
  }
  if (action === 'accept_reason') {
    if (!reason) return 'no_reason';
    return null;
  }
  return 'unknown';
}

/**
 * Применить действие к одной карточке.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} action
 * @param {object} row
 * @param {{genre: string|null, reason: string|null}} extra
 * @returns {Promise<void>}
 */
async function applyOne(client, action, row, { genre, reason }) {
  if (action === 'publish') {
    await client.query(
      `UPDATE e_series SET publication_state = 'published', version = version + 1 WHERE id = $1`,
      [row.id],
    );
    return;
  }
  if (action === 'archive') {
    await client.query(
      `UPDATE e_series
          SET publication_state = 'archived', archived_at = now(), version = version + 1
        WHERE id = $1`,
      [row.id],
    );
    await client.query('UPDATE e_banner SET active = FALSE WHERE series_id = $1', [row.id]);
    return;
  }
  if (action === 'add_genre') {
    await client.query(
      `INSERT INTO e_series_genre (series_id, genre_code) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [row.id, genre],
    );
    await client.query('UPDATE e_series SET version = version + 1 WHERE id = $1', [row.id]);
    return;
  }
  if (action === 'remove_genre') {
    await client.query(
      'DELETE FROM e_series_genre WHERE series_id = $1 AND genre_code = $2',
      [row.id, genre],
    );
    await client.query('UPDATE e_series SET version = version + 1 WHERE id = $1', [row.id]);
    return;
  }
  if (action === 'accept_reason') {
    // Принятая причина снимается: карточка перестаёт ждать решения.
    await client.query(
      `UPDATE e_series
          SET reasons = array_remove(reasons, $2), version = version + 1
        WHERE id = $1`,
      [row.id, reason],
    );
  }
}
