// Разметка списка подборок студии (S-77, F-10-07).
//
// Состояние приходит из источника готовым («Опубликована» / «Скрыта
// автоматически» / «Черновик», §6 фичи и EC-C6): страница не решает сама,
// видима подборка или нет — иначе на экране появлялся бы статус, которым
// публичная выдача не живёт. Проверяется то, что нельзя позволить: сырые
// коды причин ('few_series') и обманывающее имя состояния на строке.

import test from 'node:test';
import assert from 'node:assert/strict';

import { studioCollectionsView, studioCollectionView } from '../src/view/studioCollections.js';

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

test('в списке есть вход на создание — единственная, где пусто (№246)', () => {
  const page = markup([row()]);
  assert.ok(page.includes('/ru/admin/collections/new'),
    'создание доступно в один переход со списка');
  assert.ok(page.includes('Создать'));
});

test('форма создания пустая, но с теми же полями и запретом пустого названия', () => {
  const page = String(studioCollectionView({ locale: 'ru', collection: null }).__raw);
  assert.ok(page.includes('/ru/admin/collections/new'),
    'форма отправляется на адрес создания, а не на правку без slug');
  assert.ok(page.includes('Новая подборка'));
  assert.ok(/name="title_ru"[^>]*required/.test(page), 'название ru обязательное');
  assert.ok(/name="weight"[^>]*value="0"/.test(page), 'вес — выбранное ноль для старта');
  assert.ok(!/name="active"[^>]*checked/.test(page), 'создание начинается черновиком');
  assert.ok(!page.includes('name="series_ids"'), 'сериals добавляются уже в правке');
});

test('форма создания показывает список причин в словах, не кодами', () => {
  const page = String(studioCollectionView({ locale: 'ru', collection: null }).__raw);
  assert.ok(page.includes('Видимых сериалов меньше шести'),
    'причина «мало» названа словами рядом с формой');
  assert.ok(!page.includes('few_series'), 'сырые коды на страницу не попадают');
});

/**
 * Полная строка правки — состав как у источника.
 *
 * @param {Partial<import('../src/view/studioCollections.js').StudioCollection>} [over]
 *   отклонения от базовой подборки
 * @returns {import('../src/view/studioCollections.js').StudioCollection}
 */
function full(over) {
  return {
    id: 7,
    slug: 'check-edit',
    title: 'Правка',
    titleEn: null,
    description: 'Описание.',
    descriptionEn: null,
    weight: 3,
    active: false,
    isDemo: false,
    hasBanner: false,
    visibleSeries: 0,
    publishBlockers: ['no_banner'],
    items: [],
    ...over,
  };
}

test('у черновика адрес правится: поле с текущим значением, без заморозки (№249)', () => {
  const page = String(studioCollectionView({ locale: 'ru', collection: full() }).__raw);
  assert.ok(page.includes('name="slug"'), 'поле адреса на форме правки');
  assert.ok(page.includes('value="check-edit"'), 'адрес предзаполнен текущим');
  assert.ok(!page.includes('readonly'), 'черновику заморозка не нужна');
  assert.ok(page.includes('Латиница, цифры'), 'правило адреса названо у поля');
  assert.ok(!page.includes('закреплён'), 'формулировки заморозки на черновике нет');
});

test('активная подборка: адрес только для чтения и назван замороженным (№249, §4)', () => {
  const page = String(studioCollectionView({
    locale: 'ru', collection: full({ active: true, visibleSeries: 6, publishBlockers: [] }),
  }).__raw);
  assert.ok(page.includes('name="slug"'), 'адрес виден и на активной строке');
  assert.ok(page.includes('readonly'), 'поле заморожено');
  assert.ok(page.includes('закреплён после публикации'),
    'причина заморозки названа текстом, не только самим полем');
});

test('форма создания понимает адрес (№249): поле есть, заморозки нет', () => {
  const page = String(studioCollectionView({ locale: 'ru', collection: null }).__raw);
  assert.ok(page.includes('name="slug"'), 'адрес задаётся уже при создании');
  assert.ok(page.includes('Латиница, цифры'), 'правило адреса названо у поля');
  assert.ok(!page.includes('закреплён'), 'заморозки на создании нет');
});
