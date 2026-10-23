// Причина «Похожих» по вкладу (M11 F-11-02 §4, §18).
//
// Причина должна называть признак, который действительно поднял карточку,
// а при равенстве — человека: приёмка требует режиссёра, а не жанр, когда
// общий режиссёр и общий жанр дают одинаковый вклад.

import test from 'node:test';
import assert from 'node:assert/strict';

import { pickSimilarReason } from '../src/services/catalogue/series.js';

test('при равенстве человека и жанра причина называет человека', () => {
  assert.deepEqual(
    pickSimilarReason({
      people_score: 3,
      genre_score: 3,
      people_titles: ['Марк Логовский'],
      genre_titles: ['Драма'],
      genre_titles_en: ['Drama'],
    }),
    { kind: 'person', title: 'Марк Логовский', titleEn: 'Марк Логовский' },
  );
});

test('два общих жанра перевешивают одного человека', () => {
  assert.deepEqual(
    pickSimilarReason({
      people_score: 3,
      genre_score: 6,
      people_titles: ['Марк Логовский'],
      genre_titles: ['Драма'],
      genre_titles_en: ['Drama'],
    }),
    { kind: 'genre', title: 'Драма', titleEn: 'Drama' },
  );
});

test('слово показывается, когда жанров и людей нет', () => {
  assert.deepEqual(
    pickSimilarReason({
      keyword_score: 2,
      keyword_titles: ['антигерой'],
    }),
    { kind: 'keyword', title: 'антигерой', titleEn: 'антигерой' },
  );
});

test('без общих признаков причины нет', () => {
  assert.equal(pickSimilarReason({}), null);
  assert.equal(pickSimilarReason({ genre_score: 0, genre_titles: [] }), null);
});
