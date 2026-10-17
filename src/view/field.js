// Поле пароля с кнопкой «Показать» — общее для всех форм.
//
// Три экрана ввода пароля (вход, регистрация, новый пароль) и одна кнопка:
// свой вариант на каждом экране означал бы три надписи, из которых со
// временем остаются две, и переключатель, который на одном экране работает, а
// на другом — нет. Поведение живёт в `public/app.js` и одинаково везде.
//
// Кнопка своя, а не встроенный «глаз» браузера: у того нет доступного имени и
// он появляется не во всех браузерах. Переключение `type` — единственный
// способ показать пароль, не переписывая его вторым полем: второй экземпляр
// значения читали бы и менеджеры паролей.

import { html } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * Кнопка показа и скрытия пароля.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {string} args.id идентификатор поля, на которое она ссылается
 * @returns {object}
 */
export function revealButton({ locale, id }) {
  return html`<button class="field__reveal" type="button" data-password-toggle="${id}"
              aria-controls="${id}"
              data-show-text="${t(locale, 'password.show')}"
              data-hide-text="${t(locale, 'password.hide')}"
  >${t(locale, 'password.show')}</button>`;
}