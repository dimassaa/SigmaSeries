// Публичный профиль (S-18, F-01-07) через настоящий HTTP.
//
// Проверяется то, что человек видит: шапку, вкладки, закрытые по умолчанию
// части профиля и отказы для несуществующего и удалённого аккаунта.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { reviewMeta } from '../src/view/reviewList.js';

const USER = {
  id: 7,
  nickname: 'Иван',
  status: 'active',
  registeredAt: '2026-03-14T10:00:00.000Z',
  statsPublic: false,
  profilePublic: false,
};

const REVIEW = {
  id: 11,
  title: null,
  slug: null,
  spoiler: false,
  createdAt: '2026-05-02T12:00:00.000Z',
  lang: 'ru',
  excerpt: 'Отзыв о сериале',
  seriesId: 3,
  seriesSlug: 'test-series',
  seriesTitle: 'Тестовый сериал',
};

const GUIDE = {
  id: 12,
  title: 'Как смотреть',
  slug: 'how-to-watch',
  spoiler: false,
  createdAt: '2026-05-03T12:00:00.000Z',
  lang: 'ru',
  excerpt: 'Руководство по сериалу',
  seriesId: 3,
  seriesSlug: 'test-series',
  seriesTitle: 'Тестовый сериал',
};

/** Сервис профиля на замену: база под рукой не нужна. */
function stubProfile(user = USER) {
  return {
    async byNickname(nickname) {
      const wanted = String(nickname ?? '').toLowerCase();
      if (!user || user.nickname.toLowerCase() !== wanted) return null;
      return user;
    },
    async counts() {
      return { review: 2, guide: 1 };
    },
    async materials(userId, kind, { page = 1 } = {}) {
      const items = kind === 'guide' ? [GUIDE] : [REVIEW];
      return { items, total: items.length, page, pages: 1 };
    },
    async statistics() {
      return { marked: 5, ratings: 9, reviews: 2 };
    },
    async marked() {
      return {
        items: [{ id: 3, slug: 'test-series', title: 'Тестовый сериал', status: 'watched', changedAt: '2026-05-01T00:00:00.000Z' }],
        total: 1,
        page: 1,
        pages: 1,
      };
    },
  };
}

async function withServer(run, user = USER) {
  const pool = { query: async () => ({ rows: [] }), on: () => {} };
  const app = createApp({
    data: stubData(),
    profile: stubProfile(user),
    sessionMw: createSessionMiddleware(pool, createMemorySessionStore()),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(async (path) => {
      const res = await fetch(base + path, { redirect: 'manual' });
      return { status: res.status, headers: res.headers, body: await res.text() };
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('профиль показывает ник, дату регистрации и работы', async () => {
  await withServer(async (get) => {
    const res = await get('/ru/u/%D0%98%D0%B2%D0%B0%D0%BD');

    assert.equal(res.status, 200);
    assert.match(res.body, /Иван/);
    assert.match(res.body, /март 2026/, 'дата регистрации названа месяцем и годом');
    assert.match(res.body, /Отзыв о сериале/);
    assert.match(res.body, /Тестовый сериал/);
  });
});

test('профиль личный: он не отдаётся поиску', async () => {
  await withServer(async (get) => {
    const res = await get('/ru/u/Иван');
    assert.match(res.body, /<meta name="robots" content="noindex, follow">/);
  });
});

test('ник ищется без учёта регистра', async () => {
  await withServer(async (get) => {
    const res = await get('/ru/u/иван');
    assert.equal(res.status, 200);
    assert.match(res.body, /Иван/);
  });
});

test('чужого профиля нет — 404', async () => {
  await withServer(async (get) => {
    const res = await get('/ru/u/никого');
    assert.equal(res.status, 404);
  });
});

test('негодный ник — тоже 404, а не ошибка ввода', async () => {
  await withServer(async (get) => {
    const res = await get('/ru/u/ab');
    assert.equal(res.status, 404);
  });
});

test('закрытая по умолчанию приватность не показывается', async () => {
  await withServer(async (get) => {
    const res = await get('/ru/u/Иван');

    assert.doesNotMatch(res.body, /Статистика/, 'статистики нет без разрешения');
    assert.doesNotMatch(res.body, /Отмеченные сериалы/, 'списка отмеченного нет');
  });
});

test('открытая приватность показывает статистику и отмеченное', async () => {
  const open = { ...USER, statsPublic: true, profilePublic: true };
  await withServer(async (get) => {
    const res = await get('/ru/u/Иван');

    assert.match(res.body, /Статистика/);
    assert.match(res.body, /Отмеченные сериалы/);
    assert.match(res.body, /Тестовый сериал/);
  }, open);
});

test('удалённый аккаунт отвечает «Пользователь удалён»', async () => {
  const gone = { ...USER, nickname: 'удалённый-7', status: 'deleted' };
  await withServer(async (get) => {
    const res = await get('/ru/u/удалённый-7');

    assert.equal(res.status, 200);
    assert.match(res.body, /Пользователь удалён/);
    assert.doesNotMatch(res.body, /Отзыв о сериале/, 'материалы удалённого не показываются');
  }, gone);
});

test('вкладка руководств показывает руководства', async () => {
  await withServer(async (get) => {
    const res = await get('/ru/u/Иван?tab=guides');

    assert.equal(res.status, 200);
    assert.match(res.body, /Как смотреть/);
    assert.doesNotMatch(res.body, /Отзыв о сериале/);
  });
});

test('ник автора в чужом месте ведёт на профиль', () => {
  const markup = reviewMeta({
    locale: 'ru',
    item: {
      id: 1,
      authorNickname: 'Иван',
      authorStatus: 'active',
      authorRating: 7,
      createdAt: '2026-05-02T12:00:00.000Z',
      lang: 'ru',
    },
  }).__raw;

  assert.match(markup, /href="\/ru\/u\/%D0%98%D0%B2%D0%B0%D0%BD"/, 'ник ведёт на профиль');
});

test('ник удалённого автора — текст, а не ссылка', () => {
  const markup = reviewMeta({
    locale: 'ru',
    item: {
      id: 1,
      authorNickname: 'удалённый-7',
      authorStatus: 'deleted',
      authorRating: null,
      createdAt: '2026-05-02T12:00:00.000Z',
      lang: 'ru',
    },
  }).__raw;

  assert.doesNotMatch(markup, /\/u\//, 'ссылки на профиль нет');
  assert.match(markup, /Пользователь удалён/);
});
