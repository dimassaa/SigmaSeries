// Подтверждение смены адреса.
//
// Отдельный адрес от подтверждения при регистрации (`email_verify`): письма
// приходят по разным ссылкам, и совмещать их в одной странице значило бы
// различать по содержимому токена на глазах.
//
// Токен не гасится запросом (EC-A4): почтовые сканеры открывают ссылки сами.
// Действие — только POST.

import { html, raw, when } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * @param {object} ctx
 * @param {string} ctx.locale
 * @param {string} ctx.csrf
 * @param {string} ctx.token
 * @param {'await'|'stale'} ctx.state
 * @param {string|null} ctx.error
 */
export function emailChangeView(ctx) {
  const { locale, token, state } = ctx;

  return html`
<section class="block block--form">
  <h1 class="form__title">${t(locale, 'settings.email.title')}</h1>

  <div class="form__status" role="alert" aria-live="assertive">
    ${when(ctx.error, () => html`<p class="form__error">${ctx.error}</p>`)}
  </div>

  ${when(state === 'await', () => html`
  <p class="form__text">${t(locale, 'settings.email.lead')}</p>
  <form class="form" method="post" action="/${locale}/settings/email-change" novalidate>
    <input type="hidden" name="csrf" value="${ctx.csrf}">
    <input type="hidden" name="token" value="${token}">
    <button class="button form__submit" type="submit"
      >${t(locale, 'settings.email.confirm')}</button>
  </form>`)}

  ${when(state === 'stale', () => html`
  <p class="form__text">${t(locale, 'settings.email.stale')}</p>
  <p class="form__links">
    <a href="/${locale}/settings/security">${t(locale, 'settings.email.back')}</a>
  </p>`)}
</section>`;
}