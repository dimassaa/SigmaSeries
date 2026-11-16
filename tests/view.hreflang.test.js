// Альтернативные языки в каркасе (R-SEO-03, R-SEO-04, №268).
//
// hreflang на закрытую страницу звал робота на дубль русского текста:
// альтернатива EN рисуется только тогда, когда EN-версия индексируется.
// Видимый переключатель языка — навигация для человека, он остаётся всегда.

import test from 'node:test';
import assert from 'node:assert/strict';

import { layout } from '../src/view/layout.js';

const PAGE = { locale: 'ru', title: 'Заголовок', description: 'Описание', path: '/series/probe' };

test('по умолчанию обе языковые альтернативы на месте (R-SEO-03)', () => {
  const html = layout({ ...PAGE }).__raw;
  assert.match(html, /<link rel="alternate" hreflang="ru"/);
  assert.match(html, /<link rel="alternate" hreflang="en"/);
  assert.match(html, /<link rel="alternate" hreflang="x-default"/);
});

test('закрытая EN-альтернатива не рисуется, русская и x-default остаются (R-SEO-04)', () => {
  const html = layout({ ...PAGE, enIndexable: false }).__raw;
  assert.ok(!/<link rel="alternate" hreflang="en"/.test(html),
    'hreflang на неиндексируемую EN-страницу не нужен');
  assert.match(html, /<link rel="alternate" hreflang="ru"/, 'русская альтернатива на месте');
  assert.match(html, /<link rel="alternate" hreflang="x-default"/,
    'x-default по-прежнему ведёт в русскую версию');
  assert.match(html, /topbar__lang/, 'видимый переключатель языка остаётся');
});

test('на закрытой EN-странице альтернативы её самой тоже нет (R-SEO-04)', () => {
  const html = layout({ ...PAGE, locale: 'en', noindex: true, enIndexable: false }).__raw;
  assert.match(html, /name="robots" content="noindex, follow"/);
  assert.ok(!/<link rel="alternate" hreflang="en"/.test(html),
    'страница не объявляет hreflang на саму себя, когда не индексируется');
  assert.match(html, /<link rel="alternate" hreflang="ru"/,
    'русская версия открыта — ссылка на неё остаётся');
});
