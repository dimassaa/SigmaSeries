// Служебные страницы и страницы ошибок (F-00-05, S-40…S-43).
//
// Проверяется по HTTP: страницы должны отвечать своим кодом, не содержать
// внутренних деталей и быть доступны без входа.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

async function withServer(run) {
  const app = createApp({ data: stubData() });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({
      get: (path) => fetch(base + path, { redirect: 'manual' }),
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('служебные страницы отвечают 200 и содержат свой текст', async () => {
  await withServer(async ({ get }) => {
    const about = await get('/ru/about');
    assert.equal(about.status, 200);
    const aboutHtml = await about.text();
    assert.match(aboutHtml, /О проекте и данных/);
    assert.match(aboutHtml, /IMDb/);
    // Атрибуция TMDB обязательна по условиям использования (F-00-05 §8д).
    assert.match(aboutHtml, /TMDB/);

    const rules = await get('/ru/rules');
    assert.equal(rules.status, 200);
    assert.match(await rules.text(), /Правила сообщества/);

    const privacy = await get('/ru/privacy');
    assert.equal(privacy.status, 200);
    assert.match(await privacy.text(), /Конфиденциальность/);

    // Английская версия отдаётся по английскому адресу.
    const english = await get('/en/about');
    assert.equal(english.status, 200);
    assert.match(await english.text(), /About the project/);
  });
});

test('страница ошибки отвечает 404, без внутренних деталей и с тремя подсказками', async () => {
  await withServer(async ({ get }) => {
    const res = await get('/ru/no-such-page');
    assert.equal(res.status, 404, 'не «200 с текстом ошибки» (F-00-05 §8б)');
    const html = await res.text();
    assert.match(html, /noindex/);
    assert.ok(!/SELECT|stack|at Object|pg_/i.test(html), 'внутренних деталей в тексте нет');
    assert.match(html, /\/ru\/series/, 'подсказка «в каталог»');
    assert.match(html, /\/ru\/search/, 'подсказка «поиск»');
    // Ссылки на служебные страницы есть и на странице ошибки (F-00-05 §8в).
    assert.match(html, /\/ru\/about/);
    assert.match(html, /\/ru\/privacy/);
  });
});
