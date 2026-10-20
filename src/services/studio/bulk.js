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
   * Запустить действие над выбранными карточками.
   *
   * Работа идёт в фоне: карточек до двухсот, и ждать их в ответе незачем. Задание
   * записывается в `e_bulk_job`, его состояние видно в студии, а отчёт — по
   * каждому элементу (F-10-11 §4).
   *
   * @param {object} input
   * @returns {Promise<object>} задание
   */
  async function start({ action, ids = [], genre = null, reason = null, byId = null }) {
    const plan = await preview({ action, ids, genre, reason });
    if (!plan.ok) return plan;

    const { rows: [job] } = await pool.query(
      `INSERT INTO e_bulk_job (action, actor_id, total, state, params)
       VALUES ($1, $2, $3, 'running', $4) RETURNING id`,
      [
        action,
        byId,
        plan.total,
        JSON.stringify({
          ids: plan.ids,
          genre,
          reason,
          skipped: plan.skipped,
        }),
      ],
    );

    // Фоновая работа: ответ странице ждать её не нужно.
    const work = execute(job.id, { action, genre, reason, skipped: plan.skipped, total: plan.total })
      .catch((error) => {
        console.error(`[массовая операция] ${error.message}`);
      });

    return { ok: true, jobId: Number(job.id), affected: plan.affected, skipped: plan.skipped, work };
  }

  /**
   * Выполнить задание.
   *
   * @param {number} jobId
   * @param {object} input
   * @returns {Promise<object>}
   */
  async function execute(jobId, { action, genre, reason, skipped = [], total = 0 }) {
    const client = await pool.connect();
    const result = [];
    let done = 0;
    try {
      await client.query('BEGIN');
      // Список карточек — в задании: между прогнозом и выполнением его могли
      // изменить, и молча работать над другим списком нельзя.
      const { rows: plan } = await client.query('SELECT params FROM e_bulk_job WHERE id = $1', [jobId]);
      const ids = plan[0]?.params?.ids ?? [];
      const { rows: targets } = await client.query(
        'SELECT id, slug, title_ru, title_original, publication_state, level, reasons,'
        + ' (SELECT count(*)::int FROM e_series_genre sg WHERE sg.series_id = s.id) AS genres'
        + ' FROM e_series s WHERE id = ANY($1::bigint[]) FOR UPDATE',
        [ids],
      );

      for (const row of targets) {
        const problem = problemOf(action, row, { genre, reason });
        if (problem) {
          result.push({ id: Number(row.id), title: row.title_ru || row.title_original, reason: problem });
        } else {
          await applyOne(client, action, row, { genre, reason });
          result.push({ id: Number(row.id), title: row.title_ru || row.title_original, ok: true });
        }
        done += 1;
        // Прогресс виден в студии, пока идёт работа.
        await client.query(
          'UPDATE e_bulk_job SET done = $2, result = $3 WHERE id = $1',
          [jobId, done, JSON.stringify(result)],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      await pool.query(
        `UPDATE e_bulk_job SET state = 'failed', finished_at = now() WHERE id = $1`,
        [jobId],
      );
      throw error;
    } finally {
      client.release();
    }

    const failed = result.filter((item) => !item.ok).length;
    await pool.query(
      `UPDATE e_bulk_job
          SET state = $2, done = $3, failed = $4, result = $5, finished_at = now()
        WHERE id = $1`,
      [jobId, failed ? 'partial' : 'done', done, failed, JSON.stringify(result)],
    );
    return { ok: true, done, failed };
  }

  /**
   * Последние задания — их видно в студии.
   *
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async function jobs(limit = 10) {
    const { rows } = await pool.query(
      `SELECT j.id, j.action, j.total, j.done, j.failed, j.state, j.at, j.finished_at
         FROM e_bulk_job j
        ORDER BY j.at DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      action: row.action,
      total: Number(row.total),
      done: Number(row.done),
      failed: Number(row.failed),
      state: row.state,
      at: row.at,
      finishedAt: row.finished_at,
    }));
  }

  return { preview, start, execute, jobs };
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
