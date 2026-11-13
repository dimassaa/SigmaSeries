// Структурированные данные списковых страниц и заголовки выдачи (№241, №242).
//
// Чистые проверки без базы: форма разметки и шаблоны заголовков — это решения
// таблицы SEO §2, и они не должны зависеть от того, что лежит в демо-данных.

import test from 'node:test';
import assert from 'node:assert/strict';

import { websiteJsonLd, itemListJsonLd, breadcrumbJsonLd, jsonLdGraph } from '../src/services/seo/jsonld.js';
import { t } from '../src/i18n/strings.js';

test('главная отдаёт WebSite с адресом и языком (№241)', () => {
  const data = websiteJsonLd({ name: 'SigmaSeries', locale: 'ru' });
  assert.equal(data['@type'], 'WebSite');
  assert.equal(data.url, '/ru/');
  assert.equal(data.inLanguage, 'ru');
});

test('ItemList перечисляет выдачу по порядку, а на пустой выдаче его нет', () => {
  const data = itemListJsonLd({
    locale: 'ru',
    items: [{ slug: 'a', title: 'Первый' }, { slug: 'b', title: 'Второй' }],
  });
  assert.equal(data['@type'], 'ItemList');
  assert.equal(data.numberOfItems, 2);
  assert.deepEqual(
    data.itemListElement.map((item) => item.position),
    [1, 2],
    'позиции совпадают с порядком выдачи (R-SEO-18)',
  );
  assert.equal(data.itemListElement[0].url, '/ru/series/a');

  assert.equal(itemListJsonLd({ locale: 'ru', items: [] }), null,
    'пустой выдаче разметить нечего');
});

test('крошки заканчиваются текущей страницей без адреса', () => {
  const data = breadcrumbJsonLd({
    trail: [
      { name: 'Главная', path: '/ru/' },
      { name: 'Драма' },
    ],
  });
  assert.equal(data['@type'], 'BreadcrumbList');
  assert.equal(data.itemListElement[0].item, '/ru/');
  assert.ok(!('item' in data.itemListElement[1]), 'у текущей страницы адреса в крошке нет');
});

test('несколько сущностей уходят в @graph без повторных @context', () => {
  const data = jsonLdGraph([
    itemListJsonLd({ locale: 'ru', items: [{ slug: 'a', title: 'Первый' }] }),
    breadcrumbJsonLd({ trail: [{ name: 'Драма' }] }),
  ]);
  assert.equal(data['@context'], 'https://schema.org');
  assert.equal(data['@graph'].length, 2);
  assert.ok(data['@graph'].every((part) => !('@context' in part)),
    '@context в графике объявляется один раз');
});

test('средняя часть заголовка собирается по шаблону SEO §2 (№242)', () => {
  for (const locale of ['ru', 'en']) {
    const brand = t(locale, 'app.title');
    assert.match(t(locale, 'seo.title.home', { brand }), new RegExp(`${brand}:`),
      `${locale}: на главной бренд в середине, суффикс pageTitle сюда не входит`);
    assert.ok(!/\{[a-z]+\}/.test(t(locale, 'seo.title.catalogue')),
      `${locale}: подстановок в заголовке каталога нет`);
    assert.match(t(locale, 'seo.title.series', { title: 'Ходячие', year: 2010 }),
      /Ходячие \(2010\)/, `${locale}: название и год в заголовке сериала`);
    assert.ok(!/\(\)/.test(t(locale, 'seo.title.seriesNoYear', { title: 'Ходячие' })),
      `${locale}: без года скобок нет`);
  }
});

test('заголовки руководства, обсуждения и месяца календаря собираются из данных (№259)', () => {
  for (const locale of ['ru', 'en']) {
    assert.equal(
      t(locale, 'seo.title.guide', { title: 'Как смотреть', series: 'Ходячие' }),
      'Как смотреть — Ходячие',
      `${locale}: заголовок руководства с названием сериала`,
    );
    assert.match(
      t(locale, 'seo.title.discussion', { title: 'Теория', series: 'Ходячие' }),
      /Теория — .+Ходячие/,
      `${locale}: тема обсуждения с названием сериала`,
    );
    assert.match(
      t(locale, 'seo.title.calendar', { month: 'ноябрь 2026' }),
      /ноябрь 2026/,
      `${locale}: месяц в заголовке календаря`,
    );
  }
});
