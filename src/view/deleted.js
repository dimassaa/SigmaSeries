// Экраны удаления аккаунта (F-01-10 §4).
//
// Два состояния одного экрана, разные по смыслу:
//
//   * `pending` — вход в период ожидания (EC-A11). Человек вошёл и увидел
//     выбор: отменить удаление или оставить его. Выбор обязателен — вход сам
//     по себе отменой не считается;
//   * без `pending` — подтверждение, что запрос принят. Показывается после
//     разлогина, когда настроек уже не видно.
//
// Оба состояния — одна функция, потому что это один экран в двух моментах
// времени, а не два разных вопроса.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * @param {object} ctx
 * @param {string} ctx.locale
 * @param {string} ctx.csrf
 * @param {boolean} [ctx.pending] вход в период ожидания: показать выбор
 * @param {string|null} [ctx.error]
 */
export function deletedView(ctx) {
  const { locale, pending } = ctx;
  const action = `/${locale}${pending ? '/delete-pending' : '/settings/data/deleted'}`;

  return html`
<section class="block block--form">
  <h1 class="form__title">
    ${t(locale, pending ? 'settings.deletePending.title' : 'settings.deleted.title')}
  </h1>

  <div class="form__status" role="alert" aria-live="assertive">
    ${when(ctx.error, () => html`<p class="form__error">${ctx.error}</p>`)}
  </div>

  <p class="form__text">
    ${t(locale, pending ? 'settings.deletePending.lead' : 'settings.deleted.lead')}
  </p>

  ${when(pending, () => html`
  <form class="form" method="post" action="${action}" novalidate>
    <input type="hidden" name="csrf" value="${ctx.csrf}">

    <ul class="settings__consequences">
      ${['email', 'nick', 'settings', 'sessions', 'materials'].map((what) => html`
      <li class="settings__consequence">${t(locale, `settings.deletePending.what.${what}`)}</li>`)}
    </ul>

    <div class="settings__actions">
      <button class="button" type="submit" name="action" value="cancel"
        >${t(locale, 'settings.deletePending.cancel')}</button>
      <button class="button button--quiet" type="submit" name="action" value="continue"
        >${t(locale, 'settings.deletePending.continue')}</button>
    </div>
  </form>`)}

  ${when(!pending, () => html`
  <p class="form__links">
    <a href="/${locale}/">${t(locale, 'settings.deleted.home')}</a>
  </p>`)}
</section>`;
}