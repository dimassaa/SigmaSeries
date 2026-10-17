// Настройки уведомлений (F-03-10): что человек может выключить, а что — нет.
//
// Настройка проверяется не формой, а двумя концами: полем в `e_notification_preference`
// и тем, создаётся ли после этого уведомление. Переключатель, который ничего
// не меняет, хуже отсутствующего переключателя — человек думает, что отписался.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgNotifications } from '../src/services/notify/notification.js';
import { pgNotificationPreferences } from '../src/services/notify/preferences.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — настройки уведомлений не проверялись';

let pool;
let notifications;
let preferences;
let user;

const params = { seriesSlug: 'nastroyki', seriesTitle: 'Настройки', season: 1, episodes: [1], date: '2026-10-20' };

test.before(async () => {
  if (!available) return;
  pool = createPool();
  notifications = pgNotifications(pool);
  preferences = pgNotificationPreferences(pool);

  const nickname = `npref-${crypto.randomUUID().slice(0, 8)}`;
  const { hash } = makeToken();
  const created = await pgAuthStore(pool).createUser({
    email: `${nickname}@example.com`,
    nickname,
    passwordHash: '$argon2id$заглушка',
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
  });
  user = { id: created.id };
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_notification WHERE user_id = $1', [user.id]);
  await pool.query('DELETE FROM e_notification_preference WHERE user_id = $1', [user.id]);
  await pool.query('DELETE FROM e_user WHERE id = $1', [user.id]);
  await pool.end();
});

const wipe = () => pool.query('DELETE FROM e_notification_preference WHERE user_id = $1', [user.id]);
const create = (kind = 'release_today') => notifications.create({
  userIds: [user.id], kind, params, dedupKey: `pref-test-${kind}-${crypto.randomUUID()}`,
});

test('без настроек приходят все категории (по умолчанию всё включено)', { skip }, async () => {
  await wipe();
  await pool.query('DELETE FROM e_notification WHERE user_id = $1', [user.id]);

  const released = await create('release_today');
  const moderated = await create('moderation_result');

  assert.equal(released.created, 1, 'выходы приходят без всяких настроек');
  assert.equal(moderated.created, 1, 'и результат проверки тоже');
});

test('выключенная категория не создаёт уведомление (F-03-10 §18)', { skip }, async () => {
  await wipe();
  await pool.query('DELETE FROM e_notification WHERE user_id = $1', [user.id]);

  await preferences.set({ userId: user.id, category: 'release', channel: 'in_service', enabled: false });

  assert.equal((await create('release_today')).created, 0,
    'выходы выключены — уведомление не создаётся');
  assert.equal((await create('release_changed')).created, 0,
    'и переносы той же категории тоже');

  assert.equal((await create('moderation_result')).created, 1,
    'другие категории не выключаются вместе с ней');

  await wipe();
  assert.equal((await create('release_today')).created, 1,
    'сняли настройку — уведомления вернулись');
});

test('настройка одной категории не трогает соседние строки (R-MOD-19)', { skip }, async () => {
  await wipe();

  await preferences.set({ userId: user.id, category: 'reply', channel: 'in_service', enabled: false });
  const matrix = await preferences.matrix(user.id);

  assert.equal(matrix.reply.in_service, false, 'ответы выключены');
  assert.equal(matrix.release.in_service, true, 'выходы остались включены');
  assert.equal(matrix.moderation.in_service, true, 'проверка материалов — всегда включена');

  await wipe();
});

test('обязательную категорию выключить нельзя: ни кодом, ни напрямую (F-03-10 §5)', { skip }, async () => {
  await wipe();

  const refused = await preferences.set({
    userId: user.id, category: 'moderation', channel: 'in_service', enabled: false,
  });
  assert.deepEqual(refused, { ok: false, reason: 'mandatory' },
    'настройка отказала и сказала почему');

  // Прямая запись обходит код настроек — и не проходит: ограничение в схеме.
  await assert.rejects(
    () => pool.query(
      `INSERT INTO e_notification_preference (user_id, category, channel, enabled)
       VALUES ($1, 'moderation', 'in_service', FALSE)`,
      [user.id],
    ),
    /ck_notif_pref_moderation/,
    'и база тоже не даёт выключить результат проверки',
  );
});

test('категория и канал берутся из списка, а не из строки (R-SEC-16)', { skip }, async () => {
  await wipe();

  assert.deepEqual(
    await preferences.set({ userId: user.id, category: 'нужно-всем', channel: 'in_service', enabled: false }),
    { ok: false, reason: 'unknown-category' },
  );
  assert.deepEqual(
    await preferences.set({ userId: user.id, category: 'release', channel: 'телеграм', enabled: true }),
    { ok: false, reason: 'unknown-channel' },
  );

  const rows = await pool.query('SELECT count(*)::int AS n FROM e_notification_preference WHERE user_id = $1', [user.id]);
  assert.equal(rows.rows[0].n, 0, 'чужие значения в таблицу не попали');
});

test('тихие часы сохраняются вместе с границами (23:00–08:00)', { skip }, async () => {
  const store = pgAuthStore(pool);
  const { rows: [before] } = await pool.query(
    'SELECT quiet_hours, quiet_hours_from::text AS from, quiet_hours_to::text AS to FROM e_user WHERE id = $1',
    [user.id],
  );
  assert.equal(before.quiet_hours, false, 'по умолчанию выключены');
  assert.equal(before.from, '23:00:00', 'а границы стоят из спецификации');
  assert.equal(before.to, '08:00:00');

  await store.updateNotifications(user.id, { quietHours: true, quietFrom: '22:30', quietTo: '07:15' });
  const { rows: [after] } = await pool.query(
    'SELECT quiet_hours, quiet_hours_from::text AS from, quiet_hours_to::text AS to FROM e_user WHERE id = $1',
    [user.id],
  );
  assert.equal(after.quiet_hours, true);
  assert.equal(after.from, '22:30:00', 'граница сохранилась');
  assert.equal(after.to, '07:15:00');

  // Мусор во времени не принимается: строка из формы не должна превращаться
  // в пустое значение, которое потом молча ломает расчёт тишины.
  await store.updateNotifications(user.id, { quietHours: true, quietFrom: 'полночь', quietTo: '07:15' });
  const { rows: [kept] } = await pool.query(
    'SELECT quiet_hours_from::text AS from FROM e_user WHERE id = $1', [user.id],
  );
  assert.equal(kept.from, '22:30:00', 'прежнее значение осталось, мусор не записался');

  await store.updateNotifications(user.id, { quietHours: false });
});