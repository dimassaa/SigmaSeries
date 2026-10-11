// S-19 — форма входа.
//
// Спецификация: SCREENS S-19 «форма, ошибки сразу в поле, ссылка на
// восстановление». Требования: R-A11Y-11 (подписи связаны с полями,
// ошибки названы текстом и объявляются), R-SEC-08 (возврат только внутренний).

import { html, raw, attr } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * @param {object} ctx
 * @param {string} ctx.locale
 * @param {string} ctx.csrf
 * @param {string} [ctx.challenge] задача невидимой проверки
 * @param {object} ctx.values значения полей, чтобы не заставлять вводить заново
 * @param {string|null} ctx.error текст ошибки формы
 * @param {string} ctx.returnTo
 */
export function signinView(ctx) {
  const { locale, csrf, challenge, powZeros, values = {}, error, returnTo = '/' } = ctx;

  const field = (id, labelKey, opts) => {
    const value = opts.value ?? '';
    const invalid = opts.invalid;
    return html`
    <div class="field${invalid ? ' field--invalid' : ''}">
      <label class="field__label" for="${id}">${t(locale, labelKey)}</label>
      <input class="field__input" id="${id}" name="${id}" type="${opts.type}"
             autocomplete="${opts.autocomplete}"
             ${invalid ? raw('aria-invalid="true" aria-describedby="' + id + '-error"') : ''}
             value="${value}" required>
      ${when2(invalid, () => html`<p class="field__error" id="${id}-error">${opts.error}</p>`)}
    </div>`;
  };

  return html`
<section class="block block--form">
  <h1 class="form__title">${t(locale, 'signin.heading')}</h1>

  <!-- Ошибка объявляется, но фокус на неё не переносится: перенос фокуса
       на сообщение мешает тем, кто читает с экрана (R-A11Y-12). -->
  <div class="form__status" role="alert" aria-live="assertive">
    ${when2(error, () => html`<p class="form__error">${error}</p>`)}
  </div>

  <form class="form" method="post" action="/${locale}/login" novalidate>
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="next" value="${returnTo}">
    ${when2(challenge, () => html`<input type="hidden" name="pow" id="pow"
        data-challenge="${challenge}" data-zeros="${powZeros}">`)}

    ${field('email', 'signin.email', {
      type: 'text', autocomplete: 'email', value: values.email ?? '',
      invalid: error === t(locale, 'signin.error.credentials'),
      error: t(locale, 'signin.error.required'),
    })}

    ${field('password', 'signin.password', {
      type: 'password', autocomplete: 'current-password', value: '',
      invalid: error === t(locale, 'signin.error.credentials'),
      error: t(locale, 'signin.error.required'),
    })}

    <button class="button form__submit" type="submit">${t(locale, 'signin.submit')}</button>
  </form>

  <p class="form__links">
    <a href="/${locale}/password-reset">${t(locale, 'signin.forgot')}</a>
  </p>
  <p class="form__links">
    ${t(locale, 'signin.noAccount')} <a href="/${locale}/register">${t(locale, 'signin.register')}</a>
  </p>

  ${when2(challenge, () => html`<p class="form__pow" aria-hidden="true">${t(locale, 'signin.pow')}</p>`)}
</section>`;
}

/** Условный фрагмент внутри шаблона: импорт when здесь лишний цикл. */
function when2(condition, fn) {
  return condition ? raw(fn().__raw) : raw('');
}

export { attr };