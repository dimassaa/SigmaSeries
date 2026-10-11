// Длительности модуля в настоящих единицах.
//
// Тест появился не из-за красного теста, а из-за ошибки, которую 217 зелёных
// тестов не видели: MINUTE, HOUR и DAY были заданы в секундах и использовались
// как миллисекунды. Каждая длительность в модуле была занижена в тысячу раз —
// окно перебора 0.9 секунды вместо 15 минут, абсолютная сессия модератора
// 43 секунды вместо 12 часов. Ни один тест не двигал время, поэтому ошибка
// проходила незамеченной.
//
// Проверять надо не формулу, а результат: перевод в миллисекунды легко
// испортить снова, и заметить это можно только сравнением с ожиданием.

import test from 'node:test';
import assert from 'node:assert/strict';

import { AUTH, MINUTE, HOUR, DAY } from '../src/config/settings.js';

test('единицы измерения — миллисекунды', () => {
  assert.equal(MINUTE, 60_000);
  assert.equal(HOUR, 3_600_000);
  assert.equal(DAY, 86_400_000);
});

test('длительности сессий соответствуют R-SEC-03', () => {
  // R-SEC-03: зритель — простой 7 дней, абсолютный 30; служебные роли —
  // простой 30 минут, абсолютный 12 часов.
  assert.equal(AUTH.viewerIdleMs, 7 * 86_400_000);
  assert.equal(AUTH.viewerAbsoluteMs, 30 * 86_400_000);
  assert.equal(AUTH.staffIdleMs, 30 * 60_000);
  assert.equal(AUTH.staffAbsoluteMs, 12 * 3_600_000);
});

test('окно перебора и потолок задержки соответствуют R-SEC-05', () => {
  assert.equal(AUTH.attemptsWindowMs, 15 * 60_000);
  assert.equal(AUTH.delayMaxMs, 5 * 60_000);
});

test('абсолютный срок служебной сессии длиннее простого', () => {
  // Порядок неверных значений тихо ломает сессию: человек вылетает раньше,
  // чем истекло время бездействия. Такое лучше ловить утверждением,
  // чем глазами на экране.
  assert.ok(AUTH.staffAbsoluteMs > AUTH.staffIdleMs);
  assert.ok(AUTH.viewerAbsoluteMs > AUTH.viewerIdleMs);
  assert.ok(AUTH.delayMaxMs >= AUTH.delayStepMs,
    'потолок задержки меньше первого шага — задержка всегда одинаковая');
  assert.ok(AUTH.registrationsPerIp > 0);
  assert.ok(AUTH.registrationsFreePerIp < AUTH.registrationsPerIp,
    'невидимая проверка должна включаться раньше жёсткой стены, иначе мёртвый код');
});

test('срок жизни токена и неподтверждённого аккаунта в разумных пределах', () => {
  // Не «правильные» числа, а порядок величины: ошибка на три порядка
  // выглядит правдоподобно в тесте, но не в жизни.
  assert.ok(AUTH.tokenTtlMin >= 5 && AUTH.tokenTtlMin <= 24 * 60);
  assert.ok(AUTH.unverifiedTtlDays >= 1 && AUTH.unverifiedTtlDays <= 90);
  assert.ok(AUTH.resendCooldownS >= 10 && AUTH.resendCooldownS <= 600);
  assert.ok(AUTH.resendCooldownS < AUTH.unverifiedTtlDays * 86_400);
});
