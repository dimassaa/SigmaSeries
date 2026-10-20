// Действия карточки пользователя (F-09-02, F-09-07).
//
// Проверяется то, что администратор может и чего не может: роль выдаётся и
// снимается, ограничение выдаётся, а последнего администратора снять нельзя
// и себя ограничить нельзя. И что каждое действие требует причины.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { generateSecret, totpAt } from '../src/services/auth/totp.js';
import { leavesNoAdmin, pgAdminUsers } from '../src/services/admin/users.js';
import { pgModerationRestrictions } from '../src/services/moderation/restriction.js';
import { pgAuditLog } from '../src/services/audit/log.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — действия карточки не проверялись';

let pool;
let auth;
const created = [];

async function user({ roles = [], nickname = null } = {}) {
  const { hash } = makeToken();
  const name = nickname ?? `card-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${name}@example.com`;
  const passwordHash = await hashPassword('правильный-пароль-из-десяти');
  const account = await pgAuthStore(pool).createUser({
    email,
    nickname: name,
    passwordHash,
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  await pool.query(
    `UPDATE e_user SET email_confirmed = TRUE, registered_at = now() - interval '30 days' WHERE id = $1`,
    [account.id],
  );
  for (const role of roles) {
    await pool.query(
      `INSERT INTO e_role_assignment (user_id, role, granted_by, note) VALUES ($1, $2, $1, 'тест карточки')`,
      [account.id, role],
    );
  }
  const secret = generateSecret();
  if (roles.includes('admin')) await auth.enableTwoFactor(account.id, secret, []);
  created.push(account.id);
  return { id: account.id, email, nickname: name, passwordHash, roles, secret };
}

async function withServer({ user: viewer = null, run }) {
  const audit = pgAuditLog(pool);
  const mail = [];
  const app = createApp({
    data: stubData(),
    auth,
    adminUsers: pgAdminUsers(pool),
    moderationRestrictions: pgModerationRestrictions(pool, { auth, audit }),
    audit,
    pool,
    mailQueue: {
      async enqueue(job) { mail.push(job); return mail.length; },
      async listing() { return []; },
    },
    sessionMw: createSessionMiddleware(pool, createMemorySessionStore(), {
      account: async (u) => ({ nickname: u.nickname, unread: 0, pollSeconds: 0 }),
    }),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let jar = '';

  const get = async (path, init = {}) => {
    const res = await fetch(base + path, {
      redirect: 'manual',
      ...init,
      headers: { cookie: jar, ...(init.headers ?? {}) },
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) jar = set.map((c) => c.split(';')[0]).join('; ');
    return res;
  };
  const post = (path, fields, init = {}) => get(path, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(init.headers ?? {}) },
    body: new URLSearchParams(fields),
  });
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

  if (viewer) {
    const form = await (await get('/ru/login')).text();
    const first = await post('/ru/login', {
      email: viewer.email, password: 'правильный-пароль-из-десяти', csrf: csrfOf(form),
    });
    if (first.headers.get('location')?.endsWith('/2fa')) {
      const page = await (await get('/ru/2fa')).text();
      await post('/ru/2fa', {
        code: totpAt(viewer.secret, Math.floor(Date.now() / 1000)),
        csrf: csrfOf(page),
      });
    }
  }

  try {
    await run({ get, post, csrfOf, mail });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
  auth = pgAuthStore(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.query("DELETE FROM e_audit_log WHERE action IN ('role_grant', 'role_revoke', 'user.two_factor_reset')");
  await pool.query("DELETE FROM e_role_assignment WHERE note = 'тест карточки'");
  await pool.query('DELETE FROM e_user WHERE id = ANY($1::bigint[])', [created]);
  await pool.end();
});

test('роль выдаётся с причиной и попадает в журнал (F-09-02 §8а, §8г)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });
  const target = await user();

  await withServer({
    user: admin,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/admin/users/${target.id}`)).text();
      const res = await post(`/ru/admin/users/${target.id}/role`, {
        action: 'grant', role: 'editor', reason: 'проверка выдачи роли', csrf: csrfOf(page),
      });
      assert.equal(res.status, 303, 'роль выдана');

      const roles = await auth.roles(target.id);
      assert.ok(roles.includes('editor'), 'роль у человека появилась');

      const { rows } = await pool.query(
        `SELECT action, reason FROM e_audit_log WHERE action = 'role_grant' ORDER BY id DESC LIMIT 1`,
      );
      assert.equal(rows[0].action, 'role_grant');
      assert.match(rows[0].reason, /проверка выдачи роли/, 'причина в журнале');
    },
  });
});

test('админ сбрасывает чужую 2FA: проверка выключена, сессии отозваны, есть запись и письмо (F-01-05 §4, §17, EC-A8)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });
  const target = await user();
  await auth.enableTwoFactor(target.id, generateSecret(), []);

  // Живая сессия человека: после сброса она должна быть отозвана.
  const sid = `test-2fa-${crypto.randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO session (sid, sess, expire)
     VALUES ($1, json_build_object('cookie', json_build_object('path','/'),
                                   'user', json_build_object('id', $2::text))::json,
             now() + interval '1 day')`,
    [sid, target.id],
  );

  await withServer({
    user: admin,
    run: async ({ get, post, csrfOf, mail }) => {
      const page = await (await get(`/ru/admin/users/${target.id}`)).text();
      const res = await post(`/ru/admin/users/${target.id}/2fa/reset`, {
        reason: 'потеряно устройство', password: 'правильный-пароль-из-десяти',
        csrf: csrfOf(page),
      });
      assert.equal(res.status, 303, 'сброс выполнен');

      assert.equal(await auth.twoFactor(target.id), null, 'двухфакторная проверка выключена');
      const { rows: sessions } = await pool.query(
        'SELECT count(*)::int AS n FROM session WHERE sid = $1', [sid],
      );
      assert.equal(sessions[0].n, 0, 'сессия человека отозвана');

      const { rows } = await pool.query(
        `SELECT action, reason FROM e_audit_log WHERE action = 'user.two_factor_reset'
          ORDER BY id DESC LIMIT 1`,
      );
      assert.ok(rows.length, 'запись в журнале есть');
      assert.match(rows[0].reason, /потеряно устройство/, 'причина в журнале');

      assert.ok(mail.some((job) => job.kind === 'two_factor_reset'), 'человеку написали письмо');
    },
  });

  await pool.query('DELETE FROM session WHERE sid = $1', [sid]);
});

test('без повторного пароля чужую 2FA не сбросить (R-SEC-12)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });
  const target = await user();
  await auth.enableTwoFactor(target.id, generateSecret(), []);

  await withServer({
    user: admin,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/admin/users/${target.id}`)).text();
      const res = await post(`/ru/admin/users/${target.id}/2fa/reset`, {
        reason: 'проверка без пароля', password: 'неправильный-пароль',
        csrf: csrfOf(page),
      });
      assert.equal(res.status, 403, 'чужая проверка не выполнена');
      assert.ok(await auth.twoFactor(target.id), 'двухфакторная проверка на месте');
    },
  });
});

test('без причины чужую 2FA не сбросить (F-09-02 §8а)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });
  const target = await user();
  await auth.enableTwoFactor(target.id, generateSecret(), []);

  await withServer({
    user: admin,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/admin/users/${target.id}`)).text();
      const res = await post(`/ru/admin/users/${target.id}/2fa/reset`, {
        reason: '', password: 'правильный-пароль-из-десяти', csrf: csrfOf(page),
      });
      assert.equal(res.status, 400, 'причина обязательна');
      assert.ok(await auth.twoFactor(target.id), 'двухфакторная проверка на месте');
    },
  });
});

test('свою 2FA админ через карточку не сбрасывает — для этого скрипт (H-60)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });

  await withServer({
    user: admin,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/admin/users/${admin.id}`)).text();
      const res = await post(`/ru/admin/users/${admin.id}/2fa/reset`, {
        reason: 'проверка на себя', password: 'правильный-пароль-из-десяти',
        csrf: csrfOf(page),
      });
      assert.equal(res.status, 409, 'свою проверку сбросить нельзя');
      assert.ok(await auth.twoFactor(admin.id), 'двухфакторная проверка на месте');
    },
  });
});

test('у кого 2FA не настроена, сброс не выполняется (F-01-05 §4)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });
  const target = await user();

  await withServer({
    user: admin,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/admin/users/${target.id}`)).text();
      const res = await post(`/ru/admin/users/${target.id}/2fa/reset`, {
        reason: 'проверка без настройки', password: 'правильный-пароль-из-десяти',
        csrf: csrfOf(page),
      });
      assert.equal(res.status, 409, 'сбрасывать нечего');
    },
  });
});

test('без причины роль не выдаётся (F-09-02 §8а)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });
  const target = await user();

  await withServer({
    user: admin,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/admin/users/${target.id}`)).text();
      const res = await post(`/ru/admin/users/${target.id}/role`, {
        action: 'grant', role: 'editor', reason: '  ', csrf: csrfOf(page),
      });
      assert.equal(res.status, 400, 'без причины — отказ');
      const roles = await auth.roles(target.id);
      assert.equal(roles.includes('editor'), false, 'роли не выдано');
    },
  });
});

test('правило «последнего администратора» (F-09-02 §5)', { skip }, async () => {
  // Правило проверяется на числах: на общей базе всегда есть чужие
  // администраторы от других проверок, и по ним судить нельзя.
  assert.equal(leavesNoAdmin([7], 7), true, 'единственный администратор остаётся один — снять нельзя');
  assert.equal(leavesNoAdmin([7, 9], 7), false, 'второй администратор останется — снять можно');
  assert.equal(leavesNoAdmin([7, 9], 9), false, 'второго не тронули — администратор остаётся');
});

test('снятие роли у последнего администратора отвергается (F-09-02 §5)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });
  const others = await pgAdminUsers(pool).admins();

  await withServer({
    user: admin,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/admin/users/${admin.id}`)).text();
      const res = await post(`/ru/admin/users/${admin.id}/role`, {
        action: 'revoke', role: 'admin', reason: 'пробую остаться один', csrf: csrfOf(page),
      });
      // Снять можно, только если после этого останется кто-то ещё: чужие
      // администраторы в общей базе делают исход ответа зависимым от прогона.
      const expected = others.filter((id) => id !== admin.id).length === 0 ? 409 : 303;
      assert.equal(res.status, expected, 'ответ соответствует правилу «последний администратор»');
    },
  });
});

test('себя ограничить нельзя (F-09-02 §5)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });

  await withServer({
    user: admin,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/admin/users/${admin.id}`)).text();
      const res = await post(`/ru/admin/users/${admin.id}/restrict`, {
        action: 'mute', hours: 24, reason: 'себя', csrf: csrfOf(page),
      });
      assert.equal(res.status, 409, 'себя ограничить нельзя');
    },
  });
});

test('удаление окончательное: пароль спрашивается, срок назначается (F-09-02 §8б)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });
  const target = await user();

  await withServer({
    user: admin,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/admin/users/${target.id}`)).text();

      // Неверный пароль — удаление не запрашивается.
      const wrong = await post(`/ru/admin/users/${target.id}/delete`, {
        reason: 'проверка удаления', password: 'неправильный', csrf: csrfOf(page),
      });
      assert.equal(wrong.status, 403, 'с чужим паролем удаление не запрашивается');
      const { rows: [untouched] } = await pool.query(
        'SELECT status FROM e_user WHERE id = $1', [target.id],
      );
      assert.equal(untouched.status, 'active', 'аккаунт не тронут');

      // Верный пароль — удаление запрошено, срок назначен, материалы остаются.
      const res = await post(`/ru/admin/users/${target.id}/delete`, {
        reason: 'проверка удаления', password: 'правильный-пароль-из-десяти', csrf: csrfOf(page),
      });
      assert.equal(res.status, 303, 'удаление запрошено');
      const { rows: [row] } = await pool.query(
        'SELECT status, anonymize_after, delete_materials FROM e_user WHERE id = $1', [target.id],
      );
      assert.equal(row.status, 'deleting');
      assert.ok(row.anonymize_after !== null, 'срок обезличивания назначен');
      assert.equal(row.delete_materials, false, 'материалы остаются обезличенными');
      const days = Math.round((new Date(row.anonymize_after) - Date.now()) / 86_400_000);
      assert.ok(days >= 13 && days <= 14, `срок около 14 дней: ${days}`);

      await pool.query(
        `UPDATE e_user SET status = 'active', delete_requested_at = NULL, anonymize_after = NULL
          WHERE id = $1`, [target.id],
      );
    },
  });
});

test('себя удалить нельзя (F-09-02 §5)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });

  await withServer({
    user: admin,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/admin/users/${admin.id}`)).text();
      const res = await post(`/ru/admin/users/${admin.id}/delete`, {
        reason: 'себя', password: 'правильный-пароль-из-десяти', csrf: csrfOf(page),
      });
      assert.equal(res.status, 409, 'себя удалить нельзя');
    },
  });
});

test('мьют выдаётся и снимается (F-05-08)', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });
  const target = await user();

  await withServer({
    user: admin,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get(`/ru/admin/users/${target.id}`)).text();
      const mute = await post(`/ru/admin/users/${target.id}/restrict`, {
        action: 'mute', hours: 24, reason: 'слишком часто пишет', csrf: csrfOf(page),
      });
      assert.equal(mute.status, 303, 'мьют выдан');

      const { rows } = await pool.query(
        `SELECT kind, reason FROM e_restriction WHERE user_id = $1 AND revoked_at IS NULL`,
        [target.id],
      );
      assert.equal(rows[0].kind, 'mute');
      assert.equal(rows[0].reason, 'слишком часто пишет');

      const lift = await post(`/ru/admin/users/${target.id}/restrict`, {
        action: 'revoke', reason: 'исчерпал доверие', csrf: csrfOf(page),
      });
      assert.equal(lift.status, 303, 'ограничение снято');
      const { rows: after } = await pool.query(
        `SELECT count(*)::int AS n FROM e_restriction WHERE user_id = $1 AND revoked_at IS NULL`,
        [target.id],
      );
      assert.equal(after[0].n, 0, 'активных ограничений не осталось');
    },
  });
});
