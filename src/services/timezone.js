// Часовой пояс посетителя (H-72).
//
// Пояс гостя живёт в cookie: сервер не знает, где находится человек, а календарь
// и подписи дат без этого врут на сутки у половины планеты. Пока cookie нет —
// Europe/Minsk, пояс проекта. Cookie ставит скрипт браузера из `Intl`.
//
// Значение приходит от клиента, поэтому проверяется списком поясов среды: иначе
// мусор в cookie превратил бы форматирование в исключение на каждом запросе.
// Пользователь, вошедший в аккаунт, имеет пояс в профиле — он важнее cookie,
// но это отдельный слой (S-32).

import { DEFAULT_TIMEZONE } from '../config/settings.js';

export { DEFAULT_TIMEZONE };

/** Имя cookie с поясом. */
export const TIMEZONE_COOKIE = 'tz';

/** Пояса, которые среда знает: `null` — ещё не смотрели, `false` — списка нет. */
let known = null;

/**
 * Пригоден ли пояс: его знает среда.
 *
 * @param {string} timeZone
 * @returns {boolean}
 */
export function isKnownTimeZone(timeZone) {
  if (known === null) {
    try {
      known = new Set(Intl.supportedValuesOf('timeZone'));
    } catch {
      known = false;
    }
  }
  if (known !== false) return known.has(timeZone);

  // Списка нет (среда без `supportedValuesOf`): проверяем попыткой формата.
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Пояс из запроса: cookie посетителя, иначе пояс проекта.
 *
 * Заголовок `Cookie` разбирается здесь, а не библиотекой: в приложении уже
 * есть такой разбор (`mail/browser.js`), а тянуть `cookie-parser` ради одного
 * значения — значит менять зависимости без нужды.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
export function timezoneOf(req) {
  const raw = readCookie(req?.headers?.cookie, TIMEZONE_COOKIE);
  if (!raw) return DEFAULT_TIMEZONE;

  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // Битая кодировка — повод взять запасной пояс, а не повод падать на
    // каждом запросе.
  }
  return isKnownTimeZone(value) ? value : DEFAULT_TIMEZONE;
}

/**
 * Значение cookie из заголовка.
 *
 * @param {string|undefined} header
 * @param {string} name
 * @returns {string}
 */
function readCookie(header, name) {
  if (!header) return '';
  const pair = header.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return pair === undefined ? '' : pair.slice(name.length + 1);
}

/**
 * Дата по календарю посетителя: его «сегодня» не обязано совпадать с
 * серверным.
 *
 * @param {string} timeZone
 * @param {Date} [now]
 * @returns {string} `YYYY-MM-DD`
 */
export function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}