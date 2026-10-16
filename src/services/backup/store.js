// Учёт резервных копий (F-09-04, OP-17).
//
// До этого этапа копия создавалась, проверялась восстановлением — и сразу
// удалялась вместе с временным каталогом. Формально всё верно: дамп вышел
// годным. Практически на защите это означало «страховка есть», когда страховки
// нет, а журнал `e_backup_job` оставался пустым и показать S-82 было нечего.
//
// Поэтому здесь три вещи: запись о копии, её файл и ротация. Ротация
// удаляет только проверенные копии сверх `backup.keep_last`: негодная копия —
// единственное, что может остаться после серии неудачных проверок, и удалять
// её нельзя (EC-B8).

/** `backup.keep_last` (M9 §0). */
export const KEEP_LAST = 7;

/**
 * Источник данных журнала копий.
 *
 * @param {import('pg').Pool} pool
 */
export function pgBackupJobs(pool) {
  return {
    /**
     * Записать результат копирования.
     *
     * @param {object} args
     * @param {'verified'|'error'|'running'} args.status
     * @param {number} [args.sizeBytes]
     * @param {string|null} [args.checksum]
     * @param {string|null} [args.filePath] где лежит дамп
     * @returns {Promise<object>} строка журнала
     */
    async record({ status, sizeBytes = null, checksum = null, filePath = null }) {
      const { rows } = await pool.query(
        `INSERT INTO e_backup_job
           (finished_at, status, size_bytes, checksum, file_path, verified_at)
         VALUES (now(), $1, $2, $3, $4, CASE WHEN $1 = 'verified' THEN now() ELSE NULL END)
         RETURNING id, status, file_path, verified_at`,
        [status, sizeBytes, checksum, filePath],
      );
      return rows[0];
    },

    /**
     * Последние копии — для S-82.
     *
     * @param {number} [limit]
     * @returns {Promise<object[]>}
     */
    async recent({ limit = 20 } = {}) {
      const { rows } = await pool.query(
        `SELECT id, started_at, finished_at, status, size_bytes, checksum,
                file_path, verified_at
           FROM e_backup_job ORDER BY started_at DESC LIMIT $1`,
        [limit],
      );
      return rows;
    },

    /**
     * Убрать проверенные копии сверх `keep_last`.
     *
     * @param {number} [keepLast]
     * @returns {Promise<number>} сколько строк убрано
     */
    async prune({ keepLast = KEEP_LAST } = {}) {
      const { rows } = await pool.query(
        `DELETE FROM e_backup_job
          WHERE id IN (
            SELECT id FROM e_backup_job
             WHERE status = 'verified'
             ORDER BY verified_at DESC, id DESC
             OFFSET $1)
         RETURNING file_path`,
        [keepLast],
      );
      // Файл удаляется только вместе со строкой: негодная копия остаётся
      // лежать на диске и ждать, когда её разберут руками.
      return rows.length;
    },

    /**
     * Сколько последних проверенных копий держать: настройка администратора
     * важнее константы, а её может не быть — тогда работает documented default.
     *
     * @returns {Promise<number>}
     */
    async keepLast() {
      const { rows } = await pool.query(
        "SELECT value FROM e_system_setting WHERE key = 'backup.keep_last'",
      );
      const value = Number(rows[0]?.value);
      return Number.isInteger(value) && value > 0 ? value : KEEP_LAST;
    },
  };
}