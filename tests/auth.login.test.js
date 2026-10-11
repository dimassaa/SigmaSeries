// Вход, выход, лимиты и невидимая проверка.
// Спецификация: docs/01-product/features/M1-identity.md F-01-03.
// Требования: R-SEC-02, R-SEC-05, R-SEC-06, R-SEC-08, R-SEC-31, R-SEC-34.

import crypto from 'node:crypto';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  safeReturnTo,
  sessionDurations,
  decideAfterCredentials,
  authenticate,
  sessionKind,
} from '../src/services/auth/login.js';
import {
  delayFor,
  recordFailure,
  recordSuccess,
  needsProofOfWork,
  issueChallenge,
  verifyChallenge,
  ipLimited,
  accountKey,
  _reset,
} from '../src/services/auth/limits.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { AUTH } from '../src/config/settings.js';

test.beforeEach(() => _reset());

// ─── Возврат после входа (R-SEC-08) ───────────────────────────────────────────

test('принимается внутренний относительный адрес', () => {
  assert.equal(safeReturnTo('/ru/calendar'), '/ru/calendar');
  assert.equal(safeReturnTo('/'), '/');
});

test('внешний адрес не принимается', () => {
  // Открытый перенаправление: жертва входит и оказывается на чужом сайте
  // с подставленным адресом.
  for (const bad of [
    'https://evil.example/steal',
    '//evil.example/steal',
    '//evil.example',
    'http:/evil.example',
    'javascript:alert(1)',
    'ru/calendar',
    '',
    null,
    undefined,
  ]) {
    assert.equal(safeReturnTo(bad), '/', `принят небезопасный адрес: ${bad}`);
  }
});

test('управляющие символы в адресе отбрасываются', () => {
  // Иначе в Location попадает перевод строки и заголовок рвётся.
  assert.equal(safeReturnTo('/ru/\r\nSet-Cookie: x=1'), '/');
  assert.equal(safeReturnTo('/ru/\tx'), '/');
});

// ─── Длительность сессии (R-SEC-03) ───────────────────────────────────────────

test('служебная роль получает короткую сессию', () => {
  const d = sessionDurations(true);
  assert.equal(d.idle, AUTH.staffIdleMs);
  assert.ok(d.absolute < sessionDurations(false).absolute,
    'окно служебной сессии должно быть меньше зрительской');
});

test('видна любая служебная роль', () => {
  for (const roles of [['admin'], ['editor'], ['analyst'], ['admin', 'editor']]) {
    assert.equal(sessionKind(roles), 'staff', `роль не распознана: ${roles}`);
  }
  assert.equal(sessionKind([]), 'viewer');
  assert.equal(sessionKind(undefined), 'viewer');
});

// ─── Решение после проверки учётки ────────────────────────────────────────────

test('неверный пароль и неизвестный аккаунт дают один ответ', async () => {
  const hash = await hashPassword('очень-длинный-пароль');
  const known = await authenticate('a@b.c', 'очень-длинный-пароль', { password_hash: hash });
  const unknown = await authenticate('x@y.z', 'очень-длинный-пароль', null);
  assert.equal(known.ok, true);
  assert.equal(unknown.ok, false);
  // Разные причины на уровне пользователя опасны: по ним перебираются учётки.
  assert.equal(decideAfterCredentials(null, false).reason,
    decideAfterCredentials({ status: 'active' }, false).reason);
});

test('бан показывается только при верном пароле', () => {
  // Иначе форма становится способом проверить, зарегистрирован ли email.
  const banned = { status: 'banned', email_confirmed: true };
  assert.equal(decideAfterCredentials(banned, false).action, 'invalid');
  assert.equal(decideAfterCredentials(banned, true).action, 'blocked');
});

test('неподтверждённый email получает сессию только для подтверждения', () => {
  const u = { status: 'active', email_confirmed: false };
  const d = decideAfterCredentials(u, true);
  assert.equal(d.action, 'confirm_email');
  assert.equal(d.sessionFor, 'unverified');
});

test('мьют не мешает входу', () => {
  // Ограничение касается создания материалов, а не пользования сервисом.
  const d = decideAfterCredentials({ status: 'muted', email_confirmed: true }, true);
  assert.equal(d.action, 'signin');
});

test('аккаунт в статусе удаления не пускает дальше', () => {
  const d = decideAfterCredentials({ status: 'deleting', email_confirmed: true }, true);
  assert.equal(d.action, 'delete_pending');
});

test('слишком длинный пароль отклоняется до хеширования', async () => {
  // Иначе стройная вредоносная нагрузка съедает процессор: DoS на входе.
  const long = 'я'.repeat(AUTH.passwordMax + 1);
  const r = await authenticate('a@b.c', long, { password_hash: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'credentials');
});

// ─── Лимиты перебора (R-SEC-05) ───────────────────────────────────────────────

test('до порога задержки нет', () => {
  for (let i = 0; i < AUTH.attemptsPerAccount - 1; i++) {
    recordFailure('a@b.c', '1.1.1.1');
  }
  assert.equal(delayFor('a@b.c'), 0);
});

test('задержка растёт и упирается в потолок', () => {
  // Число попыток считается от настроек, а не задано константой: раньше
  // потолок был в тысячу раз меньше первого шага и достигался сразу, так
  // что двенадцати попыток хватало на любые настройки. Теперь — нет.
  const steps = Math.ceil(Math.log2(AUTH.delayMaxMs / AUTH.delayStepMs)) + 1;
  const attempts = AUTH.attemptsPerAccount + steps + 1;

  const times = [];
  for (let i = 0; i < attempts; i++) {
    recordFailure('a@b.c', '1.1.1.1');
    times.push(delayFor('a@b.c'));
  }
  const delays = times.slice(AUTH.attemptsPerAccount - 1);
  for (let i = 1; i < delays.length; i++) {
    assert.ok(delays[i] >= delays[i - 1], 'задержка должна не убывать');
  }
  assert.ok(delays.at(-1) <= AUTH.delayMaxMs, 'задержка превысила потолок');
  assert.ok(delays.at(-1) === AUTH.delayMaxMs, 'потолок должен достигаться');
});

test('окно перебора действительно пятнадцать минут', async () => {
  // Проверка на время: счётчик обязан пережить паузу между попытками.
  // Раньше окно было 0.9 секунды, и защита от перебора не работала вовсе —
  // пять неудач и пауза сбрасывали счёт.
  recordFailure('окно@a.b', '2.2.2.2');
  recordFailure('окно@a.b', '2.2.2.2');
  recordFailure('окно@a.b', '2.2.2.2');
  assert.equal(needsProofOfWork('окно@a.b'), true, 'три неудачи включают проверку');

  const { _reset } = await import('../src/services/auth/limits.js');
  _reset();
  recordFailure('окно@a.b', '2.2.2.2');
  const far = Date.now() + AUTH.attemptsWindowMs + 1000;
  assert.equal(needsProofOfWork('окно@a.b', far), false, 'после окна счётчик обнуляется');
});

test('задержка не блокирует чужой аккаунт', () => {
  // Главное требование R-SEC-05: блокировка аккаунта — это вектор отказа
  // в обслуживании, злоумышленник должен уметь заблокировать любого.
  for (let i = 0; i < 20; i++) recordFailure('victim@example.com', '1.1.1.1');
  assert.equal(delayFor('other@example.com'), 0);
});

test('счётчик сбрасывается после успешного входа', () => {
  for (let i = 0; i < 8; i++) recordFailure('a@b.c', '1.1.1.1');
  assert.ok(delayFor('a@b.c') > 0);
  recordSuccess('a@b.c');
  assert.equal(delayFor('a@b.c'), 0);
});

test('окно лимита истекает', () => {
  const now = Date.now();
  for (let i = 0; i < 8; i++) recordFailure('a@b.c', '1.1.1.1', now);
  assert.ok(delayFor('a@b.c', now) > 0);
  // Позже окна попытки забываются: человек может вернуться через час.
  assert.equal(delayFor('a@b.c', now + AUTH.attemptsWindowMs + 1000), 0);
});

test('лимит по IP считается отдельно от аккаунта', () => {
  for (let i = 0; i < AUTH.attemptsPerIp; i++) recordFailure(`u${i}@b.c`, '9.9.9.9');
  assert.equal(ipLimited('9.9.9.9'), true);
  assert.equal(ipLimited('8.8.8.8'), false);
});

test('ключ аккаунта не содержит адрес', () => {
  const key = accountKey('person@example.com');
  assert.ok(!key.includes('person'));
  assert.ok(!key.includes('@'));
});

// ─── Невидимая проверка (R-SEC-34) ────────────────────────────────────────────

test('проверка включается после трёх неудач и не раньше', () => {
  assert.equal(needsProofOfWork('a@b.c'), false);
  recordFailure('a@b.c', '1.1.1.1');
  recordFailure('a@b.c', '1.1.1.1');
  assert.equal(needsProofOfWork('a@b.c'), false, 'включается после трёх, а не после двух');
  recordFailure('a@b.c', '1.1.1.1');
  assert.equal(needsProofOfWork('a@b.c'), true);
});

test('задача решается и выдаётся один раз', () => {
  const key = accountKey('a@b.c');
  const challenge = issueChallenge(key);
  assert.ok(challenge.length > 16);

  const nonce = solve(challenge, AUTH.powZeros);
  assert.equal(verifyChallenge(key, nonce), true);
  // Повторное использование не работает: иначе решение можно перепродавать.
  assert.equal(verifyChallenge(key, nonce), false);
});

test('неверное решение отклоняется', () => {
  const key = accountKey('a@b.c');
  issueChallenge(key);
  assert.equal(verifyChallenge(key, 'wrong'), false);
  assert.equal(verifyChallenge(key, undefined), false);
  assert.equal(verifyChallenge(key, 'x'.repeat(200)), false);
});

test('решение чужой задачи не подходит', () => {
  const mine = accountKey('a@b.c');
  const theirs = accountKey('d@e.f');
  const challenge = issueChallenge(theirs);
  const nonce = solve(challenge, AUTH.powZeros);
  assert.equal(verifyChallenge(mine, nonce), false);
});

test('просроченная задача не принимается', () => {
  const key = accountKey('a@b.c');
  const challenge = issueChallenge(key);
  const nonce = solve(challenge, AUTH.powZeros);
  // Срок пять минут; проверяем без ожидания — подменяем время выдачи.
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60 * 1000;
  try {
    assert.equal(verifyChallenge(key, nonce), false);
  } finally {
    Date.now = realNow;
  }
});

/**
 * Подбирает nonce, удовлетворяющий числу ведущих нулей.
 * Тот же алгоритм, что в браузере: без возможности решить задачу тест
 * проверял бы не сервер, а свою фантазию о нём.
 */
function solve(challenge, zeros) {
  for (let n = 0; n < 5_000_000; n++) {
    const h = crypto.createHash('sha256').update(challenge + n, 'utf8').digest('hex');
    if (h.startsWith('0'.repeat(zeros))) return String(n);
  }
  throw new Error('не нашлось решения');
}