// Маршруты здоровья системы (F-09-06, S-82).
//
// HTTP-слой проверяется без живой базы: источник снимка подменён, а сессия —
// готовая. Так тест отвечает на вопросы, которые принадлежат маршруту:
// пускает ли он не-админа, требует ли CSRF и куда возвращает после проверки
// восстановления.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const CSRF = 'health-csrf-token';

function snapshot() {
  return {
    metrics: [
      {
        key: 'moderation', severity: 'problem', state: 'growing',
        textKey: 'admin.health.text.moderation.growing',
        textParams: { minutes: 48 }, value: 4, unit: 'count', link: '/mod',
      },
      {
        key: 'backup', severity: 'ok', state: 'ok',
        textKey: 'admin.health.text.backup.ok', value: null, unit: 'text',
        link: '/admin/backups',
      },
    ],
    errors: { count: 0, series: [] },
    response: { p95: 120, routes: [], series: [] },
    eventLoop: { delayMs: 12 },
    moderation: { waiting: 4, oldestMinutes: 48, growing: true, cautious: true },
    tasks: { items: [], failed: 0, unknown: 0 },
    disk: { freePercent: 41 },
    backup: { last: null, verifiedAgeHours: null },
  };
}

async function withServer({ roles = ['admin'], run }) {
  const writes = [];
  const app = createApp({
    data: stubData(),
    adminHealth: { screen: async () => snapshot() },
    backups: { recent: async () => [] },
    backupRunner: async () => ({ status: 'verified', bytes: 1024 }),
    audit: { write: async (entry) => { writes.push(entry); } },
    sessionMw: [(req, _res, next) => {
      req.session = {
        csrf: CSRF,
        user: { id: 7, roles },
      };
      req.account = { nickname: 'admin', unread: 0 };
      next();
    }],
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });
  const post = (path, fields) => get(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });

  try {
    await run({ get, post, writes });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('админ видит здоровье и ссылку на очередь модерации', async () => {
  await withServer({
    run: async ({ get }) => {
      const res = await get('/ru/admin/health');
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /Система/);
      assert.match(html, /Очередь растёт/);
      assert.match(html, /href="\/ru\/mod"/);
      assert.match(html, /Проверить восстановление/);
      assert.match(html, /name="csrf" value="health-csrf-token"/);
    },
  });
});

test('английская версия экрана собирается из тех же данных', async () => {
  await withServer({
    run: async ({ get }) => {
      const res = await get('/en/admin/health');
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /System/);
      assert.match(html, /Scheduled tasks/);
      assert.match(html, /href="\/en\/mod"/);
    },
  });
});

test('не-админ получает 404 на служебном адресе', async () => {
  await withServer({
    roles: [],
    run: async ({ get }) => {
      const res = await get('/ru/admin/health');
      assert.equal(res.status, 404);
    },
  });
});

test('проверка восстановления без CSRF не запускается', async () => {
  await withServer({
    run: async ({ post, writes }) => {
      const res = await post('/ru/admin/backups/verify', { csrf: 'чужой', return: 'health' });
      assert.equal(res.status, 403);
      assert.match(await res.text(), /Сессия устарела/);
      assert.equal(writes.length, 0, 'аудит не пишется, запуска не было');
    },
  });
});

test('проверка восстановления пишет аудит и возвращает на S-82', async () => {
  await withServer({
    run: async ({ post, writes }) => {
      const res = await post('/ru/admin/backups/verify', { csrf: CSRF, return: 'health' });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/ru/admin/health');
      assert.equal(writes.length, 1);
      assert.equal(writes[0].action, 'backup.verify');
      assert.equal(writes[0].result, 'ok');
    },
  });
});
