// Ядро входа: хеширование пароля, постоянные токены, сессии.
// Спецификация: docs/01-product/features/M1-identity.md F-01-01…03, F-01-06.
// Требования: R-SEC-21…24 (пароль), R-SEC-04 (2FA), R-SEC-34 (экспорт).
//
// Здесь нет ни Express, ни сессий в памяти: только то, что можно доказать
// тестом без запущенного сервера. Проверка прав по сессии — отдельный слой.

import crypto from 'node:crypto';
import argon2 from 'argon2';

/**
 * Параметры argon2id.
 *
 * Значения — дефолты библиотеки, и они осознанно оставлены как есть: подбор
 * под конкретную машину делает хэши несравнимыми между окружениями. Менять
 * их можно только вместе с rehash при следующем входе, а не «потому что
 * быстрее на тесте».
 */
export const ARGON = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

/** Минимальная длина пароля. Меньше — не ошибка формата, а отказ. */
export const PASSWORD_MIN = 8;
/** Меньше этого хэш не проверяем: если что-то подставили, сравнивать не с чем. */
export const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$0000000000000000000000000000000000000000000';

/**
 * Хеширует пароль.
 * @param {string} plain
 * @returns {Promise<string>}argon2id-хэш в стандартном формате
 */
export function hashPassword(plain) {
  return argon2.hash(String(plain), ARGON);
}

/**
 * Сверяет пароль с хэшем.
 *
 * При пустом хэше всё равно выполняется фиктивная проверка: иначе время
 * ответа выдаёт, зарегистрирован ли email, и по нему можно перебирать
 * существующие учётки (R-SEC-22).
 *
 * @param {string} plain
 * @param {string|null} hash
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(plain, hash) {
  const target = hash || DUMMY_HASH;
  const ok = await argon2.verify(target, String(plain), ARGON).catch(() => false);
  return Boolean(hash) && ok;
}

/**
 * Нужен ли повторный хэш.
 *
 * Параметрыargon2 меняются со временем; без этого пользователь, зашедший
 * год назад, так и остался бы со старой стоимостью. Возвращается новый хэш
 * при необходимости, иначе null — вызывающий ничего не пишет.
 *
 * @param {string} hash
 * @returns {Promise<string|null>}
 */
export async function needsRehash(hash) {
  if (!hash) return null;
  if (await argon2.needsRehash(hash, ARGON)) return hashPassword(''); // формат проверяется вызывающим
  return null;
}

/**
 * Токен для подтверждения email, восстановления пароля и входа.
 *
 * Отдаётся пользователю в ссылке, поэтому должен быть непредсказуемым и
 * достаточно длинным. 32 байта из CSPRNG: 16 байт уже перебираются,
 * 32 — нет.
 *
 * @returns {{token:string, hash:Buffer}}
 */
export function makeToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

/**
 * Хранится только хеш токена, как и пароль. Токен из базы не восстановить,
 * ссылка одноразовая, а её перехват не даёт возможности войти.
 *
 * @param {string} token
 * @returns {Buffer} sha256 от токена
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest();
}

/**
 * Слепое сравнение: постоянное время.
 *
 * Обычное сравнение строк возвращает разные ответы на первом различающемся
 * байте, и по времени ответа можно подобрать значение побайтно.
 *
 * @param {Buffer} a
 * @param {Buffer} b
 */
export function safeEqual(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // Разная длина: дополняем нулями, чтобы timingSafeEqual не бросил.
  // Длина токенов фиксирована, так что это страховка, а не основной путь.
  const len = Math.max(x.length, y.length);
  const bx = Buffer.alloc(len);
  const by = Buffer.alloc(len);
  x.copy(bx);
  y.copy(by);
  return crypto.timingSafeEqual(bx, by);
}

/** Проверка стойкости пароля. Возвращает список проблем, а не «да/нет». */
export function checkPasswordStrength(plain) {
  const s = String(plain ?? '');
  const problems = [];
  if (s.length < PASSWORD_MIN) problems.push(`минимум ${PASSWORD_MIN} символов`);
  if (s.length > 200) problems.push('слишком длинный');
  if (/^(.)\1+$/.test(s)) problems.push('один повторяющийся символ');
  if (!/[^\p{L}\p{N}]/u.test(s)) problems.push('нужен символ, отличный от букв и цифр');
  if (/(.)\1{2,}/u.test(s)) problems.push('один символ повторяется трижды подряд');
  return problems;
}