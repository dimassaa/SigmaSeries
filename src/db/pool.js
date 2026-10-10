// Пул подключений к PostgreSQL.
//
// Приложение работает под ролью st_app, а не владельцем схемы: именно
// от неё отозваны права писать в журнал аудита и удалять оценки (R-SQL-01,
// R-SQL-03). Если подключиться владельцем, проверки прав в базе перестают
// действовать, и защита держится только на слове «не делай».

import pg from 'pg';

const { Pool } = pg;

export function createPool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL ?? undefined,
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER,
    database: process.env.PGDATABASE,
    max: 10,
    idleTimeoutMillis: 30_000,
    // Пул живёт дольше процесса между запросами при перезапуске воркера,
    // и «idle in transaction» держит снимок схемы, блокируя миграции.
    idle_in_transaction_session_timeout: 10_000,
    application_name: 'sigmaseries',
  });
}

/** Проверка соединения при старте: понятная ошибка вместо 500 на первом запросе. */
export async function checkConnection(pool) {
  try {
    await pool.query('select 1');
    return true;
  } catch (e) {
    throw new Error(
      `Нет соединения с PostgreSQL: ${e.message}. ` +
      'Проверьте PGHOST, PGUSER, PGDATABASE и применена ли схема db/schema.sql.',
    );
  }
}