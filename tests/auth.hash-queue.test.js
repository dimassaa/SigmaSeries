// Очередь тяжёлого хеширования пароля (EC-A16, F-01-11 §8б).
//
// Требование: не больше двух одновременных хешей, остальные ждут в очереди
// с таймаутом; переполненная очередь — отказ, а не ожидание.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import * as limits from '../src/services/auth/limits.js';
import { createHashQueue, HashQueueBusyError } from '../src/services/auth/hashQueue.js';

const PASSWORD = 'правильный-пароль-из-десяти';
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

test('одновременных хешей не больше, чем задано', async () => {
  const queue = createHashQueue({ parallel: 2, capacity: 10, waitMs: 1000 });
  let running = 0;
  let peak = 0;
  const heavy = () => new Promise((resolve) => {
    running += 1;
    peak = Math.max(peak, running);
    setTimeout(() => {
      running -= 1;
      resolve('готово');
    }, 20);
  });

  const results = await Promise.all(Array.from({ length: 6 }, () => queue.run(heavy)));

  assert.equal(peak, 2, 'одновременно считалось не больше двух хешей');
  assert.equal(results.length, 6, 'все задачи выполнены');
  assert.ok(results.every((value) => value === 'готово'));
});

test('переполненная очередь отказывает сразу, а не ждёт', async () => {
  const queue = createHashQueue({ parallel: 1, capacity: 1, waitMs: 1000 });
  const blocker = queue.run(() => new Promise((resolve) => setTimeout(resolve, 60)));
  // Второе задание встаёт в очередь, третьему места уже нет.
  const queued = queue.run(() => Promise.resolve('второе'));

  await assert.rejects(
    queue.run(() => Promise.resolve('третье')),
    (error) => error instanceof HashQueueBusyError && error.reason === 'full',
  );

  await blocker;
  assert.equal(await queued, 'второе', 'очередь доходит до своей задачи');
});

test('ожидание в очереди дольше срока заканчивается отказом', async () => {
  const queue = createHashQueue({ parallel: 1, capacity: 5, waitMs: 30 });
  const blocker = queue.run(() => new Promise((resolve) => setTimeout(resolve, 200)));

  await assert.rejects(
    queue.run(() => Promise.resolve('поздно')),
    (error) => error instanceof HashQueueBusyError && error.reason === 'timeout',
  );

  await blocker;
});

test('после освобождения слота очередь работает дальше', async () => {
  const queue = createHashQueue({ parallel: 1, capacity: 2, waitMs: 1000 });
  const first = queue.run(() => new Promise((resolve) => setTimeout(resolve, 40)));
  const second = queue.run(() => Promise.resolve('второе'));

  assert.equal(await first, undefined, 'первая задача выполнена');
  assert.equal(await second, 'второе');
  assert.deepEqual(queue.stats(), { running: 0, waiting: 0, parallel: 1, capacity: 2 });
});

test('регистрация при переполненной очереди отвечает «сервис занят»', async () => {
  const pool = { query: async () => ({ rows: [] }), on: () => {} };
  // Очереди без места: задача, которой не нашлось слота, отказывает.
  const hashQueue = createHashQueue({ parallel: 1, capacity: 0, waitMs: 50 });
  // Слот занят — иначе задача регистрации нашла бы его свободным и была бы
  // выполнена сразу, а очередь так и не понадобилась бы.
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const blocker = hashQueue.run(() => blocked);
  const app = createApp({
    data: stubData(),
    auth: stubAuthStore({}),
    sessionMw: createSessionMiddleware(pool, createMemorySessionStore()),
    hashQueue,
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let jar = '';

  try {
    const send = async (path, init = {}) => {
      const res = await fetch(base + path, {
        redirect: 'manual',
        ...init,
        headers: { cookie: jar, ...(init.headers ?? {}) },
      });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) jar = set.map((c) => c.split(';')[0]).join('; ');
      return res;
    };
    const page = await (await send('/ru/register')).text();
    const fields = {
      csrf: page.match(/name="csrf" value="([^"]+)"/)?.[1],
      email: 'anna@example.com',
      nickname: 'anna',
      password: PASSWORD,
      consent: 'on',
      timezone: 'Europe/Minsk',
    };
    const challenge = page.match(/data-challenge="([^"]+)"/)?.[1];
    if (challenge) {
      const zeros = Number(page.match(/data-zeros="([^"]+)"/)?.[1] ?? 3);
      for (let nonce = 0; ; nonce += 1) {
        if (sha256(challenge + nonce).startsWith('0'.repeat(zeros))) {
          fields.pow = String(nonce);
          break;
        }
      }
    }

    const res = await send('/ru/register', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
    const body = await res.text();

    assert.equal(res.status, 429, 'занятость сервиса — это 429, а не ошибка');
    assert.equal(res.headers.get('retry-after'), '60');
    assert.match(body, /Сервис занят, попробуйте через минуту/);
  } finally {
    release();
    await blocker;
    limits._reset();
    await new Promise((r) => server.close(r));
  }
});
