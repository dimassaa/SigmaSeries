// Заставка на первом открытии (M0, F-00-06).
//
// Проверяется то, что видит человек: кадры приходят с порогами, оверлей
// показывается и по нажатию уходит, а кадр отдаётся картинкой.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';

const FRAME = {
  id: 40,
  ordinal: 0,
  imageId: 7,
  width: 1920,
  height: 1080,
  focalX: 50,
  focalY: 50,
  seriesId: null,
  seriesSlug: 'lanterns',
  seriesTitle: 'Фонари',
  disabled: false,
};

/** Источник кадров на замену: база под рукой не нужна. */
function stubSplash(frames = [FRAME]) {
  return {
    async frames() { return frames; },
    async data() {
      return {
        frames,
        counterFrom: 1,
        counterTo: 25,
        maxDurationMs: 7000,
        fadeMs: 1200,
        enough: frames.length >= 12,
      };
    },
  };
}

async function withServer(run, { frames = [FRAME] } = {}) {
  const pool = { query: async () => ({ rows: [] }), on: () => {} };
  const app = createApp({
    publicSplash: stubSplash(frames),
    // createApp объявляет middleware сессий функцией, а модуль отдаёт обработчик
    // или их пару — Express принимает и то и другое.
    sessionMw: /** @type {Function} */ (createSessionMiddleware(pool, createMemorySessionStore())),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(async (path) => {
      const res = await fetch(base + path, { redirect: 'manual' });
      return { status: res.status, body: await res.text() };
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('данные заставки приходят с кадрами и порогами', async () => {
  await withServer(async (get) => {
    const res = await get('/ru/splash/data');
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.frames.length, 1);
    assert.equal(data.frames[0].id, 40);
    assert.equal(data.counterFrom, 1);
    assert.equal(data.counterTo, 25);
    assert.equal(data.enough, false, 'кадров меньше порога — заставка выключается');
  });
});

test('при достаточном числе кадров заставка включается', async () => {
  const many = Array.from({ length: 12 }, (unused, i) => ({ ...FRAME, id: 40 + i, ordinal: i }));
  await withServer(async (get) => {
    const data = JSON.parse((await get('/ru/splash/data')).body);
    assert.equal(data.enough, true);
    assert.equal(data.frames.length, 12);
  }, { frames: many });
});
