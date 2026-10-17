// Описание устройства из заголовка User-Agent (F-01-03 §4, S-32 «Безопасность»).
//
// Человек смотрит на список устройств, чтобы понять, откуда вход. Сырой
// User-Agent для этого не годится: «Mozilla/5.0 (Windows NT 10.0; Win64; x64)
// AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36» — это
// четыре строки технического текста вместо двух слов «Chrome · Windows».
//
// Разбор сознательно неполный: настоящие браузеры различают сотни строк, а
// список устройств отвечает на вопрос «откуда вошли», а не «какая точная
// сборка». Правила упорядочены по вложенности: Edge присылает «Chrome»,
// Chrome присылает «Safari», поэтому первым идёт самый специфичный признак.

import test from 'node:test';
import assert from 'node:assert/strict';

import { deviceLabel } from '../src/services/auth/device.js';

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FIREFOX_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7; rv:121.0) Gecko/20100101 Firefox/121.0';
const EDGE_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';
const CHROME_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

test('название браузера и операционной системы', () => {
  assert.equal(deviceLabel(CHROME_WIN), 'Chrome · Windows');
  assert.equal(deviceLabel(FIREFOX_MAC), 'Firefox · macOS');
  assert.equal(deviceLabel(CHROME_LINUX), 'Chrome · Linux');
});

test('Edge не читается как Chrome, а мобильный Safari — как обычный', () => {
  // Оба браузера называют в User-Agent того, кто в них встроен: Edge — Chrome,
  // Safari на iPhone — Safari. Без порядка проверок подпись врёт.
  assert.equal(deviceLabel(EDGE_WIN), 'Edge · Windows');
  assert.equal(deviceLabel(SAFARI_IPHONE), 'Safari · iOS');
});

test('нераспознанный заголовок показывается как есть, но обрезанно', () => {
  // Ни браузера, ни системы в строке нет — показывать нечего, и молчаливое
  // «—» хуже: человек не поймёт, чей это вход.
  const strange = 'Mozilla/5.0 (совершенно неизвестная система) SomethingElse/1.0';
  assert.equal(deviceLabel(strange), strange);
  const long = `${strange}${'x'.repeat(4000)}`;
  assert.ok(deviceLabel(long).length <= 120, 'длинная строка не должна занимать пол-экрана');
  assert.ok(deviceLabel(long).startsWith(strange));
});

test('без заголовка подпись всё равно есть', () => {
  // Столбец `device_label` NOT NULL, а заголовок браузер может не прислать.
  assert.equal(typeof deviceLabel(undefined), 'string');
  assert.equal(typeof deviceLabel(''), 'string');
  assert.ok(deviceLabel('').length > 0);
});