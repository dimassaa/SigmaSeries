// Решение редактора по HTTP (F-05-04, S-50).
//
// Проверяется то, что снаружи: кто может решать, что происходит с чужим
// токеном и что решение попадает в аудит.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { pgModerationDecisions } from '../src/services/moderation/decision.js';
import { generateSecret, totpAt } from '../src/services/auth/totp.js';
import { pgAuditLog } from '../src/services/audit/log.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';
const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — решения по HTTP не проверялись';

let pool;
let decisions;
let auth;
const series = [];

// Настоящий писатель журнала: заглушка приняла бы запись, собранную дважды,
// и ошибка в маршруте осталась бы незамеченной. Создаётся после пула.
let audit = null;

async function staff({ roles = ['editor'] } = {}) {
  const { hash } = makeToken();
  const nickname = `mod-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${nickname}@example.com`;
  const passwordHash = await hashPassword(PASSWORD);
  const created = await pgAuthStore(pool).createUser({
    email,
    nickname,
    passwordHash,
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
      `INSERT INTO e_role_assignment (user_id, role, granted_by, note) VALUES ($1, $2, $1, 'тест')`,
      [created.id, role],
    );
  }
  // Служебная роль требует второго фактора (R-SEC-04) — заводим секрет
  // через сервис: он шифрует его, как положено.
  const secret = generateSecret();
  if (roles.length) await auth.enableTwoFactor(created.id, secret, []);
  return { id: created.id, email, nickname, passwordHash, roles, secret };
}

async function seriesWith() {
  const { rows: [row] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Разбор фикстуры', 'Moderation fixture', $2, 'published', 'airing', 2024) RETURNING id`,
    [`mod-http-${crypto.randomUUID().slice(0, 8)}`, 969_000_000 + Math.floor(Math.random() * 900)],
  );
  series.push(row.id);
  return row.id;
}

async function material({ authorId, seriesId }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO e_material (author_id, kind, series_id, body, state)
     VALUES ($1, 'review', $2, 'Материал, который решит редактор', 'flagged') RETURNING id`,
    [authorId, seriesId],
  );
  return Number(row.id);
}

async function withServer({ user = null, run }) {
  const app = createApp({
    data: stubData(),
    auth,
    decisions,
    audit,
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

  if (user) {
    const form = await (await get('/ru/login')).text();
    const first = await post('/ru/login', {
      email: user.email, password: PASSWORD, csrf: csrfOf(form),
    });
    // Служебная роль требует второго фактора (R-SEC-04): без кода сессия не
    // заведена, и служебные разделы не открываются.
    if (first.headers.get('location')?.endsWith('/2fa')) {
      const code = await (await get('/ru/2fa')).text();
      await post('/ru/2fa', {
        code: totpAt(user.secret, Math.floor(Date.now() / 1000)),
        csrf: csrfOf(code),
      });
    }
  }

  try {
    await run({ get, post, csrfOf });
  } finally {
    await /** @type {Promise<void>} */ (new Promise((r) => server.close(r)));
  }
}

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
  decisions = pgModerationDecisions(pool);
  auth = pgAuthStore(pool);
  audit = pgAuditLog(pool);
});

test.after(async () => {
  if (!pool) return;
  const ids = `SELECT id FROM e_series WHERE id = ANY($1::bigint[])`;
  await pool.query(`DELETE FROM e_editor_decision WHERE material_id IN (SELECT id FROM e_material WHERE series_id IN (${ids}))`, [series]);
  await pool.query(`DELETE FROM e_notification WHERE kind = 'material_decision' AND params->>'materialId' IN (
    SELECT id::text FROM e_material WHERE series_id IN (${ids}))`, [series]);
  await pool.query(`DELETE FROM e_material WHERE series_id IN (${ids})`, [series]);
  await pool.query('DELETE FROM e_series WHERE id = ANY($1::bigint[])', [series]);
  await pool.query("DELETE FROM e_audit_log WHERE action IN ('material.decide', 'dictionary.allow_word')");
  await pool.query("DELETE FROM e_role_assignment WHERE note = 'тест'");
  await pool.query("DELETE FROM e_two_factor WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE 'mod-%')");
  await pool.end();
});

test('редактор решает: 303 и запись в аудите (F-05-04 §18)', { skip }, async () => {
  const seriesId = await seriesWith();
  const author = await staff({ roles: [] });
  const editor = await staff({ roles: ['editor'] });
  const id = await material({ authorId: author.id, seriesId });

  await withServer({
    user: editor,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/')).text();
      const res = await post(`/ru/mod/${id}`, {
        decision: 'approve',
        reason: 'слово употребляется нормально',
        csrf: csrfOf(page),
      });
      assert.equal(res.status, 303, 'решение принято, возвращаем в очередь');
      assert.equal(res.headers.get('location'), '/ru/mod');

      const { rows: [row] } = await pool.query('SELECT state FROM e_material WHERE id = $1', [id]);
      assert.equal(row.state, 'approved');
    },
  });

  const { rows: [entry] } = await pool.query(
    `SELECT object_id, reason, result FROM e_audit_log
      WHERE action = 'material.decide' AND object_id = $1 ORDER BY id DESC LIMIT 1`,
    [id],
  );
  assert.ok(entry, 'решение попало в аудит');
  assert.equal(Number(entry.object_id), id);
  assert.match(entry.reason, /слово употребляется нормально/, 'причина сохранена в журнале');
  assert.match(entry.reason, /decision=approved/, 'решение записано в журнал');
});

test('зритель решать не может (EC-R7)', { skip }, async () => {
  const seriesId = await seriesWith();
  const author = await staff({ roles: [] });
  const reader = await staff({ roles: [] });
  const id = await material({ authorId: author.id, seriesId });

  await withServer({
    user: reader,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/')).text();
      const res = await post(`/ru/mod/${id}`, {
        decision: 'approve', reason: 'пытаюсь решить', csrf: csrfOf(page),
      });
      assert.equal(res.status, 404, 'служебный раздел не выдаёт своего существования');
    },
  });

  const { rows: [row] } = await pool.query('SELECT state FROM e_material WHERE id = $1', [id]);
  assert.equal(row.state, 'flagged', 'материал остался в очереди');
  const { rows: denied } = await pool.query(
    `SELECT count(*)::int AS n FROM e_audit_log
      WHERE action = 'material.decide' AND object_id = $1`,
    [id],
  );
  assert.equal(denied[0].n, 0, 'попытка зрителя не попала в аудит решений');
});

test('чужой токен не проходит, и попытка попадает в аудит (R-SEC-23)', { skip }, async () => {
  const seriesId = await seriesWith();
  const author = await staff({ roles: [] });
  const editor = await staff({ roles: ['editor'] });
  const id = await material({ authorId: author.id, seriesId });

  await withServer({
    user: editor,
    run: async ({ post }) => {
      const res = await post(`/ru/mod/${id}`, {
        decision: 'approve', reason: 'решаю', csrf: 'чужой токен',
      });
      assert.equal(res.status, 403, 'без верного токена решение не принимается');
    },
  });

  const { rows: [row] } = await pool.query('SELECT state FROM e_material WHERE id = $1', [id]);
  assert.equal(row.state, 'flagged', 'материал остался в очереди');
  const { rows: [denied] } = await pool.query(
    `SELECT reason FROM e_audit_log
      WHERE action = 'material.decide' AND result = 'denied' ORDER BY id DESC LIMIT 1`,
  );
  assert.ok(denied, 'попытка записана в аудит');
  assert.equal(denied.reason, 'csrf-missing');
});

test('решение без причины отвергается (F-05-04 §8а)', { skip }, async () => {
  const seriesId = await seriesWith();
  const author = await staff({ roles: [] });
  const editor = await staff({ roles: ['editor'] });
  const id = await material({ authorId: author.id, seriesId });

  await withServer({
    user: editor,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/')).text();
      const res = await post(`/ru/mod/${id}`, {
        decision: 'approve', reason: '', csrf: csrfOf(page),
      });
      assert.equal(res.status, 400, 'без причины решение не принимается');
    },
  });
});
