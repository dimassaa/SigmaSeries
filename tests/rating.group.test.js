// Классификация отзыва по группам (F-04-05, OP-04).
//
// Границы — решение автора (DEC-015, MODERATION §3): положительные 7–10,
// смешанные 5–6, отрицательные 1–4; короткие < 300 знаков, длинные ≥ 1000,
// средние (300–999) — только в «Все». Проверяются именно границы: сдвиг на
// единицу — та же ошибка, что и фильтр «от шести» на экране, и заметить её
// можно только числами у порога.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ratingGroupOf,
  lengthGroupOf,
  POSITIVE_FROM,
  MIXED_FROM,
  RATING_FILTERS,
  LENGTH_FILTERS,
} from '../src/services/rating/group.js';

test('группа по оценке: все десять значений на своих местах (DEC-015)', () => {
  const expected = {
    1: 'negative',
    2: 'negative',
    3: 'negative',
    4: 'negative',
    5: 'mixed',
    6: 'mixed',
    7: 'positive',
    8: 'positive',
    9: 'positive',
    10: 'positive',
  };
  for (const [value, group] of Object.entries(expected)) {
    assert.equal(ratingGroupOf(Number(value)), group, `оценка ${value}`);
  }
  assert.equal(POSITIVE_FROM, 7);
  assert.equal(MIXED_FROM, 5);
});

test('группа по оценке не придумывается там, где её нельзя назвать', () => {
  // Значения вне шкалы — не «смешанные» по умолчанию: молчаливая догадка
  // исказила бы счётчики вкладок. Нет оценки — нет группы.
  assert.equal(ratingGroupOf(null), null);
  assert.equal(ratingGroupOf(undefined), null);
  assert.equal(ratingGroupOf(0), null);
  assert.equal(ratingGroupOf(11), null);
  assert.equal(ratingGroupOf(7.5), null);
});

test('группа по длине: границы 300 и 1000, пробелы по краям не считаются', () => {
  const text = (n) => 'а'.repeat(n);
  assert.equal(lengthGroupOf(text(299)), 'short');
  assert.equal(lengthGroupOf(text(300)), 'medium', '300 знаков — уже не короткие');
  assert.equal(lengthGroupOf(text(999)), 'medium');
  assert.equal(lengthGroupOf(text(1000)), 'long', '1000 знаков — длинные');
  assert.equal(lengthGroupOf(`  ${text(299)}  `), 'short',
    'длина — по тексту после обрезки пробелов (M4 F-04-05 §8б)');
  assert.equal(lengthGroupOf(''), 'short');
});

test('средние по длине не выбираются фильтром — остаются только во «Все»', () => {
  assert.deepEqual(LENGTH_FILTERS, ['short', 'long']);
  assert.deepEqual(RATING_FILTERS, ['positive', 'mixed', 'negative']);
  assert.ok(!LENGTH_FILTERS.includes('medium'), 'средние — не значение фильтра (F-04-05 §8б)');
});
