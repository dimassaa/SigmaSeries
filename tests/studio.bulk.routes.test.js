// Маршруты массовых операций (F-10-11).
//
// Проверяется то, что видно только на HTTP-уровне: прогноз, запуск, отчёт,
// повтор только упавших и выбор «всё по фильтру». Сервис подменён двойником:
// правила действий проверены на настоящей базе в studio.bulk.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createStudioRoutes } from '../src/routes/studio.js';

async function withServer(run) {
  const calls = { preview: [], start: [], ids: [], jobs: [], audit: [] };
  const state = {
    roles: ['admin'],
    csrf: 'csrf-token',
    nextJob: 42,
  };

  const studio = {
    async list() { return { rows: [], total: 0, page: 1, pages: 1 }; },
    async genres() { return []; },
    async incomplete() { return { rows: [], total: 0, page: 1, pages: 1 }; },
    async ids(filters, limit) {
      calls.ids.push({ filters, limit });
      return [10, 11];
    },
  };
  const bulk = {
    async preview(args) {
      calls.preview.push(args);
      return {
        ok: true, affected: args.ids.length, skipped: [], sample: [],
        total: args.ids.length, ids: args.ids,
      };
    },
    async start(args) {
      calls.start.push(args);
      const jobId = state.nextJob;
      state.nextJob += 1;
      return { ok: true, jobId, affected: args.ids.length, total: args.ids.length };
    },
    async jobs() { calls.jobs.push(true); return []; },
    async job(id) {
      if (id === 42) {
        return {
          id: 42, action: 'publish', state: 'partial', done: 2, total: 2, failed: 1,
          params: { genre: null, reason: null, field: null },
          result: [{ id: 10, title: 'Одна', ok: true }, { id: 11, title: 'Две', reason: 'no_genre' }],
        };
      }
      if (id === 43) {
        return {
          id: 43, action: 'publish', state: 'done', done: 1, total: 1, failed: 0,
          params: {}, result: [{ id: 11, title: 'Две', ok: true }],
        };
      }
      return null;
    },
  };
  const audit = { async write(entry) { calls.audit.push(entry); } };

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.session = { user: { id: 1, roles: state.roles }, csrf: state.csrf };
    req.account = { nickname: 'admin', unread: 0, csrf: state.csrf };
    next();
  });
  app.use(createStudioRoutes({ pool: null, studio, bulk, audit }));

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });
  const post = (path, fields) => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      for (const item of [].concat(value)) body.append(key, String(item));
    }
    return request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  };

  try {
    return await run({ request, post, calls, state });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('гость получает 404, а не 403', async () => {
  await withServer(async ({ post, state }) => {
    state.roles = [];
    const res = await post('/ru/admin/catalog/bulk', { csrf: 'csrf-token' });
    assert.equal(res.status, 404);
  });
});

test('без csrf действие не запускается', async () => {
  await withServer(async ({ post }) => {
    const res = await post('/ru/admin/catalog/bulk', { action: 'publish', ids: '10' });
    assert.equal(res.status, 403);
  });
});

test('прогноз показывает число и принимает поле', async () => {
  await withServer(async ({ post, calls }) => {
    const res = await post('/ru/admin/catalog/bulk', {
      csrf: 'csrf-token', action: 'lock', ids: ['10', '11'], field: 'title_ru',
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Затронуто 2 из 2/);
    assert.equal(calls.preview.at(-1).field, 'title_ru');
  });
});

test('подтверждение запускает задание и уводит на отчёт', async () => {
  await withServer(async ({ post, calls }) => {
    const res = await post('/ru/admin/catalog/bulk', {
      csrf: 'csrf-token', action: 'publish', ids: ['10', '11'], confirm: '1',
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/ru/admin/catalog/bulk/42');
    assert.equal(calls.start.length, 1);
    assert.equal(calls.audit.length, 1, 'одна запись аудита на операцию');
  });
});

test('«всё по фильтру» разрешается сервером', async () => {
  await withServer(async ({ post, calls }) => {
    const res = await post('/ru/admin/catalog/bulk', {
      csrf: 'csrf-token', action: 'archive', scope: 'filter', q: 'Драма', confirm: '1',
    });
    assert.equal(res.status, 303);
    assert.equal(calls.ids.length, 1);
    assert.equal(calls.ids[0].filters.query, 'Драма');
    assert.deepEqual(calls.start[0].ids, [10, 11]);
  });
});

test('отчёт показывает итог, а повтор берёт только упавшие', async () => {
  await withServer(async ({ request, post, calls, state }) => {
    state.nextJob = 43;
    const page = await request('/ru/admin/catalog/bulk/42');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Повторить только упавшие/);
    assert.match(html, /нет жанра/);

    const retry = await post('/ru/admin/catalog/bulk/42/retry', { csrf: 'csrf-token' });
    assert.equal(retry.status, 303);
    assert.equal(retry.headers.get('location'), '/ru/admin/catalog/bulk/43');
    assert.deepEqual(calls.start.at(-1).ids, [11], 'успешная карточка не повторяется');
    assert.equal(calls.audit.at(-1).action, 'catalogue.bulk.retry');
  });
});

test('чужое задание не показывается', async () => {
  await withServer(async ({ request }) => {
    const res = await request('/ru/admin/catalog/bulk/404');
    assert.equal(res.status, 404);
  });
});
