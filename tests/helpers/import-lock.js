// Взаимная блокировка проверок, которые зависят от общих строк запуска.
//
// Файлы прогоняются параллельно (node --test), а база у них одна. Проверки
// заморозки, блокировки и хранилища запусков по своей природе требуют, чтобы в
// `e_import_run` не было чужой строки `running`: иначе «идёт прогон импорта»
// видно чужой прогон и проверка падает без всякой связи с кодом.
//
// Блокировка — сессионная (`pg_advisory_lock`), поэтому она держится на своём
// соединении и отпускается, даже если файл упал посреди прогона.

/** Произвольное число; общее для всех файлов, которые берут блокировку. */
export const IMPORT_LOCK_ID = 8_120_007;

/**
 * Занимает блокировку до конца работы файла.
 *
 * @param {object} pool
 * @returns {Promise<() => Promise<void>>} функция отпускания; безопасна в `after`
 */
export async function acquireImportLock(pool) {
  const client = await pool.connect();
  await client.query('SELECT pg_advisory_lock($1)', [IMPORT_LOCK_ID]);
  return async () => {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [IMPORT_LOCK_ID]);
    } finally {
      client.release();
    }
  };
}