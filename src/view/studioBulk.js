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
 * @param {any} [args.action]
 * @param {any} [args.csrf]
 * @param {any} [args.field]
 * @param {any} [args.genre]
 * @param {any} [args.locale]
 * @param {any} [args.plan]
 * @param {any} [args.reason]
 * @returns {any}
 */
export function bulkPreviewView({
  locale, plan = {}, action = '', genre = null, reason = null, field = null, csrf = '',
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
    ${when(field, () => html`<input type="hidden" name="field" value="${field}">`)}
    ${when(reason, () => html`<input type="hidden" name="reason" value="${reason}">`)}
    ${(plan.ids ?? []).map((id) => html`<input type="hidden" name="ids" value="${id}">`)}
    <p class="studio-card__actions">
      <button class="button button--primary" type="submit" name="confirm" value="1" autofocus
        ${when(!(plan.affected > 0), () => 'disabled')}>${t(locale, 'studio.bulk.confirm')}</button>
      <a class="button" href="/${locale}/admin/catalog">${t(locale, 'studio.bulk.cancel')}</a>
    </p>
  </form>
</div>`;
}


/**
 * Отчёт по заданию: прогресс и итог по каждому элементу.
 *
 * Пока задание идёт, страница перезагружается сама (data-bulk-state в
 * app.js). Это дешевле и надёжнее отдельного опроса: результат всё равно
 * хранится в e_bulk_job.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {any} args.job
 * @param {string} args.csrf
 * @returns {any}
 */
export function bulkJobView({ locale, job, csrf = '' }) {
  const running = job.state === 'running';
  return html`
<div class="studio" data-bulk-job="${job.id}" data-bulk-state="${job.state}">
  <h1 class="studio__title">${t(locale, 'studio.bulk.jobTitle', { id: job.id })}</h1>
  <p class="studio__note">
    ${t(locale, `studio.bulk.actions.${job.action}`)} ·
    ${t(locale, 'studio.bulk.progress', { done: job.done, total: job.total })}
  </p>
  <p class="studio__note" role="status" aria-live="polite">
    ${t(locale, `studio.bulk.state.${job.state}`)}
    ${when(job.failed, () => html` · ${t(locale, 'studio.bulk.failed', { count: job.failed })}`)}
  </p>
  <progress class="studio-bulk__progress" max="${job.total || 1}" value="${job.done}">
    ${job.done} / ${job.total}
  </progress>

  ${when(job.result.length, () => html`
  <h2 class="studio__section-title">${t(locale, 'studio.bulk.report')}</h2>
  <ul class="studio-history" role="list">
    ${job.result.map((item) => html`
    <li class="studio-history__item">
      <span class="studio-history__action">${item.title ?? `#${item.id}`}</span>
      <span class="studio-history__reason">
        ${item.ok ? t(locale, 'studio.bulk.resultOk') : t(locale, `studio.bulk.reason.${item.reason}`)}
      </span>
    </li>`)}
  </ul>`)}

  ${when(!running && job.failed > 0, () => html`
  <form method="post" action="/${locale}/admin/catalog/bulk/${job.id}/retry">
    <input type="hidden" name="csrf" value="${csrf}">
    <button class="button button--primary" type="submit">${t(locale, 'studio.bulk.retry')}</button>
  </form>`)}

  <p class="studio-card__actions">
    <a class="button" href="/${locale}/admin/catalog">${t(locale, 'studio.bulk.back')}</a>
  </p>
</div>`;
}
