// HTTP-слой: первый отдаваемый экран S-01.
// Спецификация: docs/01-product/features/M6-home.md, F-06-01…F-06-06.
// Правила: R-SEO-01…03, R-SEO-07, R-I18N-01/02/07, R-A11Y-01/04, ADR-003.
//
// Тесты поднимают настоящий сервер на случайном порту и ходят по нему
// fetch'ем из стандартной библиотеки. Никаких тестовых зависимостей:
// supertest в списке разрешённого нет, а проверять надо настоящий HTTP,
// а не вызовы обработчиков с поддельными req и res.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';

const RU = 'http://127.0.0.1';

/** Поднимает сервер на свободном порту и отдаёт функцию get. */
async function withApp(data, run) {
  const app = createApp({ data });
  const server = await new Promise((res) => {
    const s = app.listen(0, '127.0.0.1', () => res(s));
  });
  const { port } = server.address();
  try {
    await run((path, init) => fetch(`${RU}:${port}${path}`, { redirect: 'manual', ...init }));
  } finally {
    await new Promise((res) => server.close(res));
  }
}

// ─── Локаль в адресе (ADR-003, R-SEO-01) ──────────────────────────────────────

test('корень уводит на русский независимо от языка браузера', async () => {
  await withApp(stubData(), async (get) => {
    const res = await get('/', { headers: { 'accept-language': 'en-US,en;q=0.9' } });
    assert.equal(res.status, 301, 'русский по умолчанию всегда, даже при Accept-Language');
    assert.equal(res.headers.get('location'), '/ru/');
  });
});

test('путь без слеша закрывается слешем', async () => {
  // Иначе /ru и /ru/ — два разных адреса для одного экрана.
  await withApp(stubData(), async (get) => {
    const res = await get('/ru', { headers: { 'accept-language': 'en' } });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/ru/');
  });
});

test('неизвестная локаль даёт 404, а не молчаливый редирект', async () => {
  // Молча перекидывать на русский значит отдавать 200 по чужому адресу:
  // и адрес неправильный, и поисковик увидит дубль.
  await withApp(stubData(), async (get) => {
    const res = await get('/de/');
    assert.equal(res.status, 404);
  });
});

// ─── Содержимое в начальном HTML (R-SEO-07) ──────────────────────────────────

test('главная отдаёт 200 и русский текст без выполнения скриптов', async () => {
  await withApp(stubData(), async (get) => {
    const res = await get('/ru/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /<html[^>]+lang="ru"/);
    assert.match(html, /Новинки/, 'русский текст должен быть в ответе, а не после JS');
  });
});

test('блоки главной идут в порядке из спецификации', async () => {
  // input/spec.md задаёт порядок: баннеры → свежее → подборки → жанры.
  await withApp(stubData(), async (get) => {
    const html = await (await get('/ru/')).text();
    const order = ['Баннеры', 'Новинки', 'Подборки', 'Жанры'].map((t) => html.indexOf(t));
    for (const [i, pos] of order.entries()) {
      if (pos < 0) continue;
      const later = order.slice(i + 1).filter((p) => p >= 0);
      assert.ok(later.every((p) => p > pos), `блок нарушает порядок: ${i}`);
    }
  });
});

test('английская версия отдаётся с lang="en"', async () => {
  await withApp(stubData(), async (get) => {
    const res = await get('/en/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<html[^>]+lang="en"/);
    assert.match(html, /Fresh releases|Trending/i);
  });
});

// ─── Переключатель языка (условие DEC-026) ────────────────────────────────────

test('на каждой странице есть переключатель на другой язык', async () => {
  // Ответ руководителя: английский разрешён при условии переключателя на
  // русский. Условие выполняется только если ссылка есть на каждом экране.
  await withApp(stubData(), async (get) => {
    const ru = await (await get('/ru/')).text();
    assert.match(ru, /href="\/ru\/"[^>]*aria-current/, 'на русской — сам на себя');
    assert.match(ru, /href="\/en\/"/);
    const en = await (await get('/en/')).text();
    assert.match(en, /href="\/ru\/"/, 'переключение на русский обязательно');
    assert.match(en, /href="\/en\/"[^>]*aria-current/);
  });
});

// ─── SEO ──────────────────────────────────────────────────────────────────────

test('канонический адрес и hreflang заданы (R-SEO-02, R-SEO-03)', async () => {
  await withApp(stubData(), async (get) => {
    const html = await (await get('/ru/')).text();
    const canonical = [...html.matchAll(/<link[^>]+rel="canonical"[^>]*>/g)].map((m) => m[0]);
    assert.equal(canonical.length, 1, 'канонический адрес должен быть ровно один');
    assert.match(canonical[0], /\/ru\//);
    for (const lang of ['ru', 'en']) {
      assert.match(html, new RegExp(`hreflang="${lang}"`), `нет ссылки на ${lang}`);
    }
    assert.match(html, /hreflang="x-default"/);
  });
});

test('служебные разделы закрыты от индексации (R-SEO-06)', async () => {
  await withApp(stubData(), async (get) => {
    const res = await get('/ru/search');
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, follow');
  });
});

test('robots.txt закрывает админский раздел', async () => {
  await withApp(stubData(), async (get) => {
    const body = await (await get('/robots.txt')).text();
    assert.match(body, /^Disallow: .*\/admin/m);
    assert.match(body, /Sitemap:/);
  });
});

// ─── Доступность ──────────────────────────────────────────────────────────────

test('есть ссылка «перейти к содержимому» и один заголовок h1', async () => {
  await withApp(stubData(), async (get) => {
    const html = await (await get('/ru/')).text();
    assert.match(html, /class="skip-link"/);
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, 'h1 на странице ровно один');
    assert.match(html, /<main/);
    assert.match(html, /<nav/);
  });
});

test('у каждой карточки есть осмысленная подпись, а не только картинка', async () => {
  await withApp(stubData({
    banners: async () => [
      { seriesSlug: 's1', title: 'Сериал', reason: 'new', year: 2026, yearRange: '2026', imdb: '9,1' },
    ],
  }), async (get) => {
    const html = await (await get('/ru/')).text();
    assert.match(html, /aria-label="[^"]*Новинка[^"]*"/);
  });
});

// ─── Экранирование ────────────────────────────────────────────────────────────

test('название сериала с тегами экранируется', async () => {
  const nasty = '<script>alert(1)</script>';
  await withApp(stubData({ fresh: async () => [{ slug: 'x', title: nasty, year: 2026 }] }), async (get) => {
    const html = await (await get('/ru/')).text();
    assert.ok(!html.includes(nasty), 'сырой HTML в ответе быть не должно');
    assert.match(html, /&lt;script&gt;/);
  });
});

test('значение из данных не может закрыть атрибут', async () => {
  const nasty = '" onmouseover="alert(1)';
  await withApp(stubData({ fresh: async () => [{ slug: 'x', title: nasty, year: 2026 }] }), async (get) => {
    const html = await (await get('/ru/')).text();
    assert.ok(!html.includes('onmouseover="alert'), 'инъекция в атрибут не прошла');
  });
});

// ─── Пустое состояние ─────────────────────────────────────────────────────────

test('пустой каталог даёт объяснение, а не пустую страницу', async () => {
  await withApp(stubData(), async (get) => {
    const html = await (await get('/ru/')).text();
    assert.match(html, /пока пусто|Пока пусто/, 'нужно объяснение, а не тишина');
    assert.ok(!html.includes('NaN'), 'числа не должны превращаться в NaN');
  });
});

test('признак демо-данных на главной не показывается', async () => {
  // Главная публична; метка «демо» относится к аналитике (M8), не сюда.
  await withApp(stubData(), async (get) => {
    const html = await (await get('/ru/')).text();
    assert.ok(!/демо-данн/i.test(html));
  });
});

// ─── Ошибки ───────────────────────────────────────────────────────────────────

test('неизвестный путь даёт 404 с настоящей страницей', async () => {
  await withApp(stubData(), async (get) => {
    const res = await get('/ru/такой-страницы');
    assert.equal(res.status, 404);
    assert.match(await res.text(), /lang="ru"/);
  });
});

test('страница ошибки не раскрывает внутренности (R-SEC-33)', async () => {
  const broken = stubData();
  broken.fresh = () => { throw new Error('подробности соединения с 10.0.0.5'); };
  await withApp(broken, async (get) => {
    const res = await get('/ru/');
    assert.equal(res.status, 500);
    const html = await res.text();
    assert.ok(!html.includes('10.0.0.5'), 'внутренние детали в ответе быть не должно');
    assert.match(html, /Что-то пошло не так|ошибка/i);
  });
});

// ─── Стили ────────────────────────────────────────────────────────────────────

test('таблица стилей отдаётся одной ссылкой и одним файлом', async () => {
  // Требование «одна каскадная таблица стилей»: пользователю отдаётся один
  // файл, собранный из частей на этапе сборки.
  await withApp(stubData(), async (get) => {
    const html = await (await get('/ru/')).text();
    const links = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map((m) => m[0]);
    assert.equal(links.length, 1, 'стилей должен быть ровно один');
    const href = links[0].match(/href="([^"]+)"/)[1];
    const css = await get(href);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
  });
});

test('цвет задаётся токеном, а не прямо в разметке', async () => {
  await withApp(stubData(), async (get) => {
    const html = await (await get('/ru/')).text();
    // В разметке цвета быть не должно вообще: тему не переключить.
    assert.ok(!/style="[^"]*#[0-9a-f]{3,6}/i.test(html), 'цвета в инлайн-стилях запрещены');
    assert.ok(!/<style[\s>]/i.test(html), 'встроенного <style> быть не должно');

    // Токены определены в таблице, и обе темы описаны в одном файле.
    const css = await (await get('/app.css')).text();
    assert.match(css, /--accent:/);
    assert.match(css, /\[data-theme='light'\]/);
    assert.match(css, /\[data-theme='dark'\]/);
    assert.match(css, /--focus|outline: 2px solid var\(--accent\)/);
  });
});

test('собранная таблица одна и собрана из частей', async () => {
  await withApp(stubData(), async (get) => {
    const css = await (await get('/app.css')).text();
    const parts = (css.match(/─── (\d\d-[a-z-]+\.css) ───/g) ?? []);
    assert.ok(parts.length >= 5, `частей в сб��рке: ${parts.length}`);
    // Порядок обязателен: токены должны быть раньше, чем их использующие.
    assert.ok(css.indexOf('00-tokens.css') < css.indexOf('10-base.css'));
  });
});