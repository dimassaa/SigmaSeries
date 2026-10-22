// «Мои материалы» (F-05-09, S-35).
//
// Таблица состояний, а не карточки: автору важно, что с его материалом и
// почему, а не перечитать его текст ещё раз (F-05-09 §19).

import { html, when, raw } from './render.js';
import { t } from '../i18n/strings.js';
import { dayLabel } from './dates.js';

/**
 * Список своих материалов.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {any} args.list материалы (из `own`)
 * @param {string|null} args.csrf
 * @returns {any}
 */
export function myContentView({ locale, list, csrf = null }) {
  const { items = [], total = 0, page = 1, pages = 1, kinds = [], states = [] } = list;

  return html`
<div class="my-content">
  <h1 class="my-content__title">${t(locale, 'my.content.title')}</h1>

  ${when(items.length, () => html`
  <div class="my-content__filters">
    <a class="my-content__filter${!list.applied?.kind ? ' my-content__filter--on' : ''}"
      href="/${locale}/my/content">${t(locale, 'my.content.all')}</a>
    ${kinds.map((kind) => html`
    <a class="my-content__filter${list.applied?.kind === kind ? ' my-content__filter--on' : ''}"
      href="/${locale}/my/content?kind=${kind}">${t(locale, `my.content.kind.${kind}`)}</a>`)}
    ${states.map((state) => html`
    <a class="my-content__filter${list.applied?.state === state ? ' my-content__filter--on' : ''}"
      href="/${locale}/my/content?state=${state}">${t(locale, `my.content.state.${state}`)}</a>`)}
  </div>`)}

  ${when(!items.length, () => html`
  <p class="empty">${t(locale, 'my.content.empty')}</p>`)}

  ${when(items.length, () => html`
  <table class="my-content__table">
    <caption class="visually-hidden">${t(locale, 'my.content.title')}</caption>
    <thead>
      <tr>
        <th scope="col">${t(locale, 'my.content.column.material')}</th>
        <th scope="col">${t(locale, 'my.content.column.state')}</th>
        <th scope="col">${t(locale, 'my.content.column.date')}</th>
        <th scope="col">${t(locale, 'my.content.column.actions')}</th>
      </tr>
    </thead>
    <tbody>
      ${items.map((item) => html`
      <tr class="my-content__row">
        <th scope="row" class="my-content__material">
          <span class="my-content__kind">${t(locale, `my.content.kind.${item.kind}`)}</span>
          ${when(item.seriesTitle, () => html`
          <a class="my-content__series" href="/${locale}/series/${item.seriesSlug}">${item.seriesTitle}</a>`)}
        </th>
        <td class="my-content__state">
          <span class="my-content__state-name">${t(locale, `my.content.state.${item.state}`)}</span>
          ${when(item.reason, () => html`
          <span class="my-content__reason">${item.reason}</span>`)}
        </td>
        <td class="my-content__date">${dayLabel(locale, item.submittedAt)}</td>
        <td class="my-content__actions">
          ${when(item.state === 'flagged' || item.state === 'checking', () => html`
          <a class="my-content__edit" href="/${locale}/series/${item.seriesSlug}#review-dialog"
            >${t(locale, 'my.content.edit')}</a>`)}
          <form class="my-content__delete" method="post" action="/${locale}/my/content/${item.id}/delete">
            <input type="hidden" name="csrf" value="${csrf ?? ''}">
            <input type="hidden" name="back" value="/${locale}/my/content">
            <button class="button button--quiet" type="submit"
              >${t(locale, 'my.content.delete')}</button>
          </form>
        </td>
      </tr>`)}
    </tbody>
  </table>

  ${when(pages > 1, () => html`
  <nav class="my-content__pages" aria-label="${t(locale, 'my.content.pages')}">
    ${Array.from({ length: pages }, (_, index) => index + 1).map((number) => html`
    <a class="my-content__page${number === page ? ' my-content__page--on' : ''}"
      href="/${locale}/my/content?page=${number}"
      ${number === page ? raw('aria-current="page"') : raw('')}>${number}</a>`)}
  </nav>`)}`)}
</div>`;
}
