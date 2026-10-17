// Описание устройства из заголовка User-Agent (F-01-03 §4, S-32 «Безопасность»).
//
// Человек смотрит на список устройств, чтобы понять, откуда вход. Сырой
// User-Agent для этого не годится: «Mozilla/5.0 (Windows NT 10.0; Win64; x64)
// AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36» — это
// четыре строки технического текста вместо двух слов «Chrome · Windows».
//
// Разбор сознательно неполный: настоящие браузеры различают сотни строк, а
// список устройств отвечает на вопрос «откуда вошли», а не «какая точная
// сборка». Правила упорядочены по вложенности: Edge присылает «Chrome», Chrome
// присылает «Safari», поэтому первым проверяется самый специфичный признак.
//

import crypto from 'node:crypto';

/** Что показывать в списке устройств, если браузер не опознан. */
const UNKNOWN = '—';

/** Предел длины подписи: список выгружается в файл, а колонка без CHECK. */
const LABEL_MAX = 120;

/**
 * Браузеры. Порядок обязателен: `Edg` встречается вместе с `Chrome`, а
 * `Chrome` — вместе с `Safari`, поэтому специфичное идёт первым.
 */
const BROWSERS = [
  [/Edg[ea]?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Version\/.*Safari|Safari\//, 'Safari'],
];

/**
 * Системы. Порядок тоже обязателен: iPhone и iPad содержат «Mac OS X», а
 * Android содержит «Linux», поэтому мобильные проверяются первыми.
 */
const SYSTEMS = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux|X11/, 'Linux'],
];

/**
 * Подпись устройства для списка S-32.
 *
 * Языка в подписи нет намеренно: она хранится в базе и показывается в обоих
 * интерфейсах, а надпись на русском в английском экране выглядела бы ошибкой.
 * Названия браузеров и систем — собственные имена, они переводятся одинаково.
 *
 * @param {string|undefined|null} userAgent значение заголовка `User-Agent`
 * @returns {string} «браузер · система», а для нераспознанного — обрезанный
 *   заголовок. Строка всегда непустая: столбец `device_label` NOT NULL.
 */
export function deviceLabel(userAgent) {
  const ua = String(userAgent ?? '').trim();
  if (!ua) return UNKNOWN;

  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1];

  if (browser && system) return `${browser} · ${system}`;
  // Узнанная только половина полезнее отката к сырому заголовку: «Chrome»
  // говорит человеку больше, чем «Mozilla/5.0 (X11; …)».
  if (browser || system) return browser ?? system;
  return ua.length > LABEL_MAX ? `${ua.slice(0, LABEL_MAX - 1)}…` : ua;
}

/**
 * Хеш идентификатора сессии для строки `e_session` (F-01-03 §4).
 *
 * Идентификатор входить позволяет, поэтому в таблице он не лежит — лежит
 * хеш. Обратного хеша у SHA-256 нет, и это ровно то, что нужно: утечка таблицы
 * не даёт войти в чужую сессию.
 *
 * @param {string} sid идентификатор сессии (cookie)
 * @returns {string}
 */
export function sessionHash(sid) {
  return crypto.createHash('sha256').update(String(sid), 'utf8').digest('base64url');
}

/**
 * Усечённый адрес сети для показа в списке устройств (F-01-03 §4).
 *
 * Обрезается по границе выдачи: /24 для IPv4 и /48 для IPv6. Это самый мелкий
 * блок, который операторы выдают одному абоненту, поэтому по показанному
 * адресу конкретного человека не восстановить, а узнать «вход из другой сети»
 * можно.
 *
 * @param {string|undefined|null} ip значение `req.ip`
 * @returns {string|null} `null`, если адрес неизвестен или это не IP
 */
export function ipPrefix(ip) {
  const value = String(ip ?? '').trim();
  // `::ffff:127.0.0.1` — тот же IPv4, записанный для IPv6: без распаковки
  // такой адрес попал бы в список как пустой префикс IPv6.
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value)?.[1] ?? value;
  const parts4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\./.exec(v4);
  if (parts4) return `${parts4[1]}.${parts4[2]}.${parts4[3]}.0/24`;

  const v6 = value.split('%')[0].split(':');
  if (v6.length >= 6 && /^[0-9a-f]{1,4}$/i.test(v6[0] ?? '')) {
    return `${v6.slice(0, 3).join(':')}::/48`;
  }
  return null;
}