// Время запусков: разбор `ЧЧ:ММ` и решение «пора ли» (F-12-07 §6, §9).
//
// Проверяется чистая функция, потому что всё остальное в планировщике — это
// работа с БД, а ошибиться страшнее всего здесь: время 24:00 молча превратилось
// бы в «сейчас», а 04:60 — в следующие сутки, и ночной запуск ушёл бы на
// сутки позже без единой записи в журнале.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseScheduleTime, cronFor, isDue, nextOccurrence, nextWeekly, isWeeklyDue } from '../src/services/import/schedule-time.js';

test('время задаётся как ЧЧ:ММ (§9)', () => {
  assert.deepEqual(parseScheduleTime('04:00'), { hours: 4, minutes: 0 });
  assert.deepEqual(parseScheduleTime('23:59'), { hours: 23, minutes: 59 });
  assert.deepEqual(parseScheduleTime('00:07'), { hours: 0, minutes: 7 });
});

test('часы с ведущим нулём тоже принимаются', () => {
  assert.deepEqual(parseScheduleTime('4:00'), { hours: 4, minutes: 0 });
});

test('часы вне 0–23 и минуты вне 0–59 — ошибка, а не тихий сдвиг', () => {
  for (const value of ['24:00', '04:60', '99:00', '04:5a', '0400', '04', '04:00:00', '']) {
    assert.throws(() => parseScheduleTime(value), RegExp(/:.*(ЧЧ:ММ|формат|время)/i), value);
  }
});

test('время из настроек берётся, а не из кода', () => {
  assert.equal(cronFor('04:00'), '0 4 * * *');
  assert.equal(cronFor('05:30'), '30 5 * * *');
  assert.equal(cronFor('00:00'), '0 0 * * *');
});

test('cron без ведущих нулей — причина пропущенной ночи', () => {
  // `4 * * * *` в некоторых парсерах значит «каждые четыре минуты» или
  // отвергается целиком; оба варианта означают тихую поломку расписания.
  assert.equal(cronFor('04:00').split(' ')[0], '0');
  assert.equal(cronFor('04:00').split(' ')[1], '4');
});

test('запуск пора, когда наступил час и минута', () => {
  assert.equal(isDue({ hours: 4, minutes: 0 }, new Date('2026-10-14T04:00:00')), true);
  assert.equal(isDue({ hours: 4, minutes: 0 }, new Date('2026-10-14T04:00:59')), true);
  assert.equal(isDue({ hours: 4, minutes: 0 }, new Date('2026-10-14T03:59:59')), false);
  assert.equal(isDue({ hours: 4, minutes: 0 }, new Date('2026-10-14T04:01:00')), false,
    'окно — минута, иначе тик раз в минуту запускал бы ночь много раз');
});

test('ночь не запускается днём того же дня', () => {
  assert.equal(isDue({ hours: 4, minutes: 0 }, new Date('2026-10-14T13:30:00')), false);
});

test('следующее вхождение — завтра, если сегодня время ещё не наступило', () => {
  const next = nextOccurrence({ hours: 4, minutes: 0 }, new Date('2026-10-14T02:00:00'));
  assert.equal(next.getHours(), 4);
  assert.equal(next.getDate(), 14);
});

test('после срабатывания следующее — на следующие сутки', () => {
  const next = nextOccurrence({ hours: 4, minutes: 0 }, new Date('2026-10-14T04:00:30'));
  assert.equal(next.getDate(), 15);
  assert.equal(next.getHours(), 4);
});

test('через полночь следующее вхождение — завтра', () => {
  const next = nextOccurrence({ hours: 23, minutes: 59 }, new Date('2026-10-14T00:10:00'));
  assert.equal(next.getDate(), 14);
  assert.equal(next.getHours(), 23);

  const after = nextOccurrence({ hours: 0, minutes: 1 }, new Date('2026-10-14T23:59:30'));
  assert.equal(after.getDate(), 15, 'минута после полуночи — уже завтра');
});

test('еженедельная задача ждёт именно понедельника', () => {
  // Во вторник план на «ближайшее вхождение» превратил бы недельную задачу в
  // ежедневную — и рейтинги перезаписывались бы семь раз вместо одного.
  const fromTuesday = nextWeekly({ hours: 5, minutes: 0 }, new Date('2026-10-13T09:00:00'));
  assert.equal(fromTuesday.getDay(), 1, 'следующий понедельник');
  assert.equal(fromTuesday.getDate(), 19);
  assert.equal(fromTuesday.getHours(), 5);
});

test('в понедельник до 05:00 план ставится на сегодня', () => {
  const plan = nextWeekly({ hours: 5, minutes: 0 }, new Date('2026-10-12T03:00:00'));
  assert.equal(plan.getDate(), 12);
  assert.equal(plan.getHours(), 5);
});

test('в понедельник после 05:00 план уезжает на следующую неделю', () => {
  const plan = nextWeekly({ hours: 5, minutes: 0 }, new Date('2026-10-12T06:00:00'));
  assert.equal(plan.getDate(), 19);
});
