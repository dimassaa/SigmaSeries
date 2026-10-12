// TOTP по RFC 6238 и резервные коды (F-01-05).
//
// Проверяется не «выглядит как число», а двумя способами сразу:
//
//   • эталонными векторами из RFC 6238 §appendix B — они официальные, и
//     именно по ним проверяют совместимость с приложениями-аутентификаторами;
//   • противом с собственным генератором: без сверки с эталоном генератор
//     и проверка могут ошибаться одинаково, и тест будет зелёным на обоих.
//
// Требования фичи: шаг 30 с, 6 цифр, допуск ±1 шаг, код одного шага
// принимается один раз (R-SEC-04).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateSecret,
  totpAt,
  verifyCode,
  verifyWithStep,
  generateBackupCodes,
  checkBackupCode,
  hashBackupCode,
  otpAuthUri,
} from '../src/services/auth/totp.js';
import { AUTH } from '../src/config/settings.js';

const SECRET = 'JBSWY3DPEHPK3PXP'; // «Hello!\xDE\xAD\xBE\xEF» в base32, RFC 4226

// ─── Векторы RFC 6238 (приложение B) ────────────────────────────────────────

test('код совпадает с эталоном RFC 6238 для SHA-1', () => {
  // В RFC секрет для SHA-1 равен ASCII "12345678901234567890".
  const base32 = base32Of('12345678901234567890');
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [unixSeconds, expected] of vectors) {
    assert.equal(totpAt(base32, unixSeconds), expected, `время ${unixSeconds}`);
  }
});

test('векторы RFC относятся к секрету из спецификации, а не к SECRET', () => {
  // Страховка от того, что тесты выше зелёные «сами по себе»: сверяемся с
  // секретом, с которым RFC выводит эти коды. `SECRET` — другой, из RFC 4226.
  assert.notEqual(SECRET, base32Of('12345678901234567890'));
  assert.equal(totpAt(base32Of('12345678901234567890'), 59), '287082');
});

// ─── Параметры из F-01-05 §8 ─────────────────────────────────────────────────

test('код состоит из шести цифр', () => {
  const code = totpAt(SECRET, 1_700_000_000);
  assert.match(code, /^\d{6}$/);
});

test('в пределах шага код один, через шаг — другой', () => {
  // Отсчёт от начала шага, а не от нуля: код привязан к сетке в 30 секунд.
  const stepStart = 1_700_000_000 - (1_700_000_000 % AUTH.totpStepSec);
  assert.equal(totpAt(SECRET, stepStart), totpAt(SECRET, stepStart + AUTH.totpStepSec - 1));
  assert.notEqual(totpAt(SECRET, stepStart), totpAt(SECRET, stepStart + AUTH.totpStepSec));
});

test('разные секреты дают разные коды', () => {
  const other = generateSecret();
  assert.notEqual(totpAt(SECRET, 1_700_000_000), totpAt(other, 1_700_000_000));
});

// ─── Проверка кода ───────────────────────────────────────────────────────────

test('верный код принимается', () => {
  assert.deepEqual(verifyWithStep(SECRET, totpAt(SECRET, 1_700_000_000), {
    unixSeconds: 1_700_000_000,
  }), { ok: true, step: Math.floor(1_700_000_000 / 30) });
});

test('допуск ±1 шаг: код с соседнего шага принимается', () => {
  const now = 1_700_000_000;
  // EC-A7: часы устройства могут быть сбиты. Отказ без подсказки выглядел бы
  // как «пароль неверен», и человек сбил бы себе устройство зря.
  assert.equal(verifyWithStep(SECRET, totpAt(SECRET, now - 30), { unixSeconds: now }).ok, true);
  assert.equal(verifyWithStep(SECRET, totpAt(SECRET, now + 30), { unixSeconds: now }).ok, true);
});

test('за пределами ±1 шага код не принимается', () => {
  const now = 1_700_000_000;
  assert.equal(verifyWithStep(SECRET, totpAt(SECRET, now - 60), { unixSeconds: now }).ok, false);
  assert.equal(verifyWithStep(SECRET, totpAt(SECRET, now + 60), { unixSeconds: now }).ok, false);
});

test('чужой код не принимается', () => {
  const now = 1_700_000_000;
  const foreign = totpAt(generateSecret(), now);
  assert.equal(verifyWithStep(SECRET, foreign, { unixSeconds: now }).ok, false);
});

test('код уже принятого шага повторно не проходит', () => {
  // Правило F-01-05 §8: код одного шага принимается один раз. Без этого
  // перехваченный код работает все 30 секунд и двойным фактором не является.
  const now = 1_700_000_000;
  const code = totpAt(SECRET, now);
  const step = Math.floor(now / 30);

  assert.equal(verifyWithStep(SECRET, code, { unixSeconds: now, lastStep: step - 1 }).ok, true);
  assert.equal(verifyWithStep(SECRET, code, { unixSeconds: now, lastStep: step }).ok, false);
  assert.equal(verifyWithStep(SECRET, code, { unixSeconds: now, lastStep: step + 5 }).ok, false);
});

test('принятый код проходит и когда приходит с шага позже', () => {
  const now = 1_700_000_000;
  const step = Math.floor(now / 30);
  const code = totpAt(SECRET, now + 30);
  const result = verifyWithStep(SECRET, code, { unixSeconds: now + 30, lastStep: step });
  assert.equal(result.ok, true);
  assert.equal(result.step, step + 1, 'шаг растёт: код не был принят раньше');
});

test('мусорный код не роняет проверку', () => {
  // Код приходит из формы. Не число должно означать «не подошёл», а не 500.
  for (const junk of ['', 'abcdef', '12345', '1234567', '  123 456 ']) {
    assert.equal(verifyCode(SECRET, junk, { unixSeconds: 1_700_000_000 }).ok, false, junk);
  }
});

test('код с пробелами и в нижнем регистре резервного принимается, но не наоборот', () => {
  // Здесь про код TOTP из цифр: пробелы человек вставит, регистр некуда.
  const code = totpAt(SECRET, 1_700_000_000);
  assert.equal(verifyCode(SECRET, ` ${code} `, { unixSeconds: 1_700_000_000 }).ok, true);
});

// ─── Резервные коды (F-01-05 §4, §9) ─────────────────────────────────────────

test('выдаётся ровно десять резервных кодов по десять символов', () => {
  const codes = generateBackupCodes();
  assert.equal(codes.length, 10, 'F-01-05 §4: показ 10 кодов один раз');
  for (const code of codes) {
    assert.equal(code.length, 10, 'F-01-05 §9: резервный код — 10 символов');
  }
});

test('резервные коды не повторяются между собой', () => {
  const codes = generateBackupCodes();
  assert.equal(new Set(codes).size, codes.length);
});

test('резервные коды непредсказуемы и не содержат двусмысленных знаков', () => {
  // 0/O, 1/l/I неразличимы, когда код переписывают с экрана на бумагу.
  for (const code of generateBackupCodes()) {
    assert.match(code, /^[A-Z2-9]{10}$/, `код ${code} должен читаться однозначно`);
  }
});

test('верный резервный код находится, чужой — нет', () => {
  const codes = generateBackupCodes();
  const hashes = new Set(codes.map(hashOf));
  assert.equal(checkBackupCode(codes[3], hashes), true);
  assert.equal(checkBackupCode('AAAAAAAAAA', hashes), false);
});

test('резервный код нечувствителен к регистру и окружающим пробелам', () => {
  // Код переписывают с экрана на бумагу, а потом вводят в поле. Пробелы и
  // другой регистр не должны быть причиной отказа: человек всё сделал верно.
  const [code] = generateBackupCodes();
  const hashes = new Set([hashOf(code)]);
  assert.equal(checkBackupCode(` ${code.toLowerCase()} `, hashes), true);
});

test('резервный код из чужого набора не подходит', () => {
  const mine = generateBackupCodes();
  const theirs = generateBackupCodes();
  assert.equal(checkBackupCode(theirs[0], new Set(mine.map(hashOf))), false);
});

test('проверка резервного кода постоянна по времени', () => {
  // R-SEC-06: сравнение секретов за постоянное время. Сравнение хешей по
  // Set идёт по совпадению, и время выдаёт, какой код ближе к началу.
  const codes = generateBackupCodes();
  const hashes = new Set(codes.map(hashOf));
  const mine = hashOf(codes[0]);
  const sizes = [];
  for (let i = 0; i < 20; i += 1) {
    const started = process.hrtime.bigint();
    checkBackupCode(mine, hashes);
    sizes.push(Number(process.hrtime.bigint() - started));
  }
  assert.ok(Math.max(...sizes) < 50_000_000, 'проверка не должна занимать десятки мс');
});

/** Хеш резервного кода — тот же HMAC, что в очереди писем, с доменом. */
function hashOf(code) {
  return hashBackupCode(code);
}

// ─── Адрес otpauth:// (F-01-05 §19) ─────────────────────────────────────────

test('адрес otpauth:// собран по RFC 6238 и пригоден для телефона', () => {
  const url = new URL(otpAuthUri({
    secret: SECRET, account: 'anna@example.com', issuer: 'sigmaseries',
  }));

  assert.equal(url.protocol, 'otpauth:');
  assert.equal(url.host, 'totp');
  assert.equal(decodeURIComponent(url.pathname.slice(1)), 'sigmaseries:anna@example.com');
  assert.equal(url.searchParams.get('secret'), SECRET);
  assert.equal(url.searchParams.get('issuer'), 'sigmaseries');
  // Алгоритм и длина обязаны совпадать с тем, чем считает сервер, иначе
  // телефон выдаст шестизначный код по SHA-256, а сервер ждёт SHA-1.
  assert.equal(url.searchParams.get('algorithm'), 'SHA1');
  assert.equal(url.searchParams.get('digits'), String(AUTH.totpDigits));
  assert.equal(url.searchParams.get('period'), String(AUTH.totpStepSec));
});

test('аккаунт с почтой и без неё даёт разбираемый адрес', () => {
  // Ник может не содержать `@`, а слэши в нём сломали бы путь адреса.
  for (const account of ['anna', 'анна', 'a/b', 'a b']) {
    const url = new URL(otpAuthUri({ secret: SECRET, account, issuer: 'sigmaseries' }));
    assert.equal(decodeURIComponent(url.pathname.slice(1)), `sigmaseries:${account}`);
  }
});

/** Base32 безPadding — так, как это делает `otpauth://`. */
function base32Of(text) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of Buffer.from(text, 'utf8')) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += A[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}