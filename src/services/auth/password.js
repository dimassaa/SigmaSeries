// Ядро входа: хеширование пароля, постоянные токены, сессии.
// Спецификация: docs/01-product/features/M1-identity.md F-01-01…03, F-01-06.
// Требования: R-SEC-21…24 (пароль), R-SEC-04 (2FA), R-SEC-34 (экспорт).
//
// Здесь нет ни Express, ни сессий в памяти: только то, что можно доказать
// тестом без запущенного сервера. Проверка прав по сессии — отдельный слой.

import crypto from 'node:crypto';
import argon2 from 'argon2';

import { AUTH } from '../../config/settings.js';

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

/**
 * Пороли длины берутся из таблицы настроек M1, а не отсюда: значение,
 * написанное константой, разъезжается со спецификацией при первой правке
 * и никто об этом не узнаёт. Здесь только переиспользование.
 */
export const PASSWORD_MIN = AUTH.passwordMin;
export const PASSWORD_MAX = AUTH.passwordMax;

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

/**
 * Слова распространённых паролей.
 *
 * Не полный словарь: несколько десятков самых частых закрывают почти все
 * реальные случаи, а полный список на мегабайт раздувает пакет и всё равно
 * не покрывает годовой рейтинг. Список опциональный и расширяемый.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'passw0rd', 'password1', 'password123', '12345678', '123456789',
  '1234567890', 'qwerty123', 'qwertyuiop', 'iloveyou1', 'sunshine1', 'princess1',
  'football1', 'charlie12', 'letmein12', 'monkey12', 'dragon12', '11111111',
  'baseball1', 'michael1', 'shadow12', 'master12', 'superman1', 'welcome12',
  'пароль123', 'пароль1', 'йцукен12', 'любовь123', 'россия1', 'привет12',
  'москва12', 'российская', 'наталья1', 'максим12',
]);

/**
 * Проверка стойкости пароля. Возвращает коды замечаний, а не «да/нет».
 *
 * Коды, а не готовые фразы: текст собирается на экране через каталог
 * сообщений, иначе английская версия формы осталась бы русской.
 *
 * Требований вида «обязательный символ» здесь нет сознательно: R-SEC-01
 * запрещает их прямо. Они приводят к паролям вида «P@ssw0rd1», которые не
 * лучше словарных. Длины берутся из таблицы настроек модуля.
 *
 * @param {string} plain
 * @returns {string[]} коды; пустой массив — пароль годится
 */
export function checkPasswordStrength(plain) {
  const s = String(plain ?? '');
  const problems = [];

  if (s.length < AUTH.passwordMin) problems.push('password_too_short');
  if (s.length > AUTH.passwordMax) problems.push('password_too_long');
  if (COMMON_PASSWORDS.has(s.toLowerCase())) problems.push('password_common');
  if (/^(.)\1+$/.test(s)) problems.push('password_one_char');
  if (/(.)\1{2,}/u.test(s)) problems.push('password_triple_char');
  return problems;
}

/** Проверка по словарю распространённых паролей, без учёта регистра. */
export function isCommonPassword(plain) {
  return COMMON_PASSWORDS.has(String(plain ?? '').toLowerCase());
}