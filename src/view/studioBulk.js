// Прогноз массовой операции (F-10-11).
//
// Показывает, сколько карточек затронет действие и какие не подойдут с
// причиной: подтверждение человек даёт вслепую только когда видит итог.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * Прогноз операции.
 *
 * @param {object} args
 * @returns {object}
 */
export function bulkPreviewView({
  locale, plan = {}, action = '', genre = null, reason = null, csrf = '',
}) {
  return html`
<div class="studio">
  <h1 class="studio__title">${t(locale, 'studio.bulk.title')}</h1>
  <p class="studio__note">
    ${t(locale, 'studio.bulk.summary', { affected: plan.affected ?? 0, total: plan.total ?? 0 })}
  </p>

  ${when(plan.sample && plan.sample.length, () => html`
  <h2 class="studio__section-title">${t(locale, 'studio.bulk.sample')}</h2>
  <ul class="studio-history" role="list">
    ${plan.sample.map((item) => html`
    <li class="studio-history__item">
      <span class="studio-history__action">${item.title}</span>
    </li>`)}
  </ul>`)}

  ${when(plan.skipped && plan.skipped.length, () => html`
  <h2 class="studio__section-title">${t(locale, 'studio.bulk.skipped')}</h2>
  <ul class="studio-history" role="list">
    ${plan.skipped.map((item) => html`
    <li class="studio-history__item">
      <span class="studio-history__action">${item.title}</span>
      <span class="studio-history__reason">${t(locale, `studio.bulk.reason.${item.reason}`)}</span>
    </li>`)}
  </ul>`)}

  <form class="studio-card__form" method="post" action="/${locale}/admin/catalog/bulk">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="action" value="${action}">
    ${when(genre, () => html`<input type="hidden" name="genre" value="${genre}">`)}
    ${when(reason, () => html`<input type="hidden" name="reason" value="${reason}">`)}
    ${(plan.ids ?? []).map((id) => html`<input type="hidden" name="ids" value="${id}">`)}
    <p class="studio-card__actions">
      <button class="button button--primary" type="submit" name="confirm" value="1"
        ${when(!(plan.affected > 0), () => 'disabled')}>${t(locale, 'studio.bulk.confirm')}</button>
      <a class="button" href="/${locale}/admin/catalog">${t(locale, 'studio.bulk.cancel')}</a>
    </p>
  </form>
</div>`;
}
