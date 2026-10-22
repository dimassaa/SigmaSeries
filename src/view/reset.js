// S-22 — восстановление пароля.
//
// Спецификация: SCREENS S-22; F-01-04 §4 (запрос, письмо, форма нового
// пароля, успех), §5 (устаревшая ссылка, слабый пароль, лимит), §19 (две
// простые формы).
// Требования: R-A11Y-11 (ошибка названа текстом и связана с полем),
// R-DES-30 (подсказка о формате видна до ошибки), R-DES-27 (цвет — не
// единственный носитель состояния), R-SEC-24 (не кэшируется).
//
// Один адрес, пять состояний. Разные адреса под каждое состояние означали
// бы пять записей в реестре экранов вместо одной S-22.

import { html, raw, when } from './render.js';
import { t } from '../i18n/strings.js';
import { AUTH } from '../config/settings.js';
import { revealButton } from './field.js';

/** Заголовок первого уровня по состоянию экрана. */
const HEADINGS = {
  request: 'reset.heading',
  sent: 'reset.sent.title',
  form: 'reset.form.heading',
  stale: 'reset.stale.title',
  done: 'reset.done.title',
};

/**
 * Ключ заголовка для состояния.
 *
 * Нужен и разметке, и `<title>`: расходись они, вкладка и страница называли
 * бы одно состояние по-разному.
 */
export function headingKey(state) {
  return HEADINGS[state] ?? 'reset.heading';
}

/**
 * @param {object} ctx
 * @param {string} ctx.locale
 * @param {string} ctx.csrf
 * @param {'request'|'sent'|'form'|'stale'|'done'} ctx.state
 * @param {string} [ctx.token] токен из письма, только для состояния form
 * @param {string} [ctx.email] значение поля адреса, чтобы не вводить заново
 * @param {string|null} [ctx.error] общий текст ошибки формы
 * @param {string[]} [ctx.problems] коды замечаний к паролю
 * @param {string} [ctx.demoLink] ссылка на демо-переход без почты
 */
export function resetView(ctx) {
  const { locale, state } = ctx;

  return html`
<section class="block block--form">
  <h1 class="form__title">${t(locale, headingKey(state))}</h1>

  <!-- Ошибка объявляется, но фокус на неё не переносится: перенос мешает
       тем, кто читает с экрана (R-A11Y-12). -->
  <div class="form__status" role="alert" aria-live="assertive">
    ${when(ctx.error, () => html`<p class="form__error">${ctx.error}</p>`)}
  </div>

  ${when(state === 'request' || state === 'stale', () => requestForm(ctx))}
  ${when(state === 'form', () => newPasswordForm(ctx))}
  ${when(state === 'sent', () => html`
    ${resultBlock(ctx, 'reset.sent.text')}
    ${when(ctx.demoLink, () => html`
    <p class="form__warning">${t(locale, 'reset.demo.open')}</p>
    <p class="form__links"><a href="${ctx.demoLink}">${ctx.demoLink}</a></p>`)}`)}
  ${when(state === 'done', () => resultBlock(ctx, 'reset.done.text'))}
</section>`;
}

/**
 * Форма заявки на ссылку.
 *
 * Сама форма одна и для состояния «устаревшая ссылка»: EC-A3 требует
 * на устаревшей ссылке форму повторной заявки, а не одно объяснение.
 */
function requestForm({ locale, csrf, state, email = '' }) {
  const stale = state === 'stale';
  return html`
<p class="form__text">${t(locale, stale ? 'reset.stale.text' : 'reset.lead')}</p>
<form class="form" method="post" action="/${locale}/password/reset" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">
  <div class="field">
    <label class="field__label" for="email">${t(locale, 'reset.email')}</label>
    <input class="field__input" id="email" name="email" type="email"
           autocomplete="email" value="${email}" required>
  </div>
  <button class="button form__submit" type="submit">
    ${t(locale, stale ? 'reset.stale.submit' : 'reset.submit')}
  </button>
</form>`;
}

/** Форма нового пароля: одно поле, подсказка о длине и кнопка «Показать». */
function newPasswordForm({ locale, csrf, token = '', problems = [] }) {
  const bad = problems.length > 0;
  const params = { min: AUTH.passwordMin, max: AUTH.passwordMax };
  // Когда есть замечание, поле ссылается и на подсказку, и на ошибку:
  // человеку нужны оба текста, а не только последний.
  const describedBy = bad ? 'password-hint password-error' : 'password-hint';

  return html`
<form class="form" method="post" action="/${locale}/password/reset" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="token" value="${token}">

  <div class="field${bad ? ' field--invalid' : ''}">
    <label class="field__label" for="password">${t(locale, 'reset.password')}</label>
    <div class="field__row">
      <input class="field__input" id="password" name="password" type="password"
             autocomplete="new-password" aria-describedby="${describedBy}"
             ${when(bad, () => raw('aria-invalid="true"'))} required>
      ${revealButton({ locale, id: 'password' })}
    </div>
    <p class="field__hint" id="password-hint">${t(locale, 'reset.password.hint', params)}</p>
    ${when(bad, () => html`<p class="field__error" id="password-error">${
      t(locale, `reset.error.${problems[0]}`, params)
    }</p>`)}
  </div>

  <button class="button form__submit" type="submit">${t(locale, 'reset.change')}</button>
</form>`;
}

/**
 * Итоговое сообщение без формы.
 *
 * Ответ на заявку выглядит одинаково для существующего и несуществующего
 * адреса (R-SEC-06), поэтому блока два, а разметка — одна: разойдись они,
 * ответы перестали бы совпадать.
 */
function resultBlock({ locale }, textKey) {
  return html`
<p class="form__text">${t(locale, textKey)}</p>
<p class="form__links"><a href="/${locale}/login">${t(locale, 'reset.login')}</a></p>`;
}
