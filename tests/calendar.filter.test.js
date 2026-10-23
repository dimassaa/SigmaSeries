// Фильтр календаря (F-03-05, S-16): «Все» не должно превращаться в «Мои».
//
// Ошибка была не в запросе, а в маршруте: вошедшему посетителю `userId`
// передавался при любом фильтре. База честно сужала выдачу до его подписок,
// и человек без подписок видел пустой календарь, хотя выходы есть.

import test from 'node:test';
import assert from 'node:assert/strict';

import express from 'express';

import { createCalendarRoutes } from '../src/routes/calendar.js';

const USER_ID = 42;

/** Приложение только с календарём: остальные маршруты здесь не нужны. */
async function withCalendar(run) {
  const seen = [];
  const app = express();
  app.use((req, res, next) => {
    req.session = { user: { id: USER_ID } };
    req.account = null;
    next();
  });
  app.use(createCalendarRoutes({
    calendar: {
      days: async (options) => {
        seen.push(options);
        return {
          from: options.from,
          to: options.to,
          days: new Map(),
          total: 0,
          truncated: false,
        };
      },
    },
  }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('сервер не сообщил TCP-адрес');
  }
  try {
    await run(`http://127.0.0.1:${address.port}`, seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('«Все» не сужает календарь до подписок вошедшего', async () => {
  await withCalendar(async (baseUrl, seen) => {
    const response = await fetch(`${baseUrl}/ru/calendar`);

    assert.equal(response.status, 200);
    assert.equal(seen.length, 1, 'источник спрошен один раз');
    assert.equal(seen[0].userId, null, 'фильтр «Все» не передаёт пользователя');
  });
});

test('«Мои» по-прежнему спрашивает подписки вошедшего', async () => {
  await withCalendar(async (baseUrl, seen) => {
    const response = await fetch(`${baseUrl}/ru/calendar?filter=mine`);

    assert.equal(response.status, 200);
    assert.equal(seen[0].userId, USER_ID, 'фильтр «Мои» передаёт пользователя');
  });
});
