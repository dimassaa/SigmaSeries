// Кнопки запуска на экране «Импорт» (S-76, F-12-08).
//
// Проверяется то, что видит администратор: кнопки на месте, нажатие заводит
// запланированный запуск, а чужой пользователь до запуска не дотягивается.
// Сам прогон не выполняется: его выполняет планировщик, и это проверяется в
// `import.runs`.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { generateSecret, totpAt } from '../src/services/auth/totp.js';
import { pgImportReport } from '../src/services/import/report.js';
import { acquireImportLock } from './helpers/import-lock.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — кнопки импорта не проверялись';

let pool;
let auth;
/** Отпускается в `after`: держит общую блокировку строк запуска. */
let unlockImport;
const created = [];
const runs = [];

async function user({ roles = [] } = {}) {
  const { hash } = makeToken();
  const nickname = `import-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${nickname}@example.com`;
  const passwordHash = await hashPassword('правильный-пароль-из-десяти');
  const account = await pgAuthStore(pool).createUser({
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
    [account.id],
  );
  for (const role of roles) {
    await pool.query(
      `INSERT INTO e_role_assignment (user_id, role, granted_by, note) VALUES ($1, $2, $1, 'тест импорта')`,
      [account.id, role],
    );
  }
  const secret = generateSecret();
  if (roles.includes('admin')) await auth.enableTwoFactor(account.id, secret, []);
  created.push(account.id);
  return { id: account.id, email, nickname, passwordHash, roles, secret };
}

async function withServer({ user: viewer = null, run }) {
  const calls = [];
  const app = createApp({
    data: stubData(),
    auth,
    pool,
    importReport: pgImportReport(pool),
    audit: { write: async (entry) => calls.push(entry) },
    // createApp объявляет middleware сессий функцией, а модуль отдаёт обработчик
    // или их пару — Express принимает и то и другое.
    sessionMw: /** @type {Function} */ (createSessionMiddleware(pool, createMemorySessionStore(), {
      account: async (u) => ({ nickname: u.nickname, unread: 0, pollSeconds: 0 }),
    })),
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
    await run({ get, post, csrfOf, calls });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
  auth = pgAuthStore(pool);
  unlockImport = await acquireImportLock(pool);
});

// Планированный полный прогон заводит только кнопка, поэтому чистить можно
// без оглядки на приложение: предыдущая проверка не должна мешать следующей.
test.beforeEach(async () => {
  if (!available) return;
  await pool.query("DELETE FROM e_import_run WHERE kind = 'full_run' AND status = 'planned'");
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_import_run WHERE id = ANY($1::bigint[])', [runs]);
  await pool.query("DELETE FROM e_import_run WHERE kind = 'full_run' AND status = 'planned'");
  await pool.query("DELETE FROM e_role_assignment WHERE note = 'тест импорта'");
  await pool.query('DELETE FROM e_user WHERE id = ANY($1::bigint[])', [created]);
  await unlockImport?.();
  await pool.end();
});

test('кнопки запуска есть на экране и заводят запланированный прогон', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });

  await withServer({
    user: admin,
    run: async ({ get, post, csrfOf, calls }) => {
      const page = await (await get('/ru/admin/import')).text();
      assert.match(page, /name="kind" value="full_run"/, 'есть кнопка полного прогона');
      assert.match(page, /name="dry" value="1"/, 'есть кнопка сухого прогона');
      assert.match(page, /name="kind" value="schedule_sync"/, 'есть кнопка расписания');

      const res = await post('/ru/admin/import/run', {
        csrf: csrfOf(page), kind: 'full_run', dry: '0',
      });
      assert.equal(res.status, 303, `кнопка ответила ${res.status}`);

      const { rows } = await pool.query(
        "SELECT id, kind, status, dry_run FROM e_import_run WHERE kind = 'full_run' ORDER BY id DESC LIMIT 1",
      );
      assert.equal(rows[0].status, 'planned', 'запуск ждёт планировщика');
      assert.equal(rows[0].dry_run, false);
      runs.push(rows[0].id);

      // Ручное действие попадает в журнал (R-SEC-36).
      const entry = calls.find((call) => call.action === 'import.run');
      assert.ok(entry, 'действие записано в журнал');
      assert.equal(entry.result, 'ok');
    },
  });
});

test('сухой прогон — это флаг, а второй прогон не заводится', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });

  await withServer({
    user: admin,
    run: async ({ get, post, csrfOf }) => {
      const page = await (await get('/ru/admin/import')).text();
      const first = await post('/ru/admin/import/run', {
        csrf: csrfOf(page), kind: 'full_run', dry: '1',
      });
      assert.equal(first.status, 303);

      const { rows } = await pool.query(
        "SELECT id, dry_run FROM e_import_run WHERE kind = 'full_run' ORDER BY id DESC LIMIT 1",
      );
      assert.equal(rows[0].dry_run, true, 'сухой прогон помечен флагом');
      runs.push(rows[0].id);

      // Второй полный прогон поверх запланированного не заводится.
      const second = await post('/ru/admin/import/run', {
        csrf: csrfOf(page), kind: 'full_run', dry: '0',
      });
      assert.equal(second.status, 409, 'второй прогон отвергнут');
      assert.match(await second.text(), /уже запланирован/);
    },
  });
});

test('кнопка расписания переносит ночной план на «сейчас»', { skip }, async () => {
  const admin = await user({ roles: ['admin'] });

  await withServer({
    user: admin,
    run: async ({ get, post, csrfOf }) => {
      await pool.query(
        `INSERT INTO e_import_run (kind, status, started_at, params)
         VALUES ('schedule_sync', 'planned', now() + interval '4 hours', '{"planned_at":"завтра"}')
         ON CONFLICT (kind) WHERE status = 'planned' DO NOTHING`,
      );
      const { rows: plans } = await pool.query(
        "SELECT id FROM e_import_run WHERE kind = 'schedule_sync' AND status = 'planned'",
      );
      runs.push(plans[0].id);

      const page = await (await get('/ru/admin/import')).text();
      const res = await post('/ru/admin/import/run', {
        csrf: csrfOf(page), kind: 'schedule_sync',
      });
      assert.equal(res.status, 303);

      const { rows } = await pool.query(
        'SELECT id, params FROM e_import_run WHERE id = $1', [plans[0].id],
      );
      assert.equal(rows[0].params.manual, true, 'план помечен как ручной');

      // План возвращается на своё время: ручной запуск не должен утащить за
      // собой ночное расписание приложения.
      await pool.query(
        `UPDATE e_import_run
            SET started_at = now() + interval '4 hours', params = params - 'manual'
          WHERE id = $1`,
        [plans[0].id],
      );
    },
  });
});

test('без роли администратора раздела нет', { skip }, async () => {
  const viewer = await user({ roles: [] });

  await withServer({
    user: viewer,
    run: async ({ get }) => {
      const res = await get('/ru/admin/import');
      assert.equal(res.status, 404, 'раздела не существует для не-администратора');
    },
  });
});
