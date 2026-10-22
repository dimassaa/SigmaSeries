// Правая панель «Предстоящие» (F-03-06, UI-04).
//
// Плоская поверхность без стекла (R-DES-20): панель стоит рядом с белым фоном
// страницы, и размывать под ней нечего — стекло появилось бы за счёт
// содержимого под собой, которого там нет.

import { html } from './render.js';
import { t } from '../i18n/strings.js';
import { captionFor } from '../services/catalogue/panel.js';

/**
 * Панель или ничего.
 *
 * Пустой список рисуется пустым состоянием с ссылкой на календарь (F-03-06 §5):
 * заголовок «Скоро» без единой строки выглядел бы поломкой, и человек, не
 * нашедший сегодняшнего выхода, решил бы, что сломалось расписание.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {Array<{mine: boolean, slug: string, title: string, label: string, date: string}>} args.rows
 * @param {string} args.today сегодня пояса читателя
 * @returns {{__raw: string}}
 */
export function upcomingPanel({ locale, rows, today }) {
  return html`
<aside class="panel${rows.length ? '' : ' panel--empty'}" aria-labelledby="panel-title">
  <h2 class="panel__title" id="panel-title">${t(locale, 'panel.title')}</h2>

  ${rows.length ? html`
  <ul class="panel__list" role="list">
    ${rows.map((row) => html`
    <li class="panel__row${row.mine ? ' panel__row--mine' : ''}">
      <a class="panel__link" href="/${locale}/series/${row.slug}">
        <span class="panel__series">${row.title}</span>
        <span class="panel__meta">
          <span class="panel__label">${row.label}</span>
          <span class="panel__date">${captionFor(locale, row.date, today)}</span>
        </span>
      </a>
    </li>`)}
  </ul>` : html`
  <p class="panel__empty">${t(locale, 'panel.empty')}</p>`}

  <a class="panel__all" href="/${locale}/calendar">${t(locale, 'panel.all')}</a>
</aside>`;
}
