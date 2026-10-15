// Разметка: html, when, экранирование.
//
// `when` проверяется отдельно от остального: третий аргумент («иначе») молча
// игнорировался, и места, где он написан, выглядели недоделанными — заглушка
// фона сериала и подпись «описания пока нет» просто не появлялись, и по
// исходникам это было не видно.

import test from 'node:test';
import assert from 'node:assert/strict';

import { html, raw, when, esc } from '../src/view/render.js';

test('пользовательский текст экранируется', () => {
  const body = html`<p>${'<script>alert(1)</script>'}</p>`;
  assert.ok(!body.__raw.includes('<script>'), 'чужие теги не исполняются');
  assert.match(body.__raw, /&lt;script&gt;/);
});

test('when без условия не выводит ничего лишнего', () => {
  assert.equal(when(false, () => html`<p>да</p>`).__raw, '');
  assert.equal(when(true, () => html`<p>да</p>`).__raw, '<p>да</p>');
});

test('when с веткой «иначе» показывает её, а не молчит', () => {
  assert.equal(
    when(false, () => html`<p>есть</p>`, () => html`<p class="empty">нет</p>`).__raw,
    '<p class="empty">нет</p>',
  );
  assert.equal(
    when(true, () => html`<p>есть</p>`, () => html`<p class="empty">нет</p>`).__raw,
    '<p>есть</p>',
    'при истинном условии ветка «иначе» не показывается',
  );
});

test('вложенная разметка в when не экранируется', () => {
  const inner = html`<span>${'да'}</span>`;
  assert.equal(when(true, () => html`<p>${inner}</p>`).__raw, '<p><span>да</span></p>');
});

test('raw вставляется как есть', () => {
  assert.equal(html`<p>${raw('<b>жирно</b>')}</p>`.__raw, '<p><b>жирно</b></p>');
});

test('esc экранирует спецсимволы', () => {
  assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});