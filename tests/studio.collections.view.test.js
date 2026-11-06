// Разметка списка подборок студии (S-77, F-10-07).
//
// Состояние приходит из источника готовым («Опубликована» / «Скрыта
// автоматически» / «Черновик», §6 фичи и EC-C6): страница не решает сама,
// видима подборка или нет — иначе на экране появлялся бы статус, которым
// публичная выдача не живёт. Проверяется то, что нельзя позволить: сырые
// коды причин ('few_series') и обманывающее имя состояния на строке.

import test from 'node:test';
import assert from 'node:assert/strict';

import { studioCollectionsView } from '../src/view/studioCollections.js';

/**
 * Строка списка — форма совпадает с выдачей источника.
 *
 * @param {Partial<import('../src/view/studioCollections.js').StudioCollectionSummary>} [over]
 *   отклонения от базовой строки
 * @returns {import('../src/view/studioCollections.js').StudioCollectionSummary}
 */
function row(over) {
  return {
    id: 7,
    slug: 'mark',
    title: 'Проверка',
    titleEn: null,
    description: null,
    descriptionEn: null,
    weight: 3,
    active: true,
    isDemo: false,
    visibleSeries: 6,
    totalSeries: 6,
    publishBlockers: [],
    state: 'published',
    ...over,
  };
}

/**
 * Разметка вида строкой.
 *
 * @param {import('../src/view/studioCollections.js').StudioCollectionSummary[]} list
 * @returns {string}
 */
function markup(list) {
  return String(studioCollectionsView({ locale: 'ru', list }).__raw);
}

test('опубликованная подборка так и названа на строке', () => {
  const page = markup([row()]);
  assert.ok(page.includes('Опубликована'), 'имя состояния на строке');
});

test('подборка, севшая ниже порога, названа «Скрыта автоматически»', () => {
  const page = markup([row({ active: true, visibleSeries: 5, totalSeries: 5, state: 'auto_hidden' })]);
  assert.ok(page.includes('Скрыта автоматически'),
    'EC-C6: на строке пометка, а не «Опубликована»');
  assert.ok(!page.includes('few_series'), 'сырые коды причин на страницу не попадают');
});

test('вручную скрытая подборка — «Черновик»', () => {
  const page = markup([row({ active: false, state: 'draft' })]);
  assert.ok(page.includes('Черновик'));
});

test('состояния подписаны по-английски, когда экран на английском', () => {
  const page = String(studioCollectionsView({
    locale: 'en',
    list: [row(), row({ state: 'auto_hidden' }), row({ active: false, state: 'draft' })],
  }).__raw);
  assert.ok(page.includes('Hidden automatically'));
  assert.ok(page.includes('Draft'));
  assert.ok(!page.includes('few_series'));
});
