// Массовые операции над каталогом (F-10-11).
//
// Одно действие сразу у многих карточек. Часть карточек может не подойти —
// публиковать без минимума нельзя, — и такие пропускаются с причиной, а
// остальные выполняются (EC-S15).
//
// Одна запись аудита на операцию и версия у каждой затронутой карточки:
// журнал должен показать, что сделал админ, а не засорён деталями.
//
// Прогресс пишется после каждой карточки в отдельной транзакции. Одна общая
// транзакция сделала бы прогресс невидимым до конца и откатила бы уже
// выполненные карточки из-за одной ошибки — это противоречит EC-S15.

import { pgStudioCard, EDITABLE_FIELDS } from './card.js';
import { REASON_CLASSES } from './catalogue.js';

/** Сколько карточек можно взять за одну операцию (F-10-11 §8). */
export const MAX_BULK = 200;

/** Действия, которые знает студия. */
export const BULK_ACTIONS = [
  'publish', 'archive', 'add_genre', 'remove_genre', 'lock', 'unlock', 'accept_reason',
];

/** Причины неполноты, которые можно принять как есть (H-47). */
export const BULK_REASONS = Object.keys(REASON_CLASSES);

/**
 * Карточка сериала из базы: то, о чём решает действие.
 *
 * @typedef {object} BulkSeriesRow
 * @property {number} id
 * @property {string} slug
 * @property {string|null} title_ru
 * @property {string|null} title_original
 * @property {string} publication_state
 * @property {string|null} level
 * @property {string[]} reasons причины, по которым карточка ждёт решения
 * @property {number} genres число жанров карточки
 * @property {number|null} year_start год начала
 * @property {string[]} locked_fields заблокированные от импорта поля
 * @property {boolean} has_genre есть ли у карточки выбранный жанр
 */

/**
 * Карточка, которую действие пропустило.
 *
 * @typedef {object} BulkSkipped
 * @property {number} id
 * @property {string|null} title
 * @property {string} reason
 */

/**
 * Карточка из первых пяти, которые действие тронет.
 *
 * @typedef {object} BulkSample
 * @property {number} id
 * @property {string|null} title
 */

/**
 * Массовые операции.
 *
 * @param {import('pg').Pool} pool
 */
export function pgBulkOperations(pool) {
  const card = pgStudioCard(pool);

  /**
   * Что изменится, если выполнить действие.
   *
   * @param {{action: string, ids?: number[], genre?: string|null,
   *   reason?: string|null, field?: string|null}} input
   * @returns {Promise<{ok: false, reason: string}
   *   | {ok: true, affected: number, skipped: BulkSkipped[], sample: BulkSample[],
   *      total: number, ids: number[]}>}
   */
  async function preview({
    action, ids = [], genre = null, reason = null, field = null,
  }) {
    if (!BULK_ACTIONS.includes(action)) return { ok: false, reason: 'action' };
    const list = [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!list.length) return { ok: false, reason: 'empty' };
    if (list.length > MAX_BULK) return { ok: false, reason: 'too_many' };

    if (action === 'add_genre' || action === 'remove_genre') {
      if (!genre) return { ok: false, reason: 'no_genre_code' };
      const { rows } = await pool.query(
        'SELECT 1 FROM e_genre WHERE code = $1 AND active AND is_raw = FALSE',
        [genre],
      );
      if (!rows.length) return { ok: false, reason: 'bad_genre' };
    }
    if (action === 'accept_reason') {
      if (!reason) return { ok: false, reason: 'no_reason' };
      if (!BULK_REASONS.includes(reason)) return { ok: false, reason: 'bad_reason' };
    }
    if (action === 'lock' || action === 'unlock') {
      if (!field) return { ok: false, reason: 'no_field' };
      if (!EDITABLE_FIELDS.includes(field)) return { ok: false, reason: 'bad_field' };
    }

    const { rows } = await pool.query(
      `SELECT id, slug, title_ru, title_original, year_start, publication_state, level, reasons,
              (SELECT count(*)::int FROM e_series_genre sg WHERE sg.series_id = s.id) AS genres,
              (SELECT coalesce(array_agg(field), '{}') FROM e_field_lock
                WHERE series_id = s.id) AS locked_fields,
              EXISTS (SELECT 1 FROM e_series_genre sg
                       WHERE sg.series_id = s.id AND sg.genre_code = $2) AS has_genre
         FROM e_series s WHERE id = ANY($1::bigint[])`,
      [list, genre],
    );

    const skipped = [];
    const sample = [];
    let affected = 0;
    const found = new Set(rows.map((row) => Number(row.id)));
    for (const row of rows) {
      const problem = problemOf(action, row, { genre, reason, field });
      if (problem) {
        skipped.push({ id: Number(row.id), title: row.title_ru || row.title_original, reason: problem });
      } else {
        affected += 1;
        if (sample.length < 5) {
          sample.push({ id: Number(row.id), title: row.title_ru || row.title_original });
        }
      }
    }
    for (const id of list) {
      if (!found.has(id)) skipped.push({ id, title: null, reason: 'not_found' });
    }
    return {
      ok: true,
      affected,
      skipped,
      sample,
      total: list.length,
      ids: list,
    };
  }

  /**
   * Запустить действие над выбранными карточками.
   *
   * Работа идёт в фоне: карточек до двухсот, и ждать их в ответе незачем. Задание
   * записывается в `e_bulk_job`, его состояние видно в студии, а отчёт — по
   * каждому элементу (F-10-11 §4).
   *
   * @param {{action: string, ids?: number[], genre?: string|null,
   *   reason?: string|null, field?: string|null, byId?: number|null}} input
   * @returns {Promise<any>} задание
   */
  async function start({
    action, ids = [], genre = null, reason = null, field = null, byId = null,
  }) {
    const plan = await preview({ action, ids, genre, reason, field });
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
          field,
        }),
      ],
    );

    // Фоновая работа: ответ странице ждать её не нужно.
    const work = execute(job.id, {
      action, genre, reason, field, ids: plan.ids, byId,
    }).catch((error) => {
      console.error(`[массовая операция] ${error.message}`);
    });

    return {
      ok: true,
      jobId: Number(job.id),
      affected: plan.affected,
      total: plan.total,
      skipped: plan.skipped,
      work,
    };
  }

  /**
   * Выполнить задание.
   *
   * @param {number} jobId
   * @param {{action: string, genre: string|null, reason: string|null,
   *   field: string|null, ids?: number[], byId?: number|null}} input
   * @returns {Promise<any>}
   */
  async function execute(jobId, {
    action, genre, reason, field, ids = [], byId = null,
  }) {
    const result = [];
    let done = 0;
    let failed = 0;

    for (const id of ids) {
      const client = await pool.connect();
      let title = null;
      try {
        await client.query('BEGIN');
        const { rows: [row] } = await client.query(
          `SELECT id, slug, title_ru, title_original, year_start, publication_state, level, reasons,
                  (SELECT count(*)::int FROM e_series_genre sg WHERE sg.series_id = s.id) AS genres,
                  (SELECT coalesce(array_agg(field), '{}') FROM e_field_lock
                    WHERE series_id = s.id) AS locked_fields,
                  EXISTS (SELECT 1 FROM e_series_genre sg
                           WHERE sg.series_id = s.id AND sg.genre_code = $2) AS has_genre
             FROM e_series s WHERE id = $1 FOR UPDATE`,
          [id, genre],
        );
        if (!row) {
          result.push({ id, title: null, reason: 'not_found' });
          failed += 1;
        } else {
          title = row.title_ru || row.title_original;
          const problem = problemOf(action, row, { genre, reason, field });
          if (problem) {
            result.push({ id: Number(row.id), title, reason: problem });
            failed += 1;
          } else {
            await applyOne(client, action, row, {
              genre, reason, field, byId,
              recompute: (seriesId) => card.recompute(seriesId, client),
            });
            result.push({ id: Number(row.id), title, ok: true });
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        result.push({ id, title, reason: 'error' });
        failed += 1;
        console.error(`[массовая операция] карточка ${id}: ${error.message}`);
      } finally {
        client.release();
      }
      done += 1;
      // Прогресс виден в студии, пока идёт работа: каждая карточка уже
      // зафиксирована отдельной транзакцией.
      await pool.query(
        'UPDATE e_bulk_job SET done = $2, failed = $3, result = $4 WHERE id = $1',
        [jobId, done, failed, JSON.stringify(result)],
      );
    }

    const state = failed ? (failed === ids.length ? 'failed' : 'partial') : 'done';
    await pool.query(
      `UPDATE e_bulk_job
          SET state = $2, done = $3, failed = $4, result = $5, finished_at = now()
        WHERE id = $1`,
      [jobId, state, done, failed, JSON.stringify(result)],
    );
    return { ok: true, done, failed };
  }

  /**
   * Последние задания — их видно в студии.
   *
   * @param {number} [limit]
   * @returns {Promise<any[]>}
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

  /**
   * Одно задание с отчётом по каждому элементу.
   *
   * @param {number} id
   * @returns {Promise<any|null>}
   */
  async function job(id) {
    const { rows: [row] } = await pool.query(
      `SELECT id, action, total, done, failed, state, params, result, at, finished_at
         FROM e_bulk_job WHERE id = $1`,
      [id],
    );
    if (!row) return null;
    return {
      id: Number(row.id),
      action: row.action,
      total: Number(row.total),
      done: Number(row.done),
      failed: Number(row.failed),
      state: row.state,
      params: row.params ?? {},
      result: Array.isArray(row.result) ? row.result : [],
      at: row.at,
      finishedAt: row.finished_at,
    };
  }

  return { preview, start, execute, jobs, job };
}

/**
 * Почему действие не подходит этой карточке.
 *
 * @param {string} action
 * @param {BulkSeriesRow} row
 * @param {{genre: string|null, reason: string|null, field: string|null}} extra
 * @returns {string|null}
 */
function problemOf(action, row, { genre, reason, field }) {
  if (action === 'publish') {
    if (row.publication_state === 'published') return 'already_published';
    if (row.publication_state === 'archived') return 'archived';
    if (!row.title_ru && !row.title_original) return 'no_title';
    if (!row.year_start) return 'no_year';
    if (!(row.genres > 0)) return 'no_genre';
    return null;
  }
  if (action === 'archive') {
    if (row.publication_state === 'archived') return 'already_archived';
    return null;
  }
  if (action === 'add_genre') {
    if (!genre) return 'no_genre_code';
    if (row.has_genre) return 'already_has_genre';
    return null;
  }
  if (action === 'remove_genre') {
    if (!genre) return 'no_genre_code';
    if (!row.has_genre) return 'no_such_genre';
    return null;
  }
  if (action === 'lock') {
    if (!field) return 'no_field';
    if ((row.locked_fields ?? []).includes(field)) return 'already_locked';
    return null;
  }
  if (action === 'unlock') {
    if (!field) return 'no_field';
    if (!(row.locked_fields ?? []).includes(field)) return 'not_locked';
    return null;
  }
  if (action === 'accept_reason') {
    if (!reason) return 'no_reason';
    if (!(row.reasons ?? []).includes(reason)) return 'no_such_reason';
    return null;
  }
  return 'unknown';
}

/**
 * Применить действие к одной карточке.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} action
 * @param {BulkSeriesRow} row
 * @param {{genre: string|null, reason: string|null, field: string|null,
 *   byId?: number|null, recompute: (id: number) => Promise<void>}} extra
 * @returns {Promise<void>}
 */
async function applyOne(client, action, row, {
  genre, reason, field, byId = null, recompute,
}) {
  if (action === 'publish') {
    await client.query(
      `UPDATE e_series SET publication_state = 'published' WHERE id = $1`,
      [row.id],
    );
    await bumpVersion(client, row.id, byId, {
      publication_state: { from: row.publication_state, to: 'published' },
    });
    return;
  }
  if (action === 'archive') {
    await client.query(
      `UPDATE e_series
          SET publication_state = 'archived', archived_at = now()
        WHERE id = $1`,
      [row.id],
    );
    await client.query('UPDATE e_banner SET active = FALSE WHERE series_id = $1', [row.id]);
    await bumpVersion(client, row.id, byId, {
      publication_state: { from: row.publication_state, to: 'archived' },
    });
    return;
  }
  if (action === 'add_genre') {
    await client.query(
      `INSERT INTO e_series_genre (series_id, genre_code) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [row.id, genre],
    );
    await recompute(row.id);
    await bumpVersion(client, row.id, byId, { genres: { add: genre } });
    return;
  }
  if (action === 'remove_genre') {
    await client.query(
      'DELETE FROM e_series_genre WHERE series_id = $1 AND genre_code = $2',
      [row.id, genre],
    );
    await recompute(row.id);
    await bumpVersion(client, row.id, byId, { genres: { remove: genre } });
    return;
  }
  if (action === 'lock') {
    await client.query(
      `INSERT INTO e_field_lock (series_id, field, set_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (series_id, field)
       DO UPDATE SET set_by = EXCLUDED.set_by, set_at = now()`,
      [row.id, field, byId],
    );
    await bumpVersion(client, row.id, byId, { field_lock: { field, to: true } });
    return;
  }
  if (action === 'unlock') {
    await client.query(
      'DELETE FROM e_field_lock WHERE series_id = $1 AND field = $2',
      [row.id, field],
    );
    await bumpVersion(client, row.id, byId, { field_lock: { field, to: false } });
    return;
  }
  if (action === 'accept_reason') {
    // Принятая причина снимается: карточка перестаёт ждать решения.
    // Пересчёт полноты здесь не запускается: иначе причина вернулась бы сразу.
    await client.query(
      `UPDATE e_series SET reasons = array_remove(reasons, $2) WHERE id = $1`,
      [row.id, reason],
    );
    await bumpVersion(client, row.id, byId, { reasons: { accepted: reason } });
  }
}

/**
 * Новая версия карточки и запись в историю.
 *
 * @param {import('pg').PoolClient} client
 * @param {number} seriesId
 * @param {number|null} byId
 * @param {object} diff
 * @returns {Promise<void>}
 */
async function bumpVersion(client, seriesId, byId, diff) {
  const { rows: [row] } = await client.query(
    'UPDATE e_series SET version = version + 1 WHERE id = $1 RETURNING version',
    [seriesId],
  );
  if (!row) throw new Error('Сериал исчез при массовой операции');
  await client.query(
    `INSERT INTO e_catalog_version (series_id, version, author_id, source, diff)
     VALUES ($1, $2, $3, 'manual', $4)`,
    [seriesId, row.version, byId, JSON.stringify(diff)],
  );
}
