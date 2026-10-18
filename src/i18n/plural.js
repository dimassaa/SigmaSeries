// Множественные формы счётчиков: «1 оценка», «3 оценки», «12 оценок».
//
// Форму выбирает `Intl.PluralRules` — те же правила, что в ICU MessageFormat,
// поэтому ключи каталога названы как формы ICU: `.one`, `.few`, `.many`,
// `.other`. Без этого «{count} оценок» читалось бы как «1 оценок», а «12
// отзывов» в M4 §11 требуется именно множественной формой.
//
// Разбора сообщений нет намеренно: подстановку значений делает `t()`, здесь
// выбирается ключ.

import { t } from './strings.js';

/** Язык интерфейса для правил: у русского форм три, у английского две. */
const language = (locale) => (locale === 'en' ? 'en-GB' : 'ru-RU');

/**
 * Счётчик словами.
 *
 * @param {string} locale
 * @param {string} key основа ключа без формы: `rating.votes`
 * @param {number} count
 * @returns {string}
 */
export function tPlural(locale, key, count) {
  const form = new Intl.PluralRules(language(locale)).select(count);
  return t(locale, `${key}.${form}`, { count });
}
