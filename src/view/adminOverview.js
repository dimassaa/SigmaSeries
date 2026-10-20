// Системный обзор (F-09-05, F-09-06, S-70).
//
// Числа онлайна, состояние очередей, открытые аномалии оценок с решением и
// последние копии. Аномалии — единственное, что требует решения здесь, и
// поэтому оно наверху.

import { html, when, raw } from './render.js';
import { t } from '../i18n/strings.js';
import { dayLabel } from './dates.js';

/**
 * Обзор.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.data
 * @returns {string}
 */
export function adminOverviewView({ locale, data, csrf = null }) {
  const { online = {}, queues = {}, anomalies = [], backups = [] } = data;

  return html`
<div class="admin-overview">
  <h1 class="admin-overview__title">${t(locale, 'admin.overview.title')}</h1>

  ${when(queues.growing, () => html`
  <p class="mod__warning" role="status">
    ${t(locale, 'admin.overview.queue.growing', { minutes: queues.oldestMinutes })}
  </p>`)}

  <section class="admin-overview__anomalies">
    <h2 class="admin-overview__section-title">${t(locale, 'admin.overview.anomalies')}</h2>
    ${when(anomalies.length, () => html`
    <ul class="admin-overview__list" role="list">
      ${anomalies.map((item) => html`
      <li class="admin-overview__anomaly">
        <span class="admin-overview__anomaly-title">${item.seriesTitle}</span>
        <span class="admin-overview__anomaly-numbers">
          ${t(locale, 'admin.overview.anomaly.numbers', {
            count: item.signal.count_window ?? 0,
            share: Math.round((item.signal.extreme_share ?? 0) * 10) / 10,
          })}
        </span>
        <form class="admin-overview__decision" method="post" action="/${locale}/admin/anomaly/${item.id}">
          <input type="hidden" name="csrf" value="${csrf ?? ''}">
          <label class="visually-hidden" for="anomaly-reason-${item.id}">${t(locale, 'admin.overview.anomaly.reason')}</label>
          <input class="field__input" id="anomaly-reason-${item.id}" name="reason" type="text" required
            placeholder="${t(locale, 'admin.overview.anomaly.reason')}">
          <button class="button button--primary" type="submit" name="decision" value="accept"
            >${t(locale, 'admin.overview.anomaly.accept')}</button>
          <button class="button button--danger" type="submit" name="decision" value="discard"
            >${t(locale, 'admin.overview.anomaly.discard')}</button>
        </form>
      </li>`)}
    </ul>`, () => html`
    <p class="empty">${t(locale, 'admin.overview.anomalies.empty')}</p>`)}
  </section>

  <section class="admin-overview__numbers">
    <h2 class="admin-overview__section-title">${t(locale, 'admin.overview.numbers')}</h2>
    <dl class="admin-overview__facts">
      <dt>${t(locale, 'admin.overview.online.now')}</dt>
      <dd>${online.now ?? 0}</dd>
      <dt>${t(locale, 'admin.overview.online.average')}</dt>
      <dd>${online.average ?? 0}</dd>
      <dt>${t(locale, 'admin.overview.queue.waiting')}</dt>
      <dd>${queues.waiting ?? 0}</dd>
      <dt>${t(locale, 'admin.overview.queue.oldest')}</dt>
      <dd>${queues.oldestMinutes ?? 0}</dd>
    </dl>
  </section>

  <section class="admin-overview__backups">
    <h2 class="admin-overview__section-title">${t(locale, 'admin.overview.backups')}</h2>
    ${when(backups.length, () => html`
    <ul class="admin-overview__list" role="list">
      ${backups.map((item) => html`
      <li class="admin-overview__backup">
        <span class="admin-overview__backup-date">${dayLabel(locale, item.startedAt)}</span>
        <span class="admin-overview__backup-status">${t(locale, `admin.backup.status.${item.status}`)}</span>
      </li>`)}
    </ul>`, () => html`
    <p class="empty">${t(locale, 'admin.overview.backups.empty')}</p>`)}
  </section>
</div>`;
}
