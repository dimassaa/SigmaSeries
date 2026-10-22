// S-84 — «Почтовый ящик разработчика».
//
// Слева список писем, справа открытое (F-01-12 §19). Открытое письмо
// показывается целиком вместе со ссылкой: ссылка и есть то, ради чего письмо
// пришло, а обрезанный адрес в тексте бесполезен и выглядит как ошибка.

import { html, raw, when } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * @param {object} ctx
 * @param {string} ctx.locale
 * @param {string} ctx.csrf
 * @param {any[]} ctx.letters письма, свежие первыми
 * @param {string} ctx.mode действующий режим
 * @param {string|null} ctx.badge предупреждение о режиме или null
 * @param {any} ctx.opened открытое письмо
 * @param {string|null} ctx.error
 */
export function mailboxView(ctx) {
  const { locale, letters, opened } = ctx;
  const next = ctx.mode === 'devbox' ? 'smtp' : 'devbox';

  return html`
<section class="block">
  <h1 class="form__title">${t(locale, 'mailbox.title')}</h1>

  ${when(ctx.badge, () => html`
  <p class="form__warning" role="status">${ctx.badge}</p>`)}

  <div class="form__status" role="alert" aria-live="assertive">
    ${when(ctx.error, () => html`<p class="form__error">${ctx.error}</p>`)}
  </div>

  <div class="mailbox">
    <ul class="mailbox__list">
      ${when(letters.length, () => html`${letters.map((letter) => html`
      <li class="mailbox__item">
        <a class="mailbox__link" href="/${locale}/admin/mailbox?token=${letter.link?.split('token=')[1] ?? ''}"
           ${letter === opened ? raw('aria-current="true"') : ''}
           >${letter.subject}</a>
        <span class="mailbox__meta">${t(locale, `mailbox.kind.${letter.kind}`)}</span>
        <span class="mailbox__date">${new Date(letter.created_at)
          .toISOString().slice(0, 16).replace('T', ' ')}</span>
      </li>`)}`)}
      ${when(!letters.length, () => html`
      <li class="mailbox__item mailbox__item--empty">${t(locale, 'mailbox.empty')}</li>`)}
    </ul>

    <div class="mailbox__letter">
      ${opened ? html`
      <h2 class="settings__subhead">${opened.subject}</h2>
      <p class="field__hint">${t(locale, `mailbox.kind.${opened.kind}`)}</p>
      <pre class="mailbox__body">${opened.body}</pre>
      ${when(opened.link, () => html`
      <p class="form__links">
        <a href="${opened.link}">${t(locale, 'mailbox.open')}</a>
      </p>`)}`
      : html`<p class="form__text">${t(locale, 'mailbox.pick')}</p>`}
    </div>
  </div>

  <form class="form settings__form" method="post" action="/${locale}/admin/mailbox" novalidate>
    <input type="hidden" name="csrf" value="${ctx.csrf}">
    <input type="hidden" name="next" value="${next}">

    <h2 class="settings__subhead">${t(locale, 'mailbox.mode.title')}</h2>
    <p class="field__hint">${t(locale, 'mailbox.mode.hint')}</p>
    <p class="settings__state">${t(locale, `mailbox.mode.current.${ctx.mode}`)}</p>

    <div class="field">
      <label class="field__label" for="mailbox_password">${t(locale, 'settings.security.confirm')}</label>
      <input class="field__input" id="mailbox_password" name="password" type="password"
             autocomplete="current-password" required>
    </div>

    <button class="button form__submit" type="submit"
      >${t(locale, `mailbox.mode.switch.${next}`)}</button>
  </form>
</section>`;
}