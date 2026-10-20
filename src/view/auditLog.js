// Журнал аудита (F-09-03, S-81).
//
// Таблица записей: кто, что, с каким результатом и почему. Запись читается
// целиком — журнал и есть объяснение, а не строчка в списке.

import { html, when, raw } from './render.js';
import { t } from '../i18n/strings.js';
import { dayLabel } from './dates.js';

/**
 * Страница журнала.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.list
 * @param {object} args.query
 * @returns {string}
 */
export function auditLogView({ locale, list, query = {} }) {
  const { items = [], total = 0, page = 1, pages = 1 } = list;
  const chips = [];
  if (query.action) chips.push({ key: 'action', value: String(query.action) });
  if (query.object_type) chips.push({ key: 'object_type', value: String(query.object_type) });
  if (query.object_id) chips.push({ key: 'object_id', value: String(query.object_id) });
  if (query.from) chips.push({ key: 'from', value: String(query.from) });
  if (query.to) chips.push({ key: 'to', value: String(query.to) });

  return html`
<div class="audit-log">
  <h1 class="audit-log__title">${t(locale, 'admin.audit.title')}</h1>

  <form class="audit-log__filters" method="get" action="/${locale}/admin/audit">
    <label class="visually-hidden" for="audit-action">${t(locale, 'admin.audit.filter.action')}</label>
    <input class="field__input" id="audit-action" type="search" name="action"
      value="${query.action ?? ''}" placeholder="${t(locale, 'admin.audit.filter.action')}">

    <label class="visually-hidden" for="audit-object">${t(locale, 'admin.audit.filter.object')}</label>
    <input class="field__input" id="audit-object" type="search" name="object_type"
      value="${query.object_type ?? ''}" placeholder="${t(locale, 'admin.audit.filter.object')}">

    <label class="visually-hidden" for="audit-from">${t(locale, 'admin.audit.filter.from')}</label>
    <input class="field__input" id="audit-from" type="date" name="from" value="${query.from ?? ''}">

    <label class="visually-hidden" for="audit-to">${t(locale, 'admin.audit.filter.to')}</label>
    <input class="field__input" id="audit-to" type="date" name="to" value="${query.to ?? ''}">

    <button class="button button--primary" type="submit">${t(locale, 'admin.audit.filter.apply')}</button>
  </form>

  ${when(chips.length, () => html`
  <p class="audit-log__chips">
    ${chips.map((chip) => html`
    <span class="audit-log__chip">${t(locale, `admin.audit.filter.${chip.key}`)}: ${chip.value}</span>`)}
    <a class="audit-log__reset" href="/${locale}/admin/audit">${t(locale, 'admin.audit.filter.reset')}</a>
  </p>`)}

  ${when(!items.length, () => html`
  <p class="empty">${t(locale, 'admin.audit.empty')}</p>`)}

  ${when(items.length, () => html`
  <table class="audit-log__table">
    <caption class="visually-hidden">${t(locale, 'admin.audit.title')}</caption>
    <thead>
      <tr>
        <th scope="col">${t(locale, 'admin.audit.column.when')}</th>
        <th scope="col">${t(locale, 'admin.audit.column.who')}</th>
        <th scope="col">${t(locale, 'admin.audit.column.what')}</th>
        <th scope="col">${t(locale, 'admin.audit.column.result')}</th>
      </tr>
    </thead>
    <tbody>
      ${items.map((item) => html`
      <tr class="audit-log__row">
        <td class="audit-log__when">${dayLabel(locale, item.at)}</td>
        <td class="audit-log__who">${item.actorNickname ?? t(locale, 'admin.audit.system')}</td>
        <td class="audit-log__what">
          <span class="audit-log__action">${item.action}</span>
          <span class="audit-log__object">${item.objectType}${item.objectId === null ? '' : ` #${item.objectId}`}</span>
          <span class="audit-log__reason">${item.reason}</span>
        </td>
        <td class="audit-log__result">${t(locale, `admin.audit.result.${item.result}`)}</td>
      </tr>`)}
    </tbody>
  </table>

  ${when(pages > 1, () => html`
  <nav class="audit-log__pages" aria-label="${t(locale, 'admin.audit.pages')}">
    ${Array.from({ length: pages }, (_, index) => index + 1).map((number) => html`
    <a class="audit-log__page${number === page ? ' audit-log__page--on' : ''}"
      href="/${locale}/admin/audit?page=${number}"
      ${number === page ? raw('aria-current="page"') : raw('')}>${number}</a>`)}
  </nav>`)}
  <p class="audit-log__total">${t(locale, 'admin.audit.total', { count: total })}</p>`)}
</div>`;
}
