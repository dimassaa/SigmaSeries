// Запись результатов прогона импорта (F-12-01 §4, §17; F-12-09).
//
// Позиция перезаписывается, а не падает: повторный запуск после сбоя обязан
// довести начатое до конца, и уникальность по (run_id, tconst) для этого
// превращается в ON CONFLICT, а не в ошибку.

/** Колонки позиции — в том же порядке, что и значения в `saveChunk`. */
const COLUMNS = [
  'tconst',
  'tmdb_id',
  'stage',
  'outcome',
  'reasons',
  'http_codes',
  'attempts',
  'popularity_rank',
  'num_votes',
  'average_rating',
];

/** Сколько позиций уходит в одну вставку. */
const CHUNK = 500;

/**
 * Одна вставка пачки позиций.
 *
 * @param {object} pool
 * @param {number} runId
 * @param {object[]} items
 * @returns {Promise<number>}
 */
async function saveChunk(pool, runId, items) {
  const params = [runId];
  const tuples = items.map((item, index) => {
    const values = [
      item.tconst,
      item.tmdbId ?? null,
      item.stage,
      item.outcome,
      item.reasons ?? [],
      item.httpCodes ?? [],
      item.attempts ?? 0,
      item.rank ?? null,
      item.numVotes ?? null,
      item.averageRating ?? null,
    ];
    for (const value of values) params.push(value);
    const first = index * COLUMNS.length + 2;
    // $1 — это прогон, он общий для всей пачки, поэтому повторяется в каждом
    // кортеже, а не выносится в VALUES.
    const placeholders = ['$1', ...Array.from({ length: COLUMNS.length }, (_, i) => `$${first + i}`)];
    return `(${placeholders.join(', ')})`;
  });

  await pool.query(
    `INSERT INTO e_import_item_result (run_id, ${COLUMNS.join(', ')})
     VALUES ${tuples.join(', ')}
     ON CONFLICT (run_id, tconst) DO UPDATE SET
       tmdb_id = EXCLUDED.tmdb_id,
       stage = EXCLUDED.stage,
       outcome = EXCLUDED.outcome,
       reasons = EXCLUDED.reasons,
       http_codes = EXCLUDED.http_codes,
       attempts = EXCLUDED.attempts,
       popularity_rank = EXCLUDED.popularity_rank,
       num_votes = EXCLUDED.num_votes,
       average_rating = EXCLUDED.average_rating,
       updated_at = now()`,
    params,
  );
  return items.length;
}

/**
 * Хранилище результатов импорта.
 *
 * @param {object} pool подключение к базе
 * @returns {{startRun: Function, saveItems: Function, finishRun: Function}}
 */
export function createImportStore(pool) {
  return {
    /**
     * Открывает прогон.
     *
     * @param {'schedule_sync'|'discover_sync'|'ratings_sync'|'full_run'} kind
     * @param {{dryRun?: boolean}} [options]
     * @returns {Promise<number>} идентификатор прогона
     */
    async startRun(kind, { dryRun = false } = {}) {
      const { rows } = await pool.query(
        'INSERT INTO e_import_run (kind, dry_run) VALUES ($1, $2) RETURNING id',
        [kind, dryRun],
      );
      return rows[0].id;
    },

    /**
     * Пишет позиции прогона.
     *
     * @param {number} runId
     * @param {object[]} items
     * @param {string} items.tconst
     * @param {string} items.stage
     * @param {string} items.outcome
     * @param {number|null} [items.tmdbId]
     * @param {number} [items.rank]
     * @param {number} [items.numVotes]
     * @param {number} [items.averageRating]
     * @param {string[]} [items.reasons]
     * @param {number[]} [items.httpCodes]
     * @param {number} [items.attempts]
     * @returns {Promise<number>} сколько позиций записано
     */
    async saveItems(runId, items) {
      if (!items.length) return 0;

      // Пачками по 500: параметров у PostgreSQL 65 535, и при top_n больше
      // шести тысяч одна вставка упёрлась бы в потолок. К тому же оборванная
      // передача не должна стоить уже записанного.
      let written = 0;
      for (let from = 0; from < items.length; from += CHUNK) {
        written += await saveChunk(pool, runId, items.slice(from, from + CHUNK));
      }
      return written;
    },

    /**
     * Закрывает прогон.
     *
     * @param {number} runId
     * @param {'success'|'partial'|'error'} status
     * @returns {Promise<void>}
     */
    async finishRun(runId, status) {
      await pool.query(
        'UPDATE e_import_run SET status = $2, finished_at = now() WHERE id = $1',
        [runId, status],
      );
    },
  };
}