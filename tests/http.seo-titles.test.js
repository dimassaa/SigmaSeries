// Титулы статей, тем и месяца календаря по таблице SEO §2 (№259).
//
// Проверяется то, что обещает выдаче поисковика: заголовок руководства
// содержит название сериала, тема обсуждения — тоже, месяц календаря —
// «Календарь выхода серий — {месяц год}». Название для первых двух страниц
// возвращает источник: маршрут не должен ходить в базу вторым запросом.
//
// Источники — заглушки: проверяется сборка заголовка маршрутом, а не база.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';

const NOW = new Date('2026-11-13T12:00:00Z');

const guideStub = {
  async one(slug) {
    return {
      id: 1,
      slug,
      title: 'Как смотреть',
      excerpt: 'Короткое описание статьи.',
      body: '## Раздел\nТекст раздела, достаточный по правилам публикации.',
      spoiler: false,
      createdAt: NOW,
      author: 'босс',
      authorStatus: 'active',
      sections: [{ heading: 'Раздел', text: 'Текст раздела, достаточный по правилам публикации.' }],
      seriesId: 10,
      seriesSlug: 'walking',
      seriesTitle: 'Ходячие',
    };
  },
  async list() {
    return { rows: [], total: 0, page: 1, pages: 1 };
  },
};

const discussionStub = {
  async topic(id) {
    return {
      id,
      title: 'Теория второго сезона',
      body: 'Текст темы, достаточной длины, чтобы про проверку словаря.',
      spoiler: false,
      createdAt: NOW,
      author: 'босс',
      authorId: 1,
      authorStatus: 'active',
      posts: [],
      pinned: false,
      totalPosts: 0,
      seriesId: 10,
      seriesSlug: 'walking',
      seriesTitle: 'Ходячие',
    };
  },
  async listForSeries() {
    return { rows: [], total: 0, page: 1, pages: 1 };
  },
};

const calendarStub = {
  async days() {
    return { days: new Map(), total: 0, truncated: false };
  },
};

let server;
let baseUrl;

test.before(async () => {
  const app = createApp({
    data: stubData(),
    guides: guideStub,
    discussions: discussionStub,
    calendar: calendarStub,
    now: () => NOW.getTime(),
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve(undefined);
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

const get = async (path) => {
  const res = await fetch(baseUrl + path);
  return res.text();
};

test('заголовок руководства содержит название сериала (№259)', async () => {
  const html = await get('/ru/guides/kak-smotret');
  assert.match(html, /<title>Как смотреть — Ходячие · /,
    'SEO §2: «{Заголовок руководства} — {Название}»');
});

test('заголовок темы содержит название сериала (№259)', async () => {
  const html = await get('/ru/discussions/7');
  assert.match(html, /<title>Теория второго сезона — обсуждение «Ходячие» · /,
    'SEO §2: «{Тема} — обсуждение «{Название}»»');
});

test('заголовок месяца календаря строится из данных (№259)', async () => {
  const html = await get('/ru/calendar');
  assert.match(html,
    /<title>Календарь выхода серий — \S+ 2026( г\.)? · /,
    'SEO §2: «Календарь выхода серий — {месяц год}»');
});
