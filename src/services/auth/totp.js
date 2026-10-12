// Двухфакторная проверка: TOTP по RFC 6238 и резервные коды.
//
// Алгоритм TOTP — это HMAC поверх счётчика времени, делённого на шаг, плюс
// обрезка до нужного числа цифр. Пишется здесь, а не берётся библиотекой:
// это двадцать строк, а лишняя зависимость ради них означала бы согласование
// с руководителем там, где обойтись можно своими силами (DEC-021).
//
// Совместимость с приложениями-аутентификаторами обеспечивается не
// предположениями, а сверкой с векторами из RFC 6238 §appendix B —
// `tests/auth.totp.test.js`.

import crypto from 'node:crypto';

import { encryptValue, decryptValue } from './crypto.js';
import { AUTH } from '../../config/settings.js';

/** Алфавит base32 без символов, похожих друг на друга (0/O, 1/I). */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Секрет TOTP нового аккаунта.
 *
 * 20 байт — длина из RFC 4226 §4: 80 бит при 6-значном коде и шаге 30 секунд
 * дают запас против перебора, которого хватает с большим избытком.
 *
 * @returns {string} base32 без знаков `=`
 */
export function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/**
 * Код TOTP для момента времени.
 *
 * @param {string} secret base32-секрет
 * @param {number} unixSeconds время в секундах от начала эпохи
 * @returns {string} ровно шесть цифр
 */
export function totpAt(secret, unixSeconds) {
  const counter = Math.floor(unixSeconds / AUTH.totpStepSec);
  // Счётчик — восемь байт большого порядка: RFC 4226 §5.1. Порядок байт
  // важен, и путать его — источник ошибок, которые видны только на
  // устройстве человека.
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = crypto
    .createHmac('sha1', base32Decode(secret))
    .update(buffer)
    .digest();

  // Динамическое смещение из RFC 4226 §5.3: последний бит хеша выбирает
  // четырёхбайтовое окно, из которого берётся число.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];

  return String(binary % 10 ** AUTH.totpDigits).padStart(AUTH.totpDigits, '0');
}

/**
 * Проверка кода с возвратом шага.
 *
 * Отдаётся шаг, а не только «подошёл»: шаг записывается, и следующим
 * запросом тот же код отвергается (F-01-05 §8).
 *
 * @param {string} secret base32-секрет
 * @param {string} code код из формы
 * @param {object} at
 * @param {number} at.unixSeconds текущее время
 * @param {number|null} [at.lastStep] последний принятый шаг
 * @returns {{ok: boolean, step?: number, reason?: string}}
 */
export function verifyWithStep(secret, code, { unixSeconds, lastStep = null }) {
  const cleaned = String(code ?? '').trim();
  if (!/^\d+$/.test(cleaned) || cleaned.length !== AUTH.totpDigits) {
    return { ok: false, reason: 'format' };
  }

  const current = Math.floor(unixSeconds / AUTH.totpStepSec);
  // Допуск ±1 шага (F-01-05 §8, EC-A7): часы устройства могут быть сбиты, и
  // отказ без объяснения заставил бы человека зря перенастраивать устройство.
  for (const step of [current, current - 1, current + 1]) {
    if (totpAt(secret, step * AUTH.totpStepSec) !== cleaned) continue;

    // Повтор того же шага запрещён: перехваченный код действовал бы ещё
    // полминуты, и второй фактор превращался бы в первый.
    if (lastStep !== null && step <= lastStep) return { ok: false, reason: 'replayed' };
    return { ok: true, step };
  }
  return { ok: false, reason: 'mismatch' };
}

/**
 * Проверка кода без сведений о шаге.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function verifyCode(secret, code, at) {
  const { ok, reason } = verifyWithStep(secret, code, at);
  return ok ? { ok: true } : { ok: false, reason };
}

/** Символов в резервном коде (F-01-05 §9). */
const BACKUP_CODE_LENGTH = 10;

/**
 * Десять резервных кодов (F-01-05 §4).
 *
 * @returns {string[]} десять кодов по десять символов
 */
export function generateBackupCodes(count = AUTH.backupCodeCount) {
  return Array.from({ length: count }, () => {
    // По одному байту на символ: 256 кратно 32, поэтому `% 32` не вносит
    // смещения — коды выпадают равновероятно, а не «чуть чаще» некоторые.
    const bytes = crypto.randomBytes(BACKUP_CODE_LENGTH);
    let code = '';
    for (const byte of bytes) code += BASE32[byte % BASE32.length];
    return code;
  });
}

/**
 * Хеш резервного кода.
 *
 * HMAC, а не парольный хеш: код выдаёт сервер, он короткий и одноразовый, а
 * искать его нужно одним запросом по индексу. Парольный хеш такой поиск
 * не позволяет вовсе — пришлось бы перебирать все неиспользованные строки.
 *
 * @param {string} code
 * @returns {Buffer} 32 байта
 */
export function hashBackupCode(code) {
  const secret = process.env.BLIND_INDEX_SECRET;
  if (!secret) {
    throw new Error('Не задан BLIND_INDEX_SECRET: без него резервный код не проверить');
  }
  return crypto
    .createHmac('sha256', secret)
    .update(`backup-code:${String(code).toUpperCase()}`, 'utf8')
    .digest();
}

/**
 * Есть ли такой код среди неиспользованных.
 *
 * Сравнение по всем хешам, а не поиск по `Set`: время ответа при поиске
 * выдало бы, какой код близок к началу списка (R-SEC-06 — сравнение
 * секретов за постоянное время).
 *
 * @param {string} code код из формы
 * @param {Iterable<Buffer>} hashes хеши неиспользованных кодов
 * @returns {boolean}
 */
export function checkBackupCode(code, hashes) {
  // Регистр и пробелы не важны: код переписывают с экрана на бумагу и
  // вводят руками, и отказ по такой мелочи выглядел бы как «код неверен».
  const candidate = hashBackupCode(String(code ?? '').trim());
  let found = false;
  for (const hash of hashes) {
    if (timingSafeEqual(hash, candidate)) found = true;
  }
  return found;
}

/** Сравнение за постоянное время: длина известна, содержимое — нет. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Шифрование секрета для хранения (R-SEC-04: секрет хранится зашифрованным). */
export function sealSecret(secret) {
  return encryptValue(secret, 'totp');
}

/** Чтение секрета из базы. */
export function openSecret(stored) {
  return decryptValue(stored, 'totp');
}

/** base32 без `=`: так его записывают в `otpauth://` и так его читают телефоны. */
function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Обратная операция: base32 → байты, нужные для HMAC. */
function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    // Мусорный символ в секрете означает испорченную запись: молчаливый
    // пересчёт дал бы человеку код, который никогда не совпадёт.
    if (index < 0) throw new Error(`Секрет содержит недопустимый символ: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Адрес `otpauth://` для QR-кода и для телефона.
 *
 * @param {object} at
 * @param {string} at.secret base32-секрет
 * @param {string} at.account email или ник — как человек узнает свой аккаунт
 * @param {string} at.issuer название сервиса
 * @returns {string}
 */
export function otpAuthUri({ secret, account, issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(AUTH.totpDigits),
    period: String(AUTH.totpStepSec),
  });
  return `otpauth://totp/${label}?${params}`;
}