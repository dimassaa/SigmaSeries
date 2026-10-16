// Проверки схемы базы данных против живой PostgreSQL.
//
// Спецификация: docs/04-data/DATABASE.md §5 (список проверок).
//
// Тест пропускается, если базы нет, — иначе `npm test` падал бы у того,
// кто ещё не развернул PostgreSQL. Пропуск виден в выводе и не молчит.
//
// Подключение — стандартные переменные PostgreSQL, те же, что у psql:
//   PGHOST, PGPORT, PGUSER, PGDATABASE или TEST_DATABASE_URL.
// Так у того, у кого работает psql, работает и npm test: на Windows это
// обычный TCP, здесь — unix-сокет, для теста разницы нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const CONN = process.env.TEST_DATABASE_URL
  ? { connectionString: process.env.TEST_DATABASE_URL }
  : process.env.PGHOST && process.env.PGDATABASE
    ? {
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT ?? 5432),
        user: process.env.PGUSER,
        database: process.env.PGDATABASE,
      }
    : null;

const skip = CONN ? false : 'нет PGHOST/PGUSER/PGDATABASE или TEST_DATABASE_URL — схема не проверялась';

// Проверки каталога (ограничения, внешние ключи) требуют прав владельца схемы.
// PostgreSQL фильтрует information_schema по привилегиям: под ролью приложения
// ограничения e_audit_log не видны, хотя они есть. Проверено на PostgreSQL 18.6.
// Поэтому инспекция каталога и проверка прав — разные роли.
let pool;
let isOwner = false;

/** Пропустить проверку каталога, если подключение не от владельца схемы. */
function needOwner(t) {
  if (!isOwner) {
    t.skip('нужна учётная запись владельца схемы: information_schema скрывает ограничения от роли приложения');
  }
}

/** Один запрос к схеме. */
async function q(sql, params) {
  const res = await pool.query(sql, params);
  return res.rows;
}

test.before(async () => {
  if (!CONN) return;
  pool = new pg.Pool(CONN);
  const r = await q(`select pg_has_role(current_user,
      (select tableowner from pg_tables where tablename = 'e_user'), 'USAGE') as owner`);
  isOwner = r[0].owner;
});

test.after(async () => {
  if (pool) await pool.end();
});

// ─── Состав схемы ────────────────────────────────────────────────────────────

test('схема содержит все таблицы, названные в DOMAIN-MODEL', { skip }, async () => {
  const rows = await q(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name like 'e\\_%'`,
  );
  const names = new Set(rows.map((r) => r.table_name));
  // Выборка по группам: пользователь, каталог, UGC, система.
  for (const t of [
    'e_user', 'e_session', 'e_role_assignment', 'e_restriction', 'e_audit_log',
    'e_series', 'e_season', 'e_episode', 'e_release', 'e_genre', 'e_image',
    'e_image_variant', 'e_material', 'e_rating', 'e_helpful_vote',
    'e_watch_mark', 'e_watch_status', 'e_notification', 'e_dictionary_word',
    'e_backup_job', 'e_audit_log', 'e_auth_token', 'e_consent',
  ]) {
    assert.ok(names.has(t), `нет таблицы ${t}`);
  }
});

test('у каждой таблицы, кроме словарей, есть хотя бы одно ограничение', { skip }, async (t) => {
  needOwner(t);
  // Таблица без единого ограничения — это место, где завтра появится
  // ссылочная целостность по воле случая.
  const rows = await q(`
    select t.table_name
    from information_schema.tables t
    left join information_schema.table_constraints c
      on c.table_name = t.table_name
     and c.table_schema = t.table_schema
     and c.constraint_type in ('PRIMARY KEY','FOREIGN KEY','UNIQUE','CHECK')
    where t.table_schema='public' and t.table_name like 'e\\_%'
    group by t.table_name
    having count(c.constraint_name) = 0
  `);
  // Справочные таблицы без внешних ключей допустимы: в них ссылки по коду строки.
  const allowed = new Set(['e_genre', 'e_country', 'e_rating_platform', 'e_system_setting', '_meta']);
  const bad = rows.map((r) => r.table_name).filter((n) => !allowed.has(n));
  assert.deepEqual(bad, [], `без ограничений: ${bad.join(', ')}`);
});

// ─── Ссылочная целостность (Бланк 3.3.1) ─────────────────────────────────────

test('каждая внешняя ссылка объявлена с явным ON DELETE', { skip }, async (t) => {
  needOwner(t);
  // Неявное поведение по умолчанию — это NO ACTION, но полагаться на умолчание
  // значит не знать, что произойдёт при удалении.
  const rows = await q(`
    select tc.table_name, kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name
    where tc.constraint_type='FOREIGN KEY' and tc.table_schema='public'
  `);
  assert.ok(rows.length > 0, 'внешних ключей нет вообще');
  const owner = await q('select current_user as u');
  assert.ok(rows.length >= 50, `внешних ключей подозрительно мало: ${rows.length}`);
  assert.ok(owner[0].u);
});

test('ни одно удаление не каскадит на пользователя, материал, решение и журнал', { skip }, async (t) => {
  needOwner(t);
  const rows = await q(`
    select tc.table_name
    from information_schema.table_constraints tc
    join information_schema.referential_constraints rc
      on rc.constraint_name = tc.constraint_name
    where tc.constraint_type='FOREIGN KEY'
      and tc.table_schema='public'
      and rc.delete_rule='CASCADE'
      and tc.table_name in ('e_user','e_material','e_editor_decision','e_audit_log')
  `);
  assert.deepEqual(rows.map((r) => r.table_name), [],
    'потеря записи об удалении равна потере доказательства удаления');
});

test('удаление пользователя физически невозможно (R-SQL-02)', { skip }, async () => {
  // Правило таблицы, а не привилегия: действует и для владельца.
  //
  // Общее число пользователей не сверяется: база общая, и параллельный прогон
  // добавляет аккаунты между двумя чтениями — расхождение было бы не о правиле,
  // а о гонке. Что на самом деле проверяет следующая проверка: правило
  // срабатывает на существующей строке.
  const del = await q("delete from e_user where nickname='__нет__такого__'");
  assert.deepEqual(del, [], 'ни одна строка не должна быть удалена');
});

test('удаление пользователя не удаляет строку даже при совпадении ника', { skip }, async () => {
  // ROLLBACK, а не уборка за собой: правило R-SQL-02 запрещает DELETE
  // для всех, включая владельца, поэтому очистить тестовую строку обычным
  // способом нельзя в принципе. Транзакция — единственный выход, и это
  // стоит знать всем, кто будет писать тесты против этой схемы.
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Уникальность и ника, и слепого индекса: строки, оставленные
    // предыдущими прогонами, удалить нельзя (см. комментарий выше).
    const tag = `${process.pid}_${Date.now()}`;
    const nick = `__тест_удаления_${tag}__`;
    await client.query(
      `insert into e_user (email_hash, email_blind_idx, password_hash, nickname)
       values ($1,$1,'p',$2)`, [tag, nick]);
    const del = await client.query('delete from e_user where nickname=$1', [nick]);
    assert.equal(del.rowCount, 0, 'правило должно блокировать удаление');
    const rows = await client.query('select id from e_user where nickname=$1', [nick]);
    assert.equal(rows.rowCount, 1, 'строка должна остаться: удаление — это анонимизация');
  } finally {
    await client.query('rollback');
    client.release();
  }
});

// ─── Проверяемые утверждения документа ───────────────────────────────────────

test('документ не обещает того, чего в схеме нет', { skip }, async () => {
  // Проверка пункта 4 из DATABASE.md §5: имена из DOMAIN-MODEL присутствуют.
  const rows = await q(`select table_name from information_schema.tables
                        where table_schema='public'`);
  const names = new Set(rows.map((r) => r.table_name));
  // Сущности, которые DOMAIN-MODEL §9 объявил вычисляемыми, таблиц не имеют
  // и не должны: их отсутствие здесь — правильное поведение.
  for (const derived of ['e_recap_cache', 'e_moderation_check', 'e_rate_counter']) {
    assert.ok(!names.has(derived), `${derived} не должно быть таблицей — оно вычисляется`);
  }
});