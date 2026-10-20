// Мьют и бан со стороны редактора (F-05-08).
//
// Проверяется то, что после решения изменилось: материалы автора не
// принимаются, его оценки не входят в среднее по сайту, а разбан возвращает
// всё на место. И то, что мьют привилегированного запрещён (EC-R4).

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { pgModerationRestrictions } from '../src/services/moderation/restriction.js';
import { pgRatings } from '../src/services/rating/store.js';
import { MODERATION } from '../src/config/settings.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — мьют и бан не проверялись';

let pool;
let auth;
let restrictions;
let ratings;
const users = [];

async function viewer({ roles = [] } = {}) {
  const { hash } = makeToken();
  const nickname = `restriction-${crypto.randomUUID().slice(0, 8)}`;
  const created = await pgAuthStore(pool).createUser({
    email: `${nickname}@example.com`,
    nickname,
    passwordHash: await hashPassword('правильный-пароль-из-десяти'),
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  await pool.query(
    `UPDATE e_user SET email_confirmed = TRUE, registered_at = now() - interval '30 days' WHERE id = $1`,
    [created.id],
  );
  for (const role of roles) {
    await pool.query(
      `INSERT INTO e_role_assignment (user_id, role, granted_by, note) VALUES ($1, $2, $1, 'тест ограничения')`,
      [created.id, role],
    );
  }
  users.push(created.id);
  return created.id;
}

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
  auth = pgAuthStore(pool);
  restrictions = pgModerationRestrictions(pool, { auth, audit: { write: async () => {} } });
  ratings = pgRatings(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_restriction WHERE user_id = ANY($1::bigint[])', [users]);
  await pool.query('DELETE FROM e_rating WHERE user_id = ANY($1::bigint[])', [users]);
  await pool.query('DELETE FROM e_role_assignment WHERE note = \'тест ограничения\'');
  await pool.query('DELETE FROM e_user WHERE id = ANY($1::bigint[])', [users]);
  await pool.end();
});

test('мьют без причины и без срока не выдаётся (F-05-08 §8в)', { skip }, async () => {
  const author = await viewer();
  const editor = await viewer({ roles: ['editor'] });

  const noReason = await restrictions.mute({
    userId: author, hours: 24, reason: '  ', byId: editor,
  });
  assert.equal(noReason.ok, false);
  assert.equal(noReason.reason, 'reason');

  const tooLong = await restrictions.mute({
    userId: author, hours: MODERATION.muteMaxHours + 1, reason: 'слишком долго', byId: editor,
  });
  assert.equal(tooLong.ok, false, 'редактор не может дать мьют дольше верхней границы');
});

test('мьют редактора виден автору и имеет срок (F-05-08 §18)', { skip }, async () => {
  const author = await viewer();
  const editor = await viewer({ roles: ['editor'] });

  const result = await restrictions.mute({
    userId: author, hours: 24, reason: 'слишком часто отправляет материалы', byId: editor,
  });
  assert.equal(result.ok, true);
  assert.ok(result.until > new Date(), 'срок назван');

  const active = await restrictions.active(author);
  assert.ok(active, 'мьют виден');
  assert.equal(active.kind, 'mute');
  assert.equal(active.reason, 'слишком часто отправляет материалы', 'причина видна автору');
});

test('повторный мьют продлевает, а не заводит второй (F-05-08 §9)', { skip }, async () => {
  const author = await viewer();
  const editor = await viewer({ roles: ['editor'] });

  await restrictions.mute({ userId: author, hours: 24, reason: 'первый', byId: editor });
  const second = await restrictions.mute({ userId: author, hours: 48, reason: 'продление', byId: editor });

  assert.equal(second.ok, true);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM e_restriction
      WHERE user_id = $1 AND kind = 'mute' AND revoked_at IS NULL`,
    [author],
  );
  assert.equal(rows[0].n, 1, 'активный мьют один');
});

test('редактор не может мьютить привилегированного (EC-R4)', { skip }, async () => {
  const staff = await viewer({ roles: ['editor'] });
  const editor = await viewer({ roles: ['editor'] });

  const result = await restrictions.mute({
    userId: staff, hours: 24, reason: 'попробуем', byId: editor,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'privileged');
});

test('бан закрывает вход, а разбан возвращает материалы (F-05-08 §18)', { skip }, async () => {
  const author = await viewer();
  const admin = await viewer({ roles: ['admin'] });

  const result = await restrictions.ban({
    userId: author, reason: 'спам в массовом порядке', byId: admin, hideMaterials: true,
  });
  assert.equal(result.ok, true);

  const { rows: [user] } = await pool.query('SELECT status FROM e_user WHERE id = $1', [author]);
  assert.equal(user.status, 'banned', 'вход закрыт статусом');

  const { rows: [restriction] } = await pool.query(
    `SELECT kind, hide_materials FROM e_restriction
      WHERE user_id = $1 AND kind = 'ban' AND revoked_at IS NULL`,
    [author],
  );
  assert.equal(restriction.kind, 'ban');
  assert.equal(restriction.hide_materials, true, 'материалы скрыты по флажку');

  const revoked = await restrictions.revoke({ userId: author, byId: admin, reason: 'исчерпал доверие' });
  assert.equal(revoked.ok, true);

  const { rows: [back] } = await pool.query('SELECT status FROM e_user WHERE id = $1', [author]);
  assert.equal(back.status, 'active', 'после разбана человек снова может войти');
});

test('оценки забаненного не входят в среднее по сайту (EC-V5)', { skip }, async () => {
  const author = await viewer();
  const admin = await viewer({ roles: ['admin'] });
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Сериал для бана', 'Ban fixture', $2, 'published', 'airing', 2024) RETURNING id`,
    [`ban-${crypto.randomUUID().slice(0, 8)}`, 979_000_000 + Math.floor(Math.random() * 900)],
  );

  // Счётчик C общий для всей базы, а параллельные проверки в это же время
  // добавляют и убирают свои голоса. Поэтому обе цифры снимаются в одной
  // транзакции: клиент с повторяемым снимком видит базу такой, какая она
  // была в начале, и разница не плывёт.
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const base = await pgRatings(client).refreshSiteAverage();
    await client.query(
      `INSERT INTO e_rating (user_id, object_type, series_id, value, counted)
       VALUES ($1, 'series', $2, 10, TRUE)`,
      [author, series.id],
    );
    const withVote = await pgRatings(client).refreshSiteAverage();
    assert.equal(withVote.votes, base.votes + 1, 'до бана голос входит в C');

    // Бан должен быть виден в том же снимке, что и счётчик, — поэтому сервис
    // ограничений получает тот же клиент.
    const ban = await pgModerationRestrictions(client, { auth, audit: { write: async () => {} } });
    await ban.ban({ userId: author, reason: 'тест', byId: admin });
    const after = await pgRatings(client).refreshSiteAverage();
    assert.equal(after.votes, base.votes, 'после бана голос из C ушёл');
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  await pool.query('DELETE FROM e_rating WHERE series_id = $1', [series.id]);
  await pool.query('DELETE FROM e_series WHERE id = $1', [series.id]);
});
