// Пул подключений к PostgreSQL.
//
// Приложение работает под ролью st_app, а не владельцем схемы: именно
// от неё отозваны права писать в журнал аудита и удалять оценки (R-SQL-01,
// R-SQL-03). Если подключиться владельцем, проверки прав в базе перестают
// действовать, и защита держится только на слове «не делай».

import pg from 'pg';

const { Pool } = pg;

// `bigint` из базы приходит строкой, и это ломает код не сразу, а позже:
// идентификатор пользователя попадает в сессию, оттуда в журнал безопасности,
// где тип проверяется, — и запрос падает с 500 уже на записи в журнал. Разбор
// int8 ставится один раз здесь, чтобы любое хранилище получало числа.
//
// Числа теряют точность за 2^53 — для счётчиков и идентификаторов таблиц
// этого проекта предел недостижим, а `numeric` разбирается отдельно и остаётся
// строкой: деньги и точные доли строкой и должны приходить.
pg.types.setTypeParser(20, (value) => Number(value));

// `DATE` приходит объектом Date в местном часовом поясе машины, и дата выхода
// «12 октября» на машине в UTC+5 превращается в 11 октября. Даты выхода —
// это то, что человек видит в календаре, поэтому они разбираются в текст
// YYYY-MM-DD: дальше по коду они сравниваются со строками и форматируются
// в вью с указанным часовым поясом, а не машинным.
pg.types.setTypeParser(1082, (value) => value);

export function createPool({ database = process.env.PGDATABASE } = {}) {
  return new Pool({
    // `DATABASE_URL` сильнее переменных — так ведёт сам PostgreSQL, и
    // подмена базы при заданном адресе подключения означала бы, что команда
    // quietly работает не с той базой. Поэтому подмена живёт только там, где
    // подключение собирается из PG* (сборка демо-базы).
    connectionString: process.env.DATABASE_URL ?? undefined,
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER,
    database: process.env.DATABASE_URL ? process.env.PGDATABASE : database,
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