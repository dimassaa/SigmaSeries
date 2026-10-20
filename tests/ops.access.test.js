// Служебные роли, журнал аудита, учёт резервных копий и настройки главной.
//
// Четыре вещи, которые выглядели готовыми и не были: роль выдать было нечем,
// в журнал аудита не писал никто, копия удалялась сразу после проверки, а
// двенадцать ключей главной жили в коде. Все четыре — из тех дыр, которые
// всплывают на защите, а не на тестах.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { pgAuditLog } from '../src/services/audit/log.js';
import { pgBackupJobs } from '../src/services/backup/store.js';
import { homeSettings, DEFAULTS } from '../src/services/home/settings.js';
import { pgData } from '../src/services/home/data.js';
import { makeToken } from '../src/services/auth/password.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — служебные роли и копии не проверялись';

let pool;
let auth;
let audit;
let backups;
let counter = 0;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  auth = pgAuthStore(pool);
  audit = pgAuditLog(pool);
  backups = pgBackupJobs(pool);
});

async function account() {
  counter += 1;
  const nickname = `adm${String(counter).padStart(4, '0')}-${crypto.randomUUID().slice(0, 8)}`;
  const { hash } = makeToken();
  const created = await auth.createUser({
    email: `${nickname}@example.com`,
    nickname,
    passwordHash: '$argon2id$заглушка',
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
  });
  return created;
}

test.after(async () => {
  if (!pool) return;
  const people = "(SELECT id FROM e_user WHERE nickname LIKE 'adm%')";
  await pool.query(`DELETE FROM e_audit_log WHERE object_id IN (SELECT id FROM e_user WHERE nickname LIKE 'adm%')`);
  await pool.query(`DELETE FROM e_role_assignment WHERE user_id IN ${people}`);
  await pool.query(`DELETE FROM e_notification WHERE user_id IN ${people}`);
  await pool.query(`DELETE FROM e_progress WHERE user_id IN ${people}`);
  await pool.query(`DELETE FROM e_session WHERE user_id IN ${people}`);
  await pool.query(`DELETE FROM e_auth_token WHERE user_id IN ${people}`);
  await pool.query(`DELETE FROM e_consent WHERE user_id IN ${people}`);
  await pool.query(`DELETE FROM e_backup_job WHERE file_path LIKE 'test-backup-%'`);
  await pool.query('DELETE FROM e_user WHERE nickname LIKE \'adm%\'');
  await pool.end();
});

test('роль выдаётся и снимается, а срок истечения её отключает', { skip }, async () => {
  const user = await account();

  const granted = await auth.assignRole({
    userId: user.id,
    role: 'analyst',
    expiresAt: new Date(Date.now() + 3_600_000),
    reason: 'аналитика за декабрь',
  });
  assert.deepEqual(granted, { ok: true });
  assert.deepEqual(await auth.roles(user.id), ['analyst']);

  const revoked = await auth.revokeRole({ userId: user.id, role: 'analyst' });
  assert.equal(revoked.removed, 1);
  assert.deepEqual(await auth.roles(user.id), []);
});

test('роль без причины, без срока и от чужого — не выдаётся', { skip }, async () => {
  const user = await account();
  const other = await account();

  assert.equal((await auth.assignRole({ userId: user.id, role: 'admin', reason: '  ' })).reason,
    'no-reason', 'без причины в журнале ничего не объяснить');
  assert.equal((await auth.assignRole({ userId: user.id, role: 'editor', reason: 'на месяц' })).reason,
    'no-expiry', 'служебная роль без срока становится вечной молча');
  assert.equal((await auth.assignRole({ userId: user.id, role: 'root', reason: 'на месяц' })).reason,
    'unknown-role', 'роль не из списка — ошибка вызывающего кода');

  // Выдать роль может администратор: иначе любой, кто догадался адреса, мог бы
  // себя сделать администратором.
  await auth.assignRole({ userId: other.id, role: 'admin', reason: 'владелец базы' });
  const byStranger = await auth.assignRole({
    userId: user.id, role: 'editor', grantedBy: user.id, expiresAt: new Date(), reason: 'себе',
  });
  assert.equal(byStranger.reason, 'not-admin');
  assert.deepEqual(await auth.roles(user.id), [], 'и роль не появилась');
});

test('выдача роли попадает в журнал аудита и секретов туда не несёт (R-SEC-33)', { skip }, async () => {
  const user = await account();
  await audit.write({
    actorId: null,
    action: 'role_grant',
    objectType: 'user',
    objectId: user.id,
    result: 'ok',
    reason: 'аналитика за декабрь',
    after: { role: 'analyst', passwordHash: 'argon2id$тайна', token: 'секретный' },
  });

  const { rows } = await pool.query(
    "SELECT after_data FROM e_audit_log WHERE object_id = $1 ORDER BY id DESC LIMIT 1", [user.id],
  );
  const after = rows[0].after_data;
  assert.equal(after.role, 'analyst');
  assert.ok(!JSON.stringify(after).includes('тайна'), 'хеш пароля в журнал не попал');
  assert.ok(!JSON.stringify(after).includes('секретный'), 'и токен тоже');
});

test('запись без причины не проходит: причина обязательна', { skip }, async () => {
  const user = await account();
  await assert.rejects(
    () => audit.write({ action: 'ban', objectType: 'user', objectId: user.id, reason: '  ' }),
    /Причина обязательна/,
  );
});

test('журнал убирается по сроку, а без срока живёт вечно (audit.retention_days)', { skip }, async () => {
  const user = await account();
  const write = (daysAgo) => pool.query(
    `INSERT INTO e_audit_log (at, action, object_type, object_id, result, reason)
     VALUES (now() - ($1 || ' days')::interval, 'test', 'user', $2, 'ok', 'проверка срока')
     RETURNING id`,
    [String(daysAgo), user.id],
  );
  const old = await write(400);
  const fresh = await write(1);

  assert.equal(await audit.prune({ keepDays: null }), 0, 'без срока уборки нет');
  assert.equal(await audit.prune({ keepDays: 30 }), 1, 'срок в 30 дней убирает старое');

  const { rows } = await pool.query(
    'SELECT id FROM e_audit_log WHERE object_id = $1 ORDER BY id', [user.id],
  );
  assert.deepEqual(rows.map((row) => row.id), [fresh.rows[0].id], 'свежая запись осталась');

  await pool.query('DELETE FROM e_audit_log WHERE id = ANY($1::bigint[])', [[old.rows[0].id, fresh.rows[0].id]]);
});

test('копия записывается с файлом и ротация не трогает негодные (EC-B8)', { skip }, async () => {
  // Уборка до начала: после неудачного прогона строки остаются, и следующий
  // прогон считает их своими.
  await pool.query("DELETE FROM e_backup_job WHERE file_path LIKE 'test-backup-%' OR (status = 'error' AND file_path IS NULL)");

  const good = await backups.record({ status: 'verified', sizeBytes: 100, filePath: 'test-backup-a' });
  const bad = await backups.record({ status: 'error', sizeBytes: 10, filePath: null });

  assert.equal(good.verified_at !== null, true, 'проверенная копия помнит, когда проверена');
  assert.equal(bad.verified_at, null, 'негодная — не проверена');

  // Две проверенные сверх срока и одна негодная: ротация убирает лишние
  // проверенные, а негодную оставляет — после серии неудачных проверок она
  // может быть единственным, что осталось.
  for (const i of [2, 3]) {
    // eslint-disable-next-line no-await-in-loop
    await backups.record({ status: 'verified', sizeBytes: 100, filePath: `test-backup-${i}` });
  }
  await backups.prune({ keepLast: 2 });

  // Считаются свои строки, а не все удалённые: ротация убирает и чужие
  // проверенные копии (например, из расписания), и их число к проверке этого
  // теста отношения не имеет.
  const { rows } = await pool.query(
    `SELECT file_path FROM e_backup_job
      WHERE file_path LIKE 'test-backup-%' OR status = 'error'
      ORDER BY id`,
  );
  const ours = rows.filter((row) => (row.file_path ?? '').startsWith('test-backup-')).map((row) => row.file_path);
  assert.equal(ours.includes('test-backup-a'), false,
    'самая старая проверенная копия убрана: сверх срока она лишняя');
  assert.equal(ours.length, 2, 'из трёх проверенных остались две последние');
  assert.equal((await backups.recent({ limit: 20 })).some((row) => row.status === 'error'), true,
    'негодная копия в журнале осталась');

  await pool.query("DELETE FROM e_backup_job WHERE file_path LIKE 'test-backup-%' OR (status = 'error' AND file_path IS NULL)");
});

test('срок хранения копий берётся из настроек, а без него — из модуля', { skip }, async () => {
  assert.equal(await backups.keepLast(), 7, 'по умолчанию семь копий (backup.keep_last)');

  await pool.query(
    `INSERT INTO e_system_setting (key, value) VALUES ('backup.keep_last', '3')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  try {
    assert.equal(await backups.keepLast(), 3);
  } finally {
    await pool.query("DELETE FROM e_system_setting WHERE key = 'backup.keep_last'");
  }
});

test('главная читает свои ключи, а без них работает по умолчанию (M6 §0)', { skip }, async () => {
  assert.deepEqual(await homeSettings(pool), DEFAULTS, 'пустые настройки = значения модуля');

  await pool.query(
    `INSERT INTO e_system_setting (key, value) VALUES ('home.banners_per_day', '1'),
                                                   ('home.fresh_per_page', '2')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  try {
    const settings = await homeSettings(pool);
    assert.equal(settings.bannersPerDay, 1);
    assert.equal(settings.freshPerPage, 2);
    assert.equal(settings.genresPerRow, DEFAULTS.genresPerRow, 'остальные не тронуты');

    const data = pgData(pool);
    const banners = await data.banners();
    assert.ok(banners.length <= 1, 'баннеров не больше, чем велела настройка');
    // Новинки приходят кругами: настройка ограничивает круг, а не весь ряд.
    const fresh = await data.fresh();
    assert.ok(fresh.every((circle) => circle.length <= 2), 'в круге не больше, чем велела настройка');
  } finally {
    await pool.query("DELETE FROM e_system_setting WHERE key LIKE 'home.%'");
  }
});