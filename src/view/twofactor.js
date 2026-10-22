// S-23 — двухфакторная проверка.
//
// Спецификация: SCREENS S-23; F-01-05 §4 (ввод кода, резервные коды),
// §19 (QR слева, ключ и поле справа, моноширинный список резервных кодов,
// фокус на поле кода).
// Требования: R-A11Y-10 (`autocomplete="one-time-code"`, числовая
// клавиатура), R-A11Y-11 (ошибка текстом и связана с полем), R-DES-27
// (цвет не единственный носитель состояния), R-SEC-24 (страница не
// кэшируется — это уже на уровне заголовков ответа).

import { html, raw, when } from './render.js';
import { t } from '../i18n/strings.js';
import { AUTH } from '../config/settings.js';

const HEADINGS = {
  code: 'twoFactor.title',
  backup: 'twoFactor.backup.title',
};

/**
 * @param {object} ctx
 * @param {string} ctx.locale
 * @param {string} ctx.csrf
 * @param {'code'|'backup'} ctx.state
 * @param {string|null} [ctx.error]
 * @param {number|null} [ctx.codesLeft] сколько резервных кодов осталось
 */
export function twoFactorView(ctx) {
  const { locale, state } = ctx;

  return html`
<section class="block block--form">
  <h1 class="form__title">${t(locale, HEADINGS[state] ?? HEADINGS.code)}</h1>

  <div class="form__status" role="alert" aria-live="assertive">
    ${when(ctx.error, () => html`<p class="form__error">${ctx.error}</p>`)}
  </div>

  ${when(state === 'backup', () => backupForm(ctx))}
  ${when(state === 'code', () => codeForm(ctx))}
</section>`;
}

/**
 * Форма ввода кода из приложения-аутентификатора.
 *
 * @param {{locale: string, csrf: string, error?: string|null, codesLeft?: number}} ctx
 */
function codeForm({ locale, csrf, error, codesLeft }) {
  const bad = Boolean(error);
  // При ≤ 3 оставшихся кодов человек предупреждается (F-01-05 §5): узнать
  // об этом, когда коды кончились, уже поздно.
  const few = codesLeft !== null && codesLeft !== undefined && codesLeft <= 3;

  return html`
<p class="form__text">${t(locale, 'twoFactor.lead')}</p>
<form class="form" method="post" action="/${locale}/2fa" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">

  <div class="field${bad ? ' field--invalid' : ''}">
    <label class="field__label" for="code">${t(locale, 'twoFactor.code')}</label>
    <input class="field__input" id="code" name="code" type="text"
           inputmode="numeric" autocomplete="one-time-code"
           autocapitalize="off" spellcheck="false" maxlength="6"
           pattern="[0-9]*" required
           ${when(bad, () => raw('aria-invalid="true" aria-describedby="code-error"'))}>
    ${when(bad, () => html`<p class="field__error" id="code-error">${error}</p>`)}
  </div>

  ${when(few, () => html`<p class="form__warning">${
    t(locale, 'twoFactor.codesFew', { count: codesLeft })
  }</p>`)}

  <button class="button form__submit" type="submit">${t(locale, 'twoFactor.submit')}</button>
</form>

<!--
  Резервный код — отдельная форма, а не второе поле в той же.

  При общей форме человек вводит резервный код, оставляет поле TOTP пустым и
  отправляет: сервер видит пустой код и отвечает «не подошёл» вместо входа.
  Две кнопки в одной форме эту ошибку не устраняли бы — отправлялось бы то же
  самое.
-->
<details class="form__details">
  <summary class="form__link">${t(locale, 'twoFactor.useBackup')}</summary>
  <form class="form" method="post" action="/${locale}/2fa" novalidate>
    <input type="hidden" name="csrf" value="${csrf}">
    <div class="field">
      <label class="field__label" for="backup_code">${t(locale, 'twoFactor.backupCode')}</label>
      <input class="field__input" id="backup_code" name="backup_code" type="text"
             autocomplete="off" autocapitalize="characters" spellcheck="false"
             maxlength="${AUTH.backupCodeLength}">
      <p class="field__hint">${t(locale, 'twoFactor.backupHint')}</p>
    </div>
    <button class="button button--quiet" type="submit">${t(locale, 'twoFactor.backupSubmit')}</button>
  </form>
</details>`;
}

/**
 * Резервный код вместо кода из приложения.
 *
 * Отдельная форма с отдельной кнопкой: если бы оба поля были в одной форме с
 * одной кнопкой, человек отправил бы пустое поле кода вместе с заполненным
 * резервным и получил бы отказ вместо входа.
 *
 * @param {{locale: string, csrf: string, error?: string|null}} ctx
 */
function backupForm({ locale, csrf, error }) {
  return html`
<p class="form__text">${t(locale, 'twoFactor.backup.lead')}</p>
<form class="form" method="post" action="/${locale}/2fa" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">

  <div class="field${error ? ' field--invalid' : ''}">
    <label class="field__label" for="backup_code">${t(locale, 'twoFactor.backupCode')}</label>
    <input class="field__input" id="backup_code" name="backup_code" type="text"
           autocomplete="off" autocapitalize="characters" spellcheck="false"
           maxlength="${AUTH.backupCodeLength}" required
           ${when(error, () => raw('aria-invalid="true" aria-describedby="backup-error"'))}>
    ${when(error, () => html`<p class="field__error" id="backup-error">${error}</p>`)}
  </div>

  <button class="button form__submit" type="submit">${t(locale, 'twoFactor.backupSubmit')}</button>
</form>`;
}