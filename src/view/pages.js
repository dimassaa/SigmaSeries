// Служебные страницы: «О проекте и данных», правила сообщества и
// «Конфиденциальность и cookies» (F-00-05, S-40…S-42).
//
// Текст статический и версионируется в репозитории: он не должен зависеть от
// наполнения каталога, и его правка — это правка документа, а не данных.
//
// Страницы отдаются без персонализации и без обращения к базе (F-00-05 §9).

import { html } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * Страница «О проекте и данных».
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object|null} args.account
 * @returns {object} разметка страницы
 */
export function aboutView({ locale, account = null }) {
  return html`
<section class="block block--page">
  <h1 class="message__title">${t(locale, 'page.about.title')}</h1>
  <p class="message__text">${t(locale, 'page.about.lead')}</p>
  <p class="message__text">${t(locale, 'page.about.data')}</p>
  <p class="message__text">
    <a href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer"
      >${t(locale, 'page.about.tmdb')}</a>
  </p>
  <p class="message__text">${t(locale, 'page.about.attribution')}</p>
  <p class="message__text">${t(locale, 'page.about.missing')}</p>
  <p class="message__text">${t(locale, 'page.about.contact')}</p>
</section>`;
}

/**
 * Страница «Правила сообщества».
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object|null} args.account
 * @returns {object}
 */
export function rulesView({ locale, account = null }) {
  return html`
<section class="block block--page">
  <h1 class="message__title">${t(locale, 'page.rules.title')}</h1>
  <p class="message__text">${t(locale, 'page.rules.lead')}</p>
  <p class="message__text">${t(locale, 'page.rules.forbidden')}</p>
  <p class="message__text">${t(locale, 'page.rules.spoilers')}</p>
  <p class="message__text">${t(locale, 'page.rules.check')}</p>
  <p class="message__text">${t(locale, 'page.rules.cooldown')}</p>
</section>`;
}

/**
 * Страница «Конфиденциальность и cookies».
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object|null} args.account
 * @returns {object}
 */
export function privacyView({ locale, account = null }) {
  return html`
<section class="block block--page">
  <h1 class="message__title">${t(locale, 'page.privacy.title')}</h1>
  <p class="message__text">${t(locale, 'page.privacy.lead')}</p>
  <p class="message__text">${t(locale, 'page.privacy.what')}</p>
  <p class="message__text">${t(locale, 'page.privacy.why')}</p>
  <p class="message__text">${t(locale, 'page.privacy.cookies')}</p>
  <p class="message__text">${t(locale, 'page.privacy.retention')}</p>
  <p class="message__text">${t(locale, 'page.privacy.withdraw')}</p>
</section>`;
}
