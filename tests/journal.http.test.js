// Сквозной идентификатор запроса (R-SEC-29).
//
// Проверяется через настоящий HTTP и именно потому, что требование
// сквозное: идентификатор должен появиться у маршрута и в ответе. Проверка
// вызовом функции доказала бы только то, что функция возвращает строку.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';

async function withServer(run) {
  const pool = { query: async () => ({ rows: [] }), on: () => {} };
  const app = createApp({
    data: stubData(),
    auth: stubAuthStore({}, {}),
    sessionMw: createSessionMiddleware(pool, createMemorySessionStore()),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run((path, init) => fetch(base + path, { redirect: 'manual', ...init }));
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('у каждого запроса свой идентификатор, и он виден в ответе', async () => {
  await withServer(async (get) => {
    const first = await get('/ru/');
    const second = await get('/ru/');

    const a = first.headers.get('x-request-id');
    const b = second.headers.get('x-request-id');

    assert.ok(a, 'без идентификатора записи журнала не сойтись между собой');
    assert.ok(b);
    assert.notEqual(a, b, 'одинаковый идентификатор склеил бы два разных запроса');
  });
});

test('присланный идентификатор не подставляется в ответ', async () => {
  await withServer(async (get) => {
    // Принять присланное значение — значит отдать человеку контроль над
    // журналом: по его строке потом искали бы настоящие записи.
    //
    // Значение латиницей и без перевода строки: `fetch` не отправляет ни
    // кириллицу (не ByteString), ни перевод строки, и проверка падала бы на
    // синтаксисе заголовка, а не на поведении сервера.
    const spoofed = 'spoofed-request-id';
    const res = await get('/ru/', { headers: { 'X-Request-Id': spoofed } });

    assert.notEqual(res.headers.get('x-request-id'), spoofed, 'присланное значение отброшено');
    assert.match(res.headers.get('x-request-id'), /^[0-9a-f-]{36}$/, 'идентификатор свой, в виде UUID');
  });
});

test('идентификатор есть и у ответа с ошибкой, а не только у успешного', async () => {
  await withServer(async (get) => {
    const res = await get('/ru/такой-страницы-нет');
    assert.equal(res.status, 404);
    assert.ok(res.headers.get('x-request-id'), 'неудачный запрос журналируется тоже');
  });
});