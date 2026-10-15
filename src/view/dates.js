// Подписи дат (`R-I18N-05`).
//
// Один компонент на все экраны, где видна дата выхода: сезон, серия, календарь,
// панель «Предстоящие», закладки. Три разные подписи на трёх экранах означали
// бы, что человек видит разное об одном и том же выходе.
//
// «Сегодня» считается по поясу посетителя, а не по серверу: фраза «сегодня
// выходит» при поясе на сутки позади — это вчера, и человек получит день, в
// котором ничего не выходит.

import { t } from '../i18n/strings.js';
import { DEFAULT_TIMEZONE, todayIn } from '../services/timezone.js';

/** Разность в днях между двумя календарными датами. */
export function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/**
 * Подпись даты выхода: «сегодня», «завтра», «через N дней», иначе дата.
 *
 * @param {string} locale
 * @param {string|null} date `YYYY-MM-DD` или `null`
 * @param {string} [today] сегодняшняя дата посетителя `YYYY-MM-DD`
 * @returns {string}
 */
export function releaseLabel(locale, date, today = todayIn(DEFAULT_TIMEZONE)) {
  if (!date) return t(locale, 'date.unknown');

  const days = daysBetween(today, date);
  if (days === 0) return t(locale, 'date.today');
  if (days === 1) return t(locale, 'date.tomorrow');
  if (days > 1 && days < 4) return t(locale, 'date.inDays', { count: days });

  return fullDate(locale, date);
}

/**
 * Дата словами: 12 октября 2026 / 12 October 2026.
 *
 * @param {string} locale
 * @param {string} date `YYYY-MM-DD`
 * @returns {string}
 */
export function fullDate(locale, date) {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

/**
 * Название месяца с годом: «Октябрь 2026».
 *
 * @param {string} locale
 * @param {number} year
 * @param {number} month 1–12
 * @returns {string}
 */
export function monthTitle(locale, year, month) {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ru-RU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/**
 * Короткое название дня недели: «пн», «Mon».
 *
 * @param {string} locale
 * @param {number} index 0 — понедельник
 * @returns {string}
 */
export function weekdayShort(locale, index) {
  // 4 января 2024 — понедельник: от него считаем семь дней недели.
  const date = new Date(Date.UTC(2024, 0, 4 + index));
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ru-RU', {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * Смещение месяца: `month = 12` превращается в январь следующего года.
 *
 * @param {number} year
 * @param {number} month 1–12
 * @param {number} delta
 * @returns {{year: number, month: number}}
 */
export function shiftMonth(year, month, delta) {
  const zeroBased = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}