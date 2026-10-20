// Разметка карточки сериала (S-75, F-10-06, F-10-09).
//
// Проверяется то, что HTML не позволяет: вложенных форм на странице быть не
// должно. Браузер выбрасывает тег внутренней формы, её поля приклеиваются к
// внешней форме, и в теле запроса появляются два поля csrf. Проверка CSRF
// видит не строку, а массив, и любое сохранение уходит в «сессия устарела»
// (R-SEC-03). Поэтому каждая форма на странице несёт ровно один csrf.

import test from 'node:test';
import assert from 'node:assert/strict';

import { studioCardView } from '../src/view/studioCard.js';

/** Карточка для разметки: значения нужны только для показа. */
const CARD = {
  id: 57,
  slug: 'test-series',
  version: 5,
  level: 'full',
  publicationState: 'imported',
  archived: false,
  reasons: ['no_backdrop'],
  publishBlockers: [],
  genres: ['drama'],
  imdb: 8.9,
  imdbVotes: 1000,
  measuredOn: '2026-10-01',
  imdbKey: 'tt1234567',
  tmdbId: 42,
  fields: {
    title_ru: 'Сериал', title_en: 'Series', title_original: 'Series',
    year_start: 2019, year_end: null, slug: 'test-series',
    description_ru: 'Описание', description_en: 'Description',
    exit_state: 'ended',
  },
  origins: { title_ru: 'manual', slug: 'import' },
  dependencies: {
    banners: 0, collections: 1, watchers: 2, marks: 3,
    reviews: 0, ratings: 5, releases: 0,
  },
};

const HISTORY = [{
  id: 1, at: '2026-10-21T00:00:00.000Z', version: 5, source: 'manual',
  actor: 'anna', diff: { title_ru: { from: 'Было', to: 'Стало' } },
}];

const SCHEDULE = [{
  id: 2, number: 1,
  episodes: [
    { id: 11, number: 1, date: '2026-01-05', state: 'aired', locked: false },
    { id: 12, number: 2, date: null, state: 'scheduled', locked: true },
  ],
}];

const IMAGES = [{
  id: 3, role: 'backdrop', width: 1920, height: 1080, focalX: 50, focalY: 40,
  variantWidth: 1280,
}];

/**
 * Разметка вида строкой: шаблон отдаёт готовый кусок, а не строку.
 *
 * @param {object} args
 * @returns {string}
 */
function markupOf(args) {
  const view = studioCardView(args);
  return String(view.__raw ?? view);
}

/**
 * Глубина вложенности форм: больше единицы — вложенная форма.
 *
 * @param {string} markup
 * @returns {number}
 */
function formDepth(markup) {
  const tokens = markup.match(/<\/?form\b/g) ?? [];
  let depth = 0;
  let deepest = 0;
  for (const token of tokens) {
    depth += token.startsWith('</') ? -1 : 1;
    if (depth > deepest) deepest = depth;
  }
  return deepest;
}

/**
 * Сколько полей csrf в каждой форме.
 *
 * @param {string} markup
 * @returns {number[]}
 */
function csrfPerForm(markup) {
  const forms = markup.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
  return forms.map((form) => (form.match(/name="csrf"/g) ?? []).length);
}

const TABS = ['primary', 'texts', 'genres', 'ratings', 'schedule', 'images', 'service'];

test('на карточке нет вложенных форм: ни одна вкладка', () => {
  for (const tab of TABS) {
    const markup = markupOf({
      locale: 'ru', card: CARD, history: HISTORY, genres: [{ code: 'drama', title: 'Драма' }],
      schedule: SCHEDULE, images: IMAGES, tab, csrf: 'токен',
    });
    assert.ok(formDepth(markup) <= 1, `на вкладке «${tab}» форма вложена в форму`);
  }
});

test('на вкладках с полями форма одна, и в ней — версия карточки', () => {
  for (const tab of ['primary', 'texts', 'genres']) {
    const markup = markupOf({
      locale: 'ru', card: CARD, history: HISTORY, genres: [{ code: 'drama', title: 'Драма' }],
      schedule: SCHEDULE, images: IMAGES, tab, csrf: 'токен',
    });
    assert.equal(formDepth(markup), 1, `на вкладке «${tab}» форма пропала или размножилась`);
    assert.match(markup, /name="version" value="5"/, 'в форме есть версия карточки');
  }
});

test('в каждой форме ровно один csrf', () => {
  for (const tab of TABS) {
    const markup = markupOf({
      locale: 'ru', card: CARD, history: HISTORY, genres: [{ code: 'drama', title: 'Драма' }],
      schedule: SCHEDULE, images: IMAGES, tab, csrf: 'токен',
    });
    for (const [index, count] of csrfPerForm(markup).entries()) {
      assert.equal(count, 1, `на вкладке «${tab}» в форме ${index + 1} csrf — ${count}`);
    }
  }
});

test('возврат поля к импорту сделан кнопкой, а не отдельной формой', () => {
  const markup = markupOf({
    locale: 'ru', card: CARD, history: [], genres: [], schedule: [], images: [],
    tab: 'primary', csrf: 'токен',
  });
  assert.match(markup, /formaction="\/ru\/admin\/catalog\/57\/reset-field"/,
    'кнопка сброса поля отправляет запрос на сброс');
  assert.match(markup, /name="field" value="title_ru"/,
    'кнопка сброса говорит, какое поле сбрасывает');
  assert.doesNotMatch(markup, /studio-field__reset"\s+method/,
    'у кнопки сброса нет своей формы');
});

test('возврат версии сделан отдельной формой, а не вложенной', () => {
  const markup = markupOf({
    locale: 'ru', card: CARD, history: HISTORY, genres: [], schedule: [], images: [],
    tab: 'service', csrf: 'токен',
  });
  assert.match(markup, /action="\/ru\/admin\/catalog\/57\/versions\/5\/restore"/,
    'форма возврата версии на месте');
  assert.equal(formDepth(markup), 1);
});
