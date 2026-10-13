// Заглушка и настоящее хранилище обязаны иметь одинаковый интерфейс.
//
// Тест существует из-за конкретного случая. Шесть методов (`verifyCurrent`,
// `updateNotifications`, `setTwoFactor`, `disableTwoFactor`,
// `nicknameChangedAt`, `setSessions`) были написаны только в заглушке: все
// HTTP-тесты идут по ней и были зелёные, а против настоящей базы смена
// пароля, 2FA, уведомления и ник отдавали 500 —
// `TypeError: auth.verifyCurrent is not a function`. Поймать это было нечем:
// интерфейсы хранилищ нигде не сверялись.
//
// Обратное направление проверяется тоже: метод, который есть в настоящем
// хранилище и отсутствует в заглушке, означает код, который HTTP-тесты не
// проверяют вовсе.
//
// База тесту не нужна: `pgAuthStore` не подключается при создании, ему
// достаточно объекта с методом `query`. Поэтому сравнение идёт всегда, даже
// когда PostgreSQL недоступен.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { pgAuthStore, stubAuthStore } from '../src/services/auth/store.js';

// Секреты приложения нужны заглушке при создании: слепой индекс и шифрование.
process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';

/**
 * Методы, которых у настоящего хранилища нет и быть не должно.
 *
 * Это не интерфейс приложения, а посев состояния для тестов: в базу состояние
 * кладёт сам тест (`auth.store.test.js` пишет в таблицы напрямую), а заглушке
 * нужно чем-то задать готовые устройства, материалы и оценки. Если такой
 * метод понадобится в производственном коде, посевом он перестаёт быть.
 */
const TEST_SEEDS = [
  'setTwoFactor', 'setSessions', 'byId',
  'addMaterials', 'addRating', 'setDeleteMaterials', 'materials', 'ratings',
];

const ROUTES = ['auth.js', 'register.js', 'reset.js', 'settings.js', 'twofactor.js']
  .map((file) => fileURLToPath(new URL(`../src/routes/${file}`, import.meta.url)));

/** Имена собственных методов объекта-хранилища. */
const methodsOf = (store) => Object.keys(store)
  .filter((key) => typeof store[key] === 'function');

const pg = pgAuthStore({ query: async () => ({ rows: [] }) });
const stub = stubAuthStore({});

test('в заглушке нет метода, которого нет у настоящего хранилища', () => {
  const onlyStub = methodsOf(stub)
    .filter((name) => typeof pg[name] !== 'function' && !TEST_SEEDS.includes(name));

  assert.deepEqual(onlyStub, [], `в заглушке есть, в pg нет: ${onlyStub.join(', ')}`);
});

test('в настоящем хранилище нет метода, которого нет в заглушке', () => {
  const onlyPg = methodsOf(pg).filter((name) => typeof stub[name] !== 'function');

  assert.deepEqual(onlyPg, [], `в pg есть, в заглушке нет: ${onlyPg.join(', ')}`);
});

test('методы-посевы заглушки не вызываются в производственном коде', () => {
  // Имя в TEST_SEEDS — утверждение о том, что метод никто не зовёт вне тестов.
  // Проверяется чтением маршрутов: появился вызов — метод переносится в pg.
  const sources = ROUTES.map((file) => readFileSync(file, 'utf8')).join('\n');
  const used = TEST_SEEDS.filter((name) => sources.includes(`.${name}(`));

  assert.deepEqual(used, [], `маршруты вызывают метод-посев: ${used.join(', ')}`);
});

test('в заглушке нет метода, перекрытого вторым определением', () => {
  // Два определения одного ключа в литерале объекта не дают ошибки: второе
  // молча выигрывает, а первое остаётся мёртвым кодом. Так в заглушке
  // появились две копии `disableTwoFactor` и `nicknameFree`, и правилась не
  // та. Каждая половина файла проверяется отдельно: один и тот же метод в
  // разных хранилищах — это нормально, а вот дважды в одном — нет.
  const source = readFileSync(
    fileURLToPath(new URL('../src/services/auth/store.js', import.meta.url)), 'utf8',
  );
  const halves = [
    ['pgAuthStore', source.slice(0, source.indexOf('export function stubAuthStore'))],
    ['stubAuthStore', source.slice(source.indexOf('export function stubAuthStore'))],
  ];

  const twice = [];
  for (const [name, half] of halves) {
    const definitions = [...half.matchAll(/^\s{4}(?:async )?([a-zA-Z_]\w*)\s*\(/gm)]
      .map((match) => match[1]);
    for (const method of definitions) {
      if (definitions.indexOf(method) !== definitions.lastIndexOf(method)) {
        twice.push(`${name}.${method}`);
      }
    }
  }

  assert.deepEqual([...new Set(twice)], [], `метод определён дважды: ${twice.join(', ')}`);
});