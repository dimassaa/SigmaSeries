// Страница отказа операции (№265).
//
// Отказы POST-форм раньше уходили `text/plain` без оформления: в тёмной
// теме получалась белая страница с одной служебной строкой, а назад вёл
// только браузер. Здесь тот же блок сообщений, что у служебных страниц
// ошибок (`errorPage`), с одной разницей: текст причины приходит из
// маршрута, а не из ключа каталога — у каждого отказа он свой.

import { html } from './render.js';
import { layout } from './layout.js';
import { t } from '../i18n/strings.js';

const STYLES = ['base'];

/**
 * Страница отказа с названной причиной.
 *
 * @param {string} locale
 * @param {string} message готовый текст причины (уже из каталога сообщений)
 * @returns {{__raw: string}}
 */
export function refusalPage(locale, message) {
  return layout({
    styles: STYLES,
    locale,
    path: '/error',
    title: `${t(locale, 'error.refusal.title')} — ${t(locale, 'app.title')}`,
    description: message,
    noindex: true,
    body: html`<section class="block block--message">
      <h1 class="message__title">${t(locale, 'error.refusal.title')}</h1>
      <p class="message__text">${message}</p>
      <p><a class="button" href="/${locale}/">${t(locale, 'error.notFound.home')}</a></p>
    </section>`,
  });
}

/**
 * Ответ отказа: статус и текст те же, что у прежнего `text/plain`, но в
 * общем оформлении. Подмена drop-in: аргументы — те же, что у цепочки
 * `res.status(...).type(...).send(...)`.
 *
 * @param {any} res ответ Express
 * @param {string} locale
 * @param {number} status код отказа
 * @param {string} message готовый текст причины
 */
export function refuse(res, locale, status, message) {
  return res.status(status).type('html').send(refusalPage(locale, message).__raw);
}
