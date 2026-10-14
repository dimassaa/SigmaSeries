// Размыкатель и учёт попыток (F-12-09).
//
// Проверяется решение, а не таймеры: паузы подменены, часы — свои. Размыкатель
// обязан считать окно запросов, а не «последние полчаса»: при 10 запросах в
// секунду полчаса — это 18 тысяч запросов, и порог в 50% не сработает никогда.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBreaker, WINDOW, FAILURE_THRESHOLD, MAX_PAUSES, PAUSE_MS } from '../src/services/import/breaker.js';

/** Размыкатель без реальных пауз: ждём просто считаем. */
const breaker = (options = {}) => {
  const waits = [];
  let now = 0;
  const b = createBreaker({
    sleep: async (ms) => { waits.push(ms); now += ms; },
    now: () => now,
    window: WINDOW,
    ...options,
  });
  return { b, waits, advance: (ms) => { now += ms; } };
};

test('окно — последние 50 запросов (§F-12-09 §9)', () => {
  assert.equal(WINDOW, 50);
  assert.equal(FAILURE_THRESHOLD, 0.5);
  assert.equal(MAX_PAUSES, 3);
  assert.equal(PAUSE_MS, 5 * 60 * 1000);
});

test('до порога пауз нет', async () => {
  const { b, waits } = breaker();
  for (let i = 0; i < 20; i += 1) await b.record(i % 5 !== 0);
  assert.deepEqual(waits, []);
});

test('больше половины неудач в окне — пауза пять минут', async () => {
  const { b, waits } = breaker();
  for (let i = 0; i < 40; i += 1) await b.record(true);   // окно ещё не заполнено
  assert.deepEqual(waits, [], 'окно не заполнено — судить не о чем');
  for (let i = 0; i < 10; i += 1) await b.record(true);   // 50-я запись: окно полно
  assert.equal(waits.length, 1);
  assert.equal(waits[0], PAUSE_MS);
});

test('после паузы окно очищается, иначе пауза повторялась бы вечно', async () => {
  const { b, waits } = breaker();
  for (let round = 0; round < 2; round += 1) {
    for (let i = 0; i < 50; i += 1) await b.record(true);
  }
  assert.equal(waits.length, 2, 'второе окно из одних неудач даёт вторую паузу');
  assert.equal(b.pausedCount, 2);
});

/** Запись без await: пауза подменена мгновенной, но проверки после неё ждут. */
const await0 = async (b) => { await b.record(true); };

test('после трёх пауз размыкатель открыт', async () => {
  const { b, waits } = breaker();
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 50; i += 1) await b.record(true);
  }
  assert.equal(waits.length, 3);
  assert.equal(b.tripped, true, 'после трёх пауз запуск должен стать «частично»');
});

test('после паузы успешные ответы окно выправляют', async () => {
  const { b, waits } = breaker();
  for (let i = 0; i < 50; i += 1) await b.record(true);
  assert.equal(waits.length, 1);
  for (let i = 0; i < 30; i += 1) await b.record(false);
  for (let i = 0; i < 20; i += 1) await b.record(true);
  assert.equal(waits.length, 1, '20 неудач из 50 — это 40%, порог не взят');
});

test('ровно половина неудач — ещё не порог', async () => {
  const { b, waits } = breaker();
  // 25 неудач и 25 успехов: ровно 50%, порог «больше 50%» не взят.
  for (let i = 0; i < 25; i += 1) await b.record(true);
  for (let i = 0; i < 25; i += 1) await b.record(false);
  assert.deepEqual(waits, []);
});

test('окно скользящее: старые неудачи выпадают', async () => {
  const { b, waits } = breaker();
  for (let i = 0; i < 25; i += 1) await b.record(true);
  for (let i = 0; i < 25; i += 1) await b.record(false);
  // Ещё 25 запросов: неудачи из начала окна вытесняются успехами.
  for (let i = 0; i < 25; i += 1) await b.record(true);
  assert.deepEqual(waits, [], 'буфер не растёт бесконечно и не врёт о прошлом');
});

test('буфер не растёт безгранично', async () => {
  const { b } = breaker();
  for (let i = 0; i < 5000; i += 1) await b.record(false);
  assert.ok(b.size <= WINDOW, `в буфере ${b.size} записей при окне ${WINDOW}`);
});

test('исчерпание пауз не блокирует запись результатов', async () => {
  // Размыкатель открыт, но прогон не должен падать: он становится «частично»
  // и пишет, что успел (EC-D6).
  const { b } = breaker();
  for (let round = 0; round < 5; round += 1) {
    for (let i = 0; i < 50; i += 1) await b.record(true);
  }
  assert.equal(b.tripped, true);
  assert.equal(b.pausedCount, MAX_PAUSES);
});