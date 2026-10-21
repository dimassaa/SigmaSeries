// Проверка полей регистрации.
//
// Спецификация: docs/01-product/features/M1-identity.md F-01-01, правило (а) и (в).
// Требования: R-SEC-13 (валидация по схеме на сервере), R-MOD-02…05 (нормализация
// и словарь для ника), H-54 (отказ без очереди).
//
// Функции чистые и ничего не знают ни про базу, ни про HTTP: маршрут
// получает уже готовый список замечаний и показывает их у полей.

import { checkMaterial } from '../moderation/check.js';

/** Границы ника из спецификации. */
export const NICK_MIN = 3;
export const NICK_MAX = 24;

/**
 * Ники, которые нельзя занять.
 *
 * Список закрытый и осознанно короткий: расширять его «на всякий случай»
 * означает однажды отобрать имя кому-то живому, потому что оно совпало с
 * техническим термином.
 */
export const RESERVED_NICKS = new Set([
  'admin', 'administrator', 'root', 'system', 'moderator', 'support', 'help',
  'api', 'www', 'mail', 'null', 'undefined', 'anonymous', 'sigma', 'sigmaseries',
  'settings', 'login', 'logout', 'register', 'verify', 'about', 'help',
]);

export const NICK_ALLOWED = /^[\p{L}\p{N}_-]+$/u;
export const NICK_SEPARATOR = /^[_-]|[_-]$/;

export const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/u;

/**
 * Приводит адрес к нормальной форме.
 *
 * NFKC, обрезка краёв, нижний регистр. Регистр важен не для почты, а для
 * слепого индекса: без приведения «Ivan@» и «ivan@» стали бы разными
 * учётками, а человек считает их одной.
 */
export function normalizeEmail(email) {
  return String(email ?? '').normalize('NFKC').trim().toLowerCase();
}

/**
 * Проверка адреса.
 *
 * Настоящая проверка — письмо, здесь только формат. Строгие регулярные
 * выражения отсекают часть настоящих адресов и пропускают часть выдуманных,
 * поэтому проверка здесь простая и не претендует на строгость.
 *
 * @returns {string[]} замечания; пустой массив — адрес пригоден
 */
export function checkEmail(email) {
  const problems = [];
  const value = normalizeEmail(email);
  if (!value) {
    problems.push('email_required');
    return problems;
  }
  if (value.length > 254) problems.push('email_too_long');
  if (!EMAIL_RE.test(value)) problems.push('email_invalid');
  return problems;
}

/**
 * Проверка ника.
 *
 * Порядок задан спецификацией, и он важен: сначала форма, потом
 * зарезервированные слова, потом словарь модерации. Словарь проверяет уже
 * нормализованную форму — иначе «привет» с латинскими буквами проходило бы.
 *
 * @param {string} nickname
 * @param {{available?:(n:string)=>boolean|Promise<boolean>,
 *          dictionary?:{block:string[], allow:string[], available:boolean}}} [deps]
 * @returns {Promise<string[]>} коды замечаний; пустой массив — ник свободен
 */
export async function checkNickname(nickname, deps = {}) {
  const problems = [];
  const value = String(nickname ?? '').trim();

  if (!value) {
    problems.push('nick_required');
    return problems;
  }
  if (value.length < NICK_MIN) problems.push('nick_too_short');
  if (value.length > NICK_MAX) problems.push('nick_too_long');
  if (!NICK_ALLOWED.test(value)) problems.push('nick_charset');
  if (NICK_SEPARATOR.test(value)) problems.push('nick_edges');
  if (RESERVED_NICKS.has(value.toLowerCase())) problems.push('nick_reserved');

  // Словарь модерации — тем же конвейером, что и для материалов: своими
  // словами проверять ник нельзя, иначе он обходится теми же приёмами,
  // что и материал. Отказ без очереди: очередь существует для осмысленных
  // материалов, а не для автоматически отклонённого имени (H-54).
  if (!problems.length) {
    const verdict = checkMaterial({
      body: value,
      dictionary: deps.dictionary ?? { block: [], allow: [], available: true },
    });
    if (verdict.decision === 'queue') problems.push('nick_blocked');
  }

  if (typeof deps.available === 'function' && !problems.length) {
    const free = await deps.available(value);
    if (!free) problems.push('nick_taken');
  }

  return problems;
}

/**
 * Ник не должен совпадать с адресом или паролем.
 *
 * Правило (б) спецификации. Отдельно от пароля: сравнение идёт по нормализованным
 * формам, иначе «Ivan@» и «ivan@» считались бы разными.
 */
export function checkNickAgainstSecrets(nickname, { email, password }) {
  const problems = [];
  const nick = String(nickname ?? '').normalize('NFKC').trim().toLowerCase();
  if (!nick) return problems;
  if (email && nick === normalizeEmail(email)) problems.push('nick_is_email');
  if (password && nick === String(password).toLowerCase()) problems.push('nick_is_password');
  return problems;
}

/**
 * Полная проверка шага «Данные».
 *
 * @returns {Promise<{ok:boolean, problems:Record<string,string[]>}>}
 */
export async function checkRegistration({ email, nickname, password }, deps = {}) {
  const problems = {};
  const e = checkEmail(email);
  if (e.length) problems.email = e;
  const n = await checkNickname(nickname, deps);
  if (n.length) problems.nickname = n;
  const p = checkNickAgainstSecrets(nickname, { email, password });
  if (p.length) problems.nickname = [...(problems.nickname ?? []), ...p];
  return { ok: Object.keys(problems).length === 0, problems };
}

/**
 * Часовой пояс из браузера проверяется по списку IANA.
 *
 * Значение приходит с клиента и в базу попадает как есть, поэтому всё, чего
 * нет в списке, отбрасывается: иначе в базу пишется мусор, который потом
 * ломает форматирование дат у этого человека.
 */
export function checkTimezone(tz) {
  const value = String(tz ?? '');
  try {
    if (value && Intl.DateTimeFormat(undefined, { timeZone: value })) return [];
    return ['timezone_invalid'];
  } catch {
    return ['timezone_invalid'];
  }
}