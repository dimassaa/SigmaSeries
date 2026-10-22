// «Новинки и идущие» через TMDB (F-12-04).
//
// Проверяется отбор, а не сеть: окно дат, объединение двух обзоров, причину
// включения и потолок. Именно здесь решается, что попадёт в календарь, и
// ошибка здесь тихо сузила бы каталог до половины.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeDiscoveries,
  resolveExcludedGenres,
  windowBounds,
  reasonOf,
  EXCLUDED_GENRES_TMDB,
  MAX_PAGES,
} from '../src/services/import/discover.js';
import { IMPORT_SETTINGS } from '../src/config/settings.js';

/** Сегодня — фиксированная точка, иначе тест «поплывёт» с датой. */
const TODAY = new Date('2026-10-14T00:00:00Z');

const item = (id, extra = {}) => ({
  id,
  name: `Сериал ${id}`,
  first_air_date: '2026-01-01',
  popularity: 10 - id,
  ...extra,
});

/**
 * Обзор по первым датам.
 *
 * @param {any[]} items
 * @returns {{reason: 'new', items: any[]}}
 */
const newWindow = (items) => ({ reason: 'new', items });

/**
 * Обзор по датам выхода серий.
 *
 * @param {any[]} items
 * @returns {{reason: 'airing', items: any[]}}
 */
const airingWindow = (items) => ({ reason: 'airing', items });

// ─── Окно ─────────────────────────────────────────────────────────────────────

test('окно новинок начинается за new_window_months месяцев', () => {
  const bounds = windowBounds({ today: TODAY, until: '2026-12-31' });
  assert.equal(bounds.newFrom, '2025-10-14', '12 месяцев назад по §0');
  assert.equal(bounds.airFrom, '2026-10-14', 'а выходы ищем только вперёд');
  assert.equal(bounds.airTo, '2026-12-31');
});

test('окно считается по календарю, а не «минус 365 дней»', () => {
  // Месяц — не ровно 30 дней: «минус 365» зимой съело бы лишний месяц.
  const bounds = windowBounds({ today: new Date('2026-03-01T00:00:00Z'), until: '2026-12-31' });
  assert.equal(bounds.newFrom, '2025-03-01');
});

// ─── Объединение обзоров ──────────────────────────────────────────────────────

test('сериал из обоих обзоров получает обе причины', () => {
  const merged = mergeDiscoveries([newWindow([item(1)]), airingWindow([item(1)])]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].reason, 'both');
});

test('повтор с разными датами не плодит позиции', () => {
  const merged = mergeDiscoveries([newWindow([item(1)]), airingWindow([item(1, { first_air_date: '2026-05-05' })])]);
  assert.equal(merged.length, 1);
});

test('порядок по популярности TMDB убывающий', () => {
  const merged = mergeDiscoveries([newWindow([item(1, { popularity: 5 }), item(2, { popularity: 90 })])]);
  assert.deepEqual(merged.map((row) => row.id), [2, 1]);
});

test('потолок ограничивает только новые добавления (EC-I7)', () => {
  const many = Array.from({ length: 500 }, (_, i) => item(i + 1, { popularity: 500 - i }));
  const merged = mergeDiscoveries([newWindow(many)], { cap: IMPORT_SETTINGS.newCap });
  assert.equal(merged.length, IMPORT_SETTINGS.newCap);
  // Потолок держится на пределе обзора TMDB (5 страниц по 20): больше сотни
  // обзор всё равно не вернёт, и завышенное число в настройке только вводит
  // в заблуждение при чтении журнала (#91).
  assert.equal(IMPORT_SETTINGS.newCap, MAX_PAGES * 20);
});

test('причина ставится по тому, откуда пришёл сериал', () => {
  assert.equal(reasonOf(['new']), 'new');
  assert.equal(reasonOf(['airing']), 'airing');
  assert.equal(reasonOf(['airing', 'new']), 'both');
});

// ─── Исключение жанров (DEC-022) ─────────────────────────────────────────────

test('список TMDB совпадает по смыслу со списком IMDb (DEC-022)', () => {
  assert.deepEqual(EXCLUDED_GENRES_TMDB, ['Animation', 'Talk', 'News', 'Reality', 'Soap', 'Kids']);
});

test('имена жанров превращаются в идентификаторы TMDB', () => {
  const map = { Animation: 16, Talk: 10759, News: 99, Reality: 4670, Soap: 10751, Kids: 10752 };
  const resolved = resolveExcludedGenres(EXCLUDED_GENRES_TMDB, map);
  assert.deepEqual(resolved.ids.sort((a, b) => a - b), [16, 99, 4670, 10751, 10752, 10759].sort((a, b) => a - b));
  assert.deepEqual(resolved.unresolved, []);
});

test('незнакомое имя жанра не молча теряется', () => {
  // Если TMDB переименует жанр, исключение потеряет смысл: сериал пройдёт
  // путём TMDB, который отсекает по IMDb. Это должно быть видно, а не тихо.
  const resolved = resolveExcludedGenres(['Animation', 'Новости'], { Animation: 16 });
  assert.deepEqual(resolved.ids, [16]);
  assert.deepEqual(resolved.unresolved, ['Новости']);
});

test('без идентификаторов обзор идти не должен', () => {
  const resolved = resolveExcludedGenres(['Animation'], {});
  assert.equal(resolved.ids.length, 0);
  assert.deepEqual(resolved.unresolved, ['Animation']);
});

// ─── Лимиты ───────────────────────────────────────────────────────────────────

test('страниц обзора не больше пяти (§9)', () => {
  assert.equal(MAX_PAGES, 5);
});