// Нормализация поискового запроса (F-02-06 §3).
//
// Проверяется без базы: правила нормализации — это чистые функции, и проверка
// их против живых данных означала бы, что ошибку в «ё» найдёт только человек,
// который уже ищет не то.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isEmptyQuery,
  otherLayout,
  normalize,
  queryStems,
  rankOf,
  stem,
  trimQuery,
  withinOneEdit,
} from '../src/services/search/query.js';

test('регистр, ё и пунктуация не мешают найти одно и то же', () => {
  assert.equal(normalize('Во все тяжкие'), normalize('во все тяжкие'));
  // «Ё» и «е» — одна буква для поиска: человек пишет «Елка» и «ёлка» одинаково.
  assert.equal(normalize('Ёлка'), normalize('елка'));
  assert.equal(normalize('Ё'), 'е');
  assert.equal(normalize('Игра Престолов'), normalize('игра  престолов!'));
  assert.equal(normalize('  Честное  '), 'честное');
});

test('латинская диакритика снимается, кириллица не ломается', () => {
  assert.equal(normalize('Amélie'), 'amelie');
  assert.equal(normalize('The Wire'), 'the wire');
  assert.equal(normalize('Щит'), 'щит');
});

test('раскладка переводится в обе стороны, а смешанный запрос — нет', () => {
  assert.equal(otherLayout('ghbdtn'), 'привет');
  assert.equal(otherLayout('привет'), 'ghbdtn');
  // Смешанный запрос переводить нельзя: половина слов станет мусором.
  assert.equal(otherLayout('игра престолов thrones'), null);
  assert.equal(otherLayout('  '), null);
  assert.equal(otherLayout('12345'), null, 'в цифрах раскладки нет');
});

test('запрос из одних знаков препинания пустой (EC-K9)', () => {
  assert.equal(isEmptyQuery('...'), true);
  assert.equal(isEmptyQuery('!!! ???'), true);
  assert.equal(isEmptyQuery('   '), true);
  assert.equal(isEmptyQuery('а'), false);
});

test('длинный запрос обрезается, а не отклоняется', () => {
  const long = 'а'.repeat(150);
  const { query, truncated } = trimQuery(long);
  assert.equal(query.length, 100);
  assert.equal(truncated, true);

  const short = trimQuery('во все тяжкие');
  assert.equal(short.query, 'во все тяжкие');
  assert.equal(short.truncated, false);
});

test('основа слова переживает падеж', () => {
  assert.equal(stem('сериалы'), stem('сериала'));
  assert.equal(stem('престолов'), stem('престолом'));
  assert.equal(stem('кот'), 'кот', 'короткие слова не режутся');
  assert.deepEqual(queryStems('сериалы'), queryStems('сериала'),
    'запрос и название нормализуются одним правилом — иначе поиск перестаёт себя находить');
});

test('порядок совпадений задан спецификацией', () => {
  const exact = rankOf(queryStems('Во все тяжкие'), queryStems('Во все тяжкие'));
  const starts = rankOf(queryStems('Во все тяжкие'), queryStems('Во все'));
  const word = rankOf(queryStems('Игра престолов'), queryStems('престолов'));
  const other = rankOf(queryStems('Во все тяжкие'), queryStems('сирог'));

  assert.equal(exact, 0);
  assert.equal(starts, 1);
  assert.equal(word, 2);
  assert.equal(other, null, 'несовпадение ранга не получает, а отбрасывается');
  assert.ok(exact < starts && starts < word, 'чем ближе совпадение, тем лучше ранг');
});

test('опечатка в длинном слове всё ещё находит', () => {
  const found = rankOf(queryStems('Во все тяжкие'), queryStems('тяжкиеи'));
  assert.equal(found, 3, 'одна правка в слове от пяти знаков');
  assert.equal(rankOf(queryStems('Во все тяжкие'), queryStems('васе')), null,
    'короткое слово опечаткой не считается — иначе всё находится всегда');
});

test('одна правка отличается от двух', () => {
  assert.equal(withinOneEdit('престолов', 'престоловъ'), true);
  assert.equal(withinOneEdit('престолов', 'престл'), false);
  assert.equal(withinOneEdit('престолов', 'престолов'), false, 'слово равно себе — это не правка');
});

test('смешанный запрос ищет по обоим вариантам (EC-K10)', () => {
  const stems = queryStems('Game of Thrones');
  assert.deepEqual(stems, ['game', 'of', 'thrones']);
  assert.equal(rankOf(queryStems('Игра Престолов'), stems), null,
    'русское название не находится по английскому запросу напрямую');
  assert.equal(rankOf(queryStems('Игра Престолов'), queryStems('Игра Престолов')), 0);
});