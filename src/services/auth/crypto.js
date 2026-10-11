// Шифрование адреса и слепой индекс.
//
// R-SEC-26: ключи раздельные для сессий, шифрования и HMAC, и лежат вне
// репозитория. Общий секрет связал бы подсистемы: его ротация ломала бы
// разом и сессии, и поиск по адресу, поэтому здесь три независимых ключа —
// SESSION_SECRET в модуле сессий, BLIND_INDEX_SECRET и ADDRESS_SECRET здесь.
//
// Формат хранения: версия, затем IV, тег, шифротекст. Версия в первом байте
// нужна не для красоты: значение, записанное прошлой сборкой, должно читаться
// после смены формата, а не превращаться в мусор.

import crypto from 'node:crypto';

/** Версия формата: первая, менять только вместе с миграцией данных. */
export const VERSION = 1;

/** AES-256-GCM: 12 байт IV, 16 байт тега. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Ключ из строки окружения.
 *
 * sha256, а не scrypt: ключи генерируются как `openssl rand -hex 32`, то
 * есть несут свою энтропию, и растягивать нечего. На пароле от человека
 * растягивать было бы нужно — но паролем здесь не является ничего.
 *
 * @param {string} name имя переменной окружения
 * @returns {Buffer} 32 байта
 */
function keyOf(name) {
  const secret = process.env[name];
  if (!secret) {
    // Молча работать «как-то» нельзя: без ключа адрес либо не найдётся,
    // либо не расшифруется, и человек увидит это как «аккаунта нет».
    throw new Error(`Не задан ${name}: без него данные пользователей недоступны`);
  }
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * Слепой индекс адреса для поиска в базе.
 *
 * HMAC, а не обычный хеш: перебор по словарю адресов даёт продающиеся
 * списки, а HMAC без ключа не даёт ничего.
 *
 * @param {string} email нормализованный адрес
 * @returns {Buffer} 32 байта — то, что лежит в `e_user.email_blind_idx`
 */
export function blindIndex(email) {
  return crypto.createHmac('sha256', keyOf('BLIND_INDEX_SECRET'))
    .update(String(email).toLowerCase(), 'utf8')
    .digest();
}

/**
 * Шифрует значение для хранения.
 *
 * @param {string} value открытый текст (адрес, секрет TOTP)
 * @param {string} purpose назначение: метка входит в AAD, поэтому шифротекст
 *   из одного поля нельзя подставить в другое
 * @returns {Buffer} версия, IV, тег, шифротекст
 */
export function encryptValue(value, purpose) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyOf('ADDRESS_SECRET'), iv);
  cipher.setAAD(aad(purpose));
  const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);

  return Buffer.concat([
    Buffer.from([VERSION]),
    iv,
    cipher.getAuthTag(),
    body,
  ]);
}

/**
 * Расшифровывает значение из базы.
 *
 * @param {Buffer|null} stored значение из колонки BYTEA
 * @param {string} purpose назначение, обязано совпасть с тем, чем шифровали
 * @returns {string|null} открытый текст; null, если в колонке ничего не было
 * @throws если значение подменено, ключ не тот, формат неизвестен или
 *   назначение не то — молча отдавать «нечитаемое» значение нельзя
 */
export function decryptValue(stored, purpose) {
  // Пользователи, заведённые до появления шифрования, имеют NULL: адрес у
  // них не восстановить, но и ронять из-за этого страницу незачем.
  if (stored === null || stored === undefined) return null;
  if (!Buffer.isBuffer(stored)) throw new Error('Шифр адреса ожидается Buffer, а пришёл другой тип');
  if (stored.length < 1 + IV_BYTES + TAG_BYTES || stored[0] !== VERSION) {
    throw new Error(`неизвестная версия формата шифра: ${stored[0]}`);
  }

  const iv = stored.subarray(1, 1 + IV_BYTES);
  const tag = stored.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = stored.subarray(1 + IV_BYTES + TAG_BYTES);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyOf('ADDRESS_SECRET'), iv);
    decipher.setAAD(aad(purpose));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // Причины три — ключ, подмена байта, чужое назначение, — и различить их
    // по сообщению нельзя: это была бы подсказка атакующему. Родителю
    // достаточно знать, что значение непригодно.
    throw new Error(
      'не удалось расшифровать значение: ключ не тот или данные подменены (ADDRESS_SECRET)',
    );
  }
}

/** AAD: назначение и версия, чтобы смена формата ломала чтение, а не молчала. */
function aad(purpose) {
  if (!purpose) throw new Error('Назначение обязательно: без метки шифротексты неразличимы');
  return Buffer.from(`v${VERSION}:${purpose}`, 'utf8');
}