// Ядро входа. Тесты.
// Спецификация: docs/01-product/features/M1-identity.md F-01-01…03.
// Требования: R-SEC-21…24.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hashPassword,
  verifyPassword,
  needsRehash,
  makeToken,
  hashToken,
  safeEqual,
  checkPasswordStrength,
  DUMMY_HASH,
  PASSWORD_MIN,
} from '../src/services/auth/password.js';

test('пароль хешируется и не хранится в открытом виде', async () => {
  const h = await hashPassword('очень-долгий-пароль');
  assert.ok(h.startsWith('$argon2id$'), 'ожидается argon2id');
  assert.ok(!h.includes('очень-долгий-пароль'));
});

test('один и тот же пароль даёт разные хэши', async () => {
  // Соль встроена в формат; без неё равенство хэшей выдавало бы одинаковые
  // пароли по одной базе.
  const a = await hashPassword('пароль-пример-1');
  const b = await hashPassword('пароль-пример-1');
  assert.notEqual(a, b);
});

test('правильный пароль проходит, неправильный — нет', async () => {
  const h = await hashPassword('правильный-пароль-1');
  assert.equal(await verifyPassword('правильный-пароль-1', h), true);
  assert.equal(await verifyPassword('правильный-пароль-2', h), false);
});

test('пустой хэш не проходит проверку', async () => {
  assert.equal(await verifyPassword('любой', null), false);
  assert.equal(await verifyPassword('любой', ''), false);
  assert.equal(await verifyPassword('любой', 'мусор'), false);
});

test('фиктивный хэш настоящий: без этого защита от перебора не работает', async () => {
  // R-SEC-22. Проверка пароля должна занимать одинаковое время независимо от
  // того, есть такой аккаунт или нет, иначе по времени ответа перебираются
  // существующие учётки. Для этого при пустом хэше выполняется реальная
  // проверка KDF — но только если фиктивный хэш корректен. Невалидная строка
  // падает мгновенно и защиту отменяет, причём незаметно.
  const argon2 = (await import('argon2')).default;
  let valid = true;
  try {
    await argon2.verify(DUMMY_HASH, 'что-то');
  } catch {
    valid = false;
  }
  assert.equal(valid, true, 'DUMMY_HASH должен быть разбираемым argon2-хэшем');

  const both = await Promise.all([
    verifyPassword('что-то', await hashPassword('пароль-для-замера-1')),
    verifyPassword('что-то', null),
  ]);
  assert.deepEqual(both, [false, false], 'наружу уходит один и тот же ответ');
});

test('нужна ли перехеширование при изменившихся параметрах', async () => {
  const h = await hashPassword('пароль-для-проверки-1');
  assert.equal(await needsRehash(h), null, 'актуальные параметры пересчёт не требуют');
});

// ─── Токены ───────────────────────────────────────────────────────────────────

test('токен длинный и непредсказуемый', () => {
  const { token } = makeToken();
  assert.ok(token.length >= 40, `токен слишком короткий: ${token.length}`);
});

test('два токена подряд не совпадают', () => {
  assert.notEqual(makeToken().token, makeToken().token);
});

test('в базу попадает хеш, а не сам токен', () => {
  const { token, hash } = makeToken();
  assert.ok(!hash.toString('utf8').includes(token));
  assert.equal(hashToken(token).equals(hash), true);
});

test('сравнение токенов постоянного времени не путает длину с неравенством', () => {
  const { hash } = makeToken();
  assert.equal(safeEqual(hash, hash), true);
  assert.equal(safeEqual(hash, hashToken('другой')), false);
  assert.equal(safeEqual(hash, null), false);
});

// ─── Стойкость ────────────────────────────────────────────────────────────────

test('короткий пароль отклоняется с указанием причины', () => {
  const problems = checkPasswordStrength('корот1');
  assert.ok(problems.length > 0);
  assert.ok(problems.some((p) => p.includes(String(PASSWORD_MIN))));
});

test('пароль из одного повторяющегося символа отклоняется', () => {
  assert.ok(checkPasswordStrength('ааааааааа').length > 0);
});

test('нормальный пароль проходит', () => {
  assert.deepEqual(checkPasswordStrength('сериалы-2026!'), []);
});

test('проблемы перечисляются все, а не только первая', () => {
  // Одна подсказка означает два круга правки вместо одного.
  const p = checkPasswordStrength('ааааааааа');
  assert.ok(p.length >= 2, `ожидалось несколько замечаний, получено: ${p.join(', ')}`);
});