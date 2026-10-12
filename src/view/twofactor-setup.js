// S-23 — настройка 2FA: QR, ключ текстом, поле кода.
//
// F-01-05 §4: QR-код **и ключ текстом** — для тех, кто не может сканировать.
// Без ключа текстом человек без камеры (или с камерой, которая не работает)
// не настроит 2FA вовсе, а обязан он это по должности.
//
// §19: QR слева, ключ и поле кода справа; фокус — на поле кода.

import { html, raw, when } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * @param {object} ctx
 * @param {string} ctx.locale
 * @param {string} ctx.csrf
 * @param {{secret:string, codes:string[], uri:string}} ctx.setup
 * @param {string|null} ctx.error
 * @param {string} ctx.qr готовый SVG
 */
export function setupView(ctx) {
  const { locale, setup, qr, error } = ctx;
  const bad = Boolean(error);

  return html`
<section class="block block--form">
  <h1 class="form__title">${t(locale, 'twoFactor.setup.title')}</h1>
  <p class="form__text">${t(locale, 'twoFactor.setup.lead')}</p>

  <div class="form__status" role="alert" aria-live="assertive">
    ${when(bad, () => html`<p class="form__error">${error}</p>`)}
  </div>

  <div class="setup">
    <div class="setup__qr">
      ${when(qr, () => raw(qr))}
      <p class="field__hint">${t(locale, 'twoFactor.setup.scan')}</p>
    </div>

    <form class="form" method="post" action="/${locale}/2fa/setup" novalidate>
      <input type="hidden" name="csrf" value="${ctx.csrf}">

      <div class="field">
        <span class="field__label" id="secret-label">${t(locale, 'twoFactor.setup.secret')}</span>
        <!--
          Ключ в тексте: без него человек, который не может сканировать QR,
          не настроит 2FA вовсе. Копируется одним нажатием.
        -->
        <output class="setup__secret" for="secret-label" data-copy-source>${setup.secret}</output>
      </div>

      <div class="field${bad ? ' field--invalid' : ''}">
        <label class="field__label" for="code">${t(locale, 'twoFactor.setup.code')}</label>
        <input class="field__input" id="code" name="code" type="text"
               inputmode="numeric" autocomplete="one-time-code"
               autocapitalize="off" spellcheck="false" maxlength="6"
               pattern="[0-9]*" required autofocus
               ${when(bad, () => raw('aria-invalid="true" aria-describedby="setup-error"'))}>
        ${when(bad, () => html`<p class="field__error" id="setup-error">${error}</p>`)}
      </div>

      <button class="button form__submit" type="submit">${t(locale, 'twoFactor.setup.submit')}</button>
    </form>
  </div>
</section>`;
}