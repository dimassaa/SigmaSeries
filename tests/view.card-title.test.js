// Цепочка названий карточек (№269).
//
// `cardTitleOf` — один хелпер для всех сеток постеров: название выбирается
// по локали (en → ru → оригинал), а заимствованное из другого языка —
// с пометкой `lang` (R-I18N-06). Проверяется на подставных данных: базы не нужно.

import test from 'node:test';
import assert from 'node:assert/strict';

import { cardTitleOf } from '../src/view/collection.js';

const item = {
  slug: 'north-wind',
  titleRu: 'Северный ветер',
  titleEn: 'North Wind',
  titleOriginal: 'Northwind',
};

test('EN-карточка показывает перевод, когда он есть', () => {
  assert.deepEqual(cardTitleOf('en', item), { text: 'North Wind', lang: null });
});

test('RU-карточка показывает русское название', () => {
  assert.deepEqual(cardTitleOf('ru', item), { text: 'Северный ветер', lang: null });
});

test('без перевода EN берёт русское название и помечает язык', () => {
  assert.deepEqual(cardTitleOf('en', { ...item, titleEn: null }),
    { text: 'Северный ветер', lang: 'ru' });
});

test('без русского RU берёт EN-название и помечает язык', () => {
  assert.deepEqual(cardTitleOf('ru', { ...item, titleRu: null }),
    { text: 'North Wind', lang: 'en' });
});

test('без обоих переводов — оригинальное название', () => {
  assert.deepEqual(cardTitleOf('en', { ...item, titleEn: null, titleRu: null }),
    { text: 'Northwind', lang: null });
  assert.deepEqual(cardTitleOf('ru', { ...item, titleEn: null, titleRu: null }),
    { text: 'Northwind', lang: null });
});

test('пустые строки в базе считаются «перевода нет»', () => {
  assert.deepEqual(cardTitleOf('en', { ...item, titleEn: '', titleRu: '  ' }),
    { text: 'Northwind', lang: null });
});

test('названий нет вовсе — подпись из адреса, ссылка не безымянная', () => {
  assert.deepEqual(
    cardTitleOf('en', { slug: 'north-wind', titleRu: null, titleEn: null, titleOriginal: null }),
    { text: 'north-wind', lang: null },
  );
});
