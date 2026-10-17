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