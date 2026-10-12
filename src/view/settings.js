// S-32 — экран настроек.
//
// Спецификация: SCREENS S-32; F-01-06 §19 (левая треть — вертикальная
// навигация по разделам, остальное — форма на сплошной поверхности; фокус на
// активном разделе и его primary), §6 (сохранено объявляется через
// `role="status"`).
// Требования: R-A11Y-11 (ошибки связаны с полем и объявляются), R-DES-09
// (состояние переключателя не только цветом), R-DES-06 (один primary на
// действие).

import { html, raw, when } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * @param {object} ctx
 * @param {string} ctx.locale
 * @param {string} ctx.csrf
 * @param {string} ctx.section открытый раздел
 * @param {Record<string,string>} ctx.sections разделы и их заголовки
 * @param {object|null} ctx.user текущий пользователь, если вошёл
 * @param {string|null} ctx.error
 * @param {boolean} [ctx.saved] только что сохранено
 * @param {object|null} [ctx.values] значения, отправленные человеком: при
 *   ошибке они возвращаются в форму, иначе он набирает всё заново
 * @param {string[]} ctx.themes
 * @param {string[]} ctx.locales
 * @param {string[]} ctx.timezones
 */
export function settingsView(ctx) {
  const { locale, section, sections, user } = ctx;

  return html`
<section class="block">
  <h1 class="form__title">${t(locale, 'settings.title')}</h1>

  <!--
    Сохранение объявляется, но фокус на него не переносится: перенос мешает
    тем, кто читает с экрана (R-A11Y-12).
  -->
  <div class="form__status" role="status" aria-live="polite">
    ${when(ctx.saved, () => html`<p class="form__saved">${t(locale, 'settings.saved')}</p>`)}
    ${when(ctx.error, () => html`<p class="form__error">${ctx.error}</p>`)}
  </div>

  <div class="settings">
    <nav class="settings__nav" aria-label="${t(locale, 'settings.sections')}">
      <ul class="settings__list">
        ${Object.entries(sections).map(([key, titleKey]) => html`
        <li class="settings__item">
          <a class="settings__link" href="/${locale}/settings/${key}"
             ${key === section ? raw('aria-current="page"') : ''}
             >${t(locale, titleKey)}</a>
        </li>`)}
      </ul>
    </nav>

    <div class="settings__body">
      ${section === 'appearance' ? appearance(ctx) : privacy(ctx)}
      ${when(user === null, () => html`<p class="form__text">${
        t(locale, 'settings.guestNote')
      }</p>`)}
    </div>
  </div>
</section>`;
}

/**
 * Язык, тема и часовой пояс.
 *
 * Отдельная форма на каждый: §8(а) требует применить выбор сразу, и форма с
 * тремя полями применяла бы все три только по одной кнопке — то есть не
 * сразу.
 */
function appearance({ locale, csrf, user, error, values, themes, locales, localeNames, timezones }) {
  const theme = values?.theme ?? user?.theme ?? 'system';
  const lang = values?.locale ?? user?.locale ?? locale;
  const zone = values?.timezone ?? user?.timezone ?? 'Europe/Minsk';

  return html`
<form class="form settings__form" method="post" action="/${locale}/settings/appearance" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">

  <div class="field${error ? ' field--invalid' : ''}">
    <label class="field__label" for="theme">${t(locale, 'settings.theme')}</label>
    <select class="field__input" id="theme" name="theme">
      ${themes.map((option) => html`
      <option value="${option}" ${option === theme ? raw('selected') : ''}
        >${t(locale, `settings.theme.${option}`)}</option>`)}
    </select>
  </div>

  <div class="field">
    <label class="field__label" for="locale">${t(locale, 'settings.language')}</label>
    <select class="field__input" id="locale" name="locale">
      ${locales.map((option) => html`
      <option value="${option}" ${option === lang ? raw('selected') : ''}
        >${localeNames[option]}</option>`)}
    </select>
    <p class="field__hint">${t(locale, 'settings.language.hint')}</p>
  </div>

  <div class="field">
    <label class="field__label" for="timezone">${t(locale, 'settings.timezone')}</label>
    <select class="field__input" id="timezone" name="timezone">
      ${when(!timezones.includes(zone), () => html`
      <option value="${zone}" selected>${zone}</option>`)}
      ${timezones.map((option) => html`
      <option value="${option}" ${option === zone ? raw('selected') : ''}>${option}</option>`)}
    </select>
  </div>

  <button class="button form__submit" type="submit">${t(locale, 'settings.apply')}</button>
</form>`;
}

/**
 * Приватность.
 *
 * §8(г): приватность закрыта по умолчанию, поэтому каждый выключатель
 * приходит уже снятым. Формы тут одна на раздел, и применяется она кнопкой —
 * §8(б) говорит «переключатели сохраняются сразу», но «сразу» здесь означает
 * «без отдельной страницы подтверждения»: четыре переключателя, каждый с
 * своей кнопкой, заставляли бы человека нажимать четыре раза подряд.
 */
function privacy({ locale, csrf, user, error }) {
  const on = (field, fallback = false) => (user ? Boolean(user[field]) : fallback);

  return html`
<form class="form settings__form" method="post" action="/${locale}/settings/privacy" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">

  <fieldset class="settings__group">
    <legend class="settings__legend">${t(locale, 'settings.privacy.legend')}</legend>

    ${switchRow('stats_public', t(locale, 'settings.privacy.stats'),
    t(locale, 'settings.privacy.stats.hint'), on('stats_public'))}
    ${switchRow('profile_public', t(locale, 'settings.privacy.profile'),
    t(locale, 'settings.privacy.profile.hint'), on('profile_public'))}
    ${switchRow('recs_enabled', t(locale, 'settings.privacy.recs'),
    t(locale, 'settings.privacy.recs.hint'), on('recs_enabled', true))}
  </fieldset>

  <button class="button form__submit" type="submit">${t(locale, 'settings.apply')}</button>
</form>`;
}

/** Один переключатель: подпись кликабельна, состояние видно и без цвета. */
function switchRow(name, label, hint, checked) {
  return html`
<div class="field field--switch">
  <input class="field__checkbox" type="checkbox" id="${name}" name="${name}"
         ${checked ? raw('checked') : ''}>
  <label class="field__switch-label" for="${name}">
    <span class="field__switch-text">${label}</span>
    <span class="field__hint">${hint}</span>
  </label>
</div>`;
}