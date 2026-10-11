// Регистрация: решение о создании аккаунта.
//
// Спецификация: docs/01-product/features/M1-identity.md F-01-01.
// Требования: R-SEC-06 (одинаковый ответ для занятого и свободного email),
// R-SEC-07 (одноразовый токен 30 минут), R-SEC-01, R-SEC-31,
// EC-A1 (гонка на уникальном индексе), EC-A5 (ник занят одновременно).

import crypto from 'node:crypto';

import { checkPasswordStrength } from './password.js';
import { normalizeEmail, checkRegistration, checkTimezone } from './validate.js';
import { hashToken, makeToken } from './password.js';
import { AUTH } from '../../config/settings.js';

/** Токен подтверждения: одноразовый, 30 минут, в базе только хеш (R-SEC-07). */
export function makeVerificationToken() {
  return makeToken();
}

/** Повторное письмо: пауза и не больше пяти в час (F-01-01 §9). */
export function resendAllowed(lastSentAt, now = Date.now()) {
  if (!lastSentAt) return { ok: true, retryAfter: 0 };
  const since = now - lastSentAt;
  if (since < AUTH.resendCooldownS * 1000) {
    return { ok: false, retryAfter: Math.ceil((AUTH.resendCooldownS * 1000 - since) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

/**
 * Решение по результату проверки полей.
 *
 * Возвращает либо отказ с кодом замечания, либо готовые к записи данные.
 * Сервис не знает, что будет дальше — писать в базу это работа маршрута.
 *
 * @param {{email:string, nickname:string, password:string, locale?:string,
 *          theme?:string, timezone?:string, consent?:boolean}} input
 * @param {object} deps
 * @param {(nick:string)=>Promise<boolean>} deps.nicknameFree
 * @param {(email:string)=>Promise<boolean>} deps.emailFree
 * @param {(nick:string,email:string,password:string)=>Promise<boolean>} [deps.hashPassword]
 * @returns {Promise<{ok:boolean, code?:string, fields?:object, passwordHash?:string}>}
 */
export async function decideRegistration(input, deps) {
  const { nickname, password } = input;
  const problems = {};

  // Все замечания собираются сразу, а не по одному за подход. Иначе
  // человек с неверным адресом и коротким паролем получает одну ошибку,
  // исправляет, отправляет заново и только тогда узнаёт про пароль —
  // три круга вместо одного.
  const checked = await checkRegistration(input, { available: deps.nicknameFree });
  Object.assign(problems, checked.problems);

  Object.assign(problems, {
    password: checkPasswordStrength(password),
    timezone: checkTimezone(input.timezone ?? 'UTC'),
  });
  // Согласие — не замечание поля, а самостоятельный отказ: без него
  // аккаунт не создаётся вообще, даже если всё остальное верно.
  if (!input.consent) problems.consent = ['consent_required'];

  for (const [field, list] of Object.entries(problems)) {
    if (!list.length) delete problems[field];
  }

  if (Object.keys(problems).length) {
    return {
      ok: false,
      code: problems.consent ? 'consent_required' : 'validation',
      problems,
    };
  }

  // Ник занят двумя одновременно — это другая проверка: форма прошла
  // проверку, а место кончилось между запросами (EC-A5). Повтор перед
  // записью, иначе второй получит ошибку уникального индекса вместо
  // понятного «ник занят».
  if (!(await deps.nicknameFree(nickname))) {
    return { ok: false, code: 'validation', problems: { nickname: ['nick_taken'] } };
  }

  const emailTaken = !(await deps.emailFree(input.email));

  // R-SEC-06: ответ одинаковый. Отличается только письмо — владельцу
  // занятого адреса уходит другое, и это не упоминается в ответе страницы.
  const passwordHash = emailTaken ? null : await hashPlain(password, deps);
  const token = emailTaken ? null : makeVerificationToken();

  return {
    ok: true,
    /** Письмо шлём всегда: иначе по времени ответа перебираются занятые адреса. */
    emailTaken,
    fields: {
      email: normalizeEmail(input.email),
      nickname,
      passwordHash,
      tokenHash: token?.hash ?? null,
      locale: input.locale ?? 'ru',
      theme: input.theme ?? 'dark',
      timezone: input.timezone ?? 'UTC',
      confirmed: false,
    },
    token: token?.token ?? null,
  };
}

/** Хеширование внедрено, чтобы тест не платил за argon2 на каждый прогон. */
async function hashPlain(password, deps) {
  if (typeof deps.hashPassword === 'function') return deps.hashPassword(password);
  const { hashPassword } = await import('./password.js');
  return hashPassword(password);
}

/**
 * Проверка токена подтверждения.
 *
 * Возвращает решение, а не «да/нет»: различия между «устарел» и «неверен»
 * пользователю не показываются, но для журнала они разные.
 *
 * @param {{token_hash:Buffer, expires_at:Date, used_at:Date|null}|null} row
 * @param {string} token
 * @param {number} [now]
 */
export function verifyToken(row, token, now = Date.now()) {
  if (!row || typeof token !== 'string' || !token) {
    return { ok: false, reason: 'unknown' };
  }
  if (row.used_at) {
    return { ok: false, reason: 'used', alreadyConfirmed: true };
  }
  const expires = new Date(row.expires_at).getTime();
  if (Number.isNaN(expires) || expires <= now) {
    return { ok: false, reason: 'expired' };
  }
  // Отсутствие хеша — ошибка хранилища, а не «неверный токен»: молчаливый
  // отказ здесь выглядел бы как битая ссылка и человек пошёл бы искать
  // новую вместо того, чтобы чинить код.
  if (!row.token_hash) {
    throw new Error('Строка токена без token_hash: хранилище вернуло неполные данные');
  }
  const a = hashToken(token);
  const b = Buffer.from(row.token_hash);
  if (a.length !== b.length) return { ok: false, reason: 'unknown' };
  // Сравнение за постоянное время: иначе по времени подбирается токен.
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'unknown' };
  return { ok: true, reason: 'ok' };
}