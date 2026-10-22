// Логика входа — без HTTP, без сессий, без базы.
//
// Маршрут спрашивает «что делать», а этот модуль решает. Так его можно
// покрыть тестом, не поднимая сервер, и он остаётся пригодным, когда
// маршрут переписывается.
//
// Спецификация: docs/01-product/features/M1-identity.md F-01-03.

import { AUTH, STAFF_ROLES } from '../../config/settings.js';
import { verifyPassword } from './password.js';

/**
 * Проверяет недоверенный адрес возврата.
 *
 * R-SEC-08: только внутренние относительные адреса. Проверка на префикс
 * недостаточна: «//evil.com» начинается со слэша и при этом уводит на
 * другой сайт. Поэтому нужен ровно один ведущий слэш и никаких «://».
 *
 * @param {unknown} value
 * @returns {string} безопасный адрес, либо '/' если вход не доверенный
 */
export function safeReturnTo(value) {
  const s = String(value ?? '');
  if (!s.startsWith('/')) return '/';
  if (s.startsWith('//')) return '/';
  if (s.includes('://')) return '/';
  // Управляющие символы в Location дают header injection.
  if (/[\r\n\t]/.test(s)) return '/';
  return s;
}

/**
 * Длительность сессии для роли (R-SEC-03).
 *
 * Служебные роли получают короткую сессию намеренно: окно, показанное
 * чужому человеку за плечом, не должно быть достаточным для работы.
 */
export function sessionDurations(hasStaffRole) {
  return hasStaffRole
    ? { idle: AUTH.staffIdleMs, absolute: AUTH.staffAbsoluteMs }
    : { idle: AUTH.viewerIdleMs, absolute: AUTH.viewerAbsoluteMs };
}

/**
 * Решает, что делать после проверки учётки.
 *
 * Порядок важен: бан показывается только при верном пароле. Иначе форма
 * входа становится способом проверить, зарегистрирован ли email, — а это
 * ровно то, что R-SEC-06 запрещает.
 *
 * @param {{status:string, email_confirmed:boolean}|null} user
 * @param {boolean} passwordOk
 * @returns {{action:string, reason?:string, sessionFor:string|null}}
 */
export function decideAfterCredentials(user, passwordOk) {
  if (!passwordOk) return { action: 'invalid', reason: 'credentials', sessionFor: null };

  // Дальше пароль уже верный, различать состояния можно.
  if (!user) return { action: 'invalid', reason: 'credentials', sessionFor: null };

  if (user.status === 'banned') {
    return { action: 'blocked', reason: 'banned', sessionFor: null };
  }
  if (user.status === 'muted') {
    // Мьют ограничивает создание материала, но не вход: человек не
    // перестаёт пользоваться сервисом из-за штрафа.
    return { action: 'signin', reason: 'muted', sessionFor: 'viewer' };
  }
  if (user.status === 'deleting') {
    return { action: 'delete_pending', reason: 'deleting', sessionFor: null };
  }
  if (!user.email_confirmed) {
    // Сессия только для экрана подтверждения, иначе неподтверждённый
    // аккаунт получил бы все права зрителя (F-01-03 сценарий, шаг 2).
    return { action: 'confirm_email', reason: 'unverified', sessionFor: 'unverified' };
  }
  return { action: 'signin', reason: 'ok', sessionFor: 'viewer' };
}

/**
 * Полная проверка входа: пароль сверяется всегда, даже если email не найден.
 *
 * R-SEC-06 и F-01-03: для неизвестного email сравнивается заглушка, иначе
 * по времени ответа перебираются существующие учётки.
 *
 * Проверку можно подменить: маршрут входа отдаёт её в очередь хеширования
 * (EC-A16), и подтверждение пароля занимает один из двух слотов, а не
 * обходит очередь стороной.
 *
 * @param {string} email
 * @param {string} password
 * @param {{password_hash: string}|null} user
 * @param {(plain: string, hash: string|null) => Promise<boolean>} [verify]
 */
export async function authenticate(email, password, user, verify = verifyPassword) {
  // Длина проверяется до хеширования: R-SEC-31 и F-01-03 §9, иначе
  // длинная строка съедает процессор и обслуживает DoS.
  if (typeof password !== 'string' || password.length > AUTH.passwordMax) {
    await verify(password ?? '', null); // заглушка — время выравнивается
    return { ok: false, reason: 'credentials' };
  }
  const ok = await verify(password, user?.password_hash ?? null);
  return { ok, user };
}

/** Сессия для служебной роли или обычного зрителя (R-SEC-03). */
export function sessionKind(roles) {
  return STAFF_ROLES.some((r) => (roles ?? []).includes(r)) ? 'staff' : 'viewer';
}