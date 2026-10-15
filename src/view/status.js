// Статус просмотра: форма и кнопка (F-03-01, UI-10, S-06).
//
// Кнопка одна: у кого статуса нет — она и есть «Смотрю», у кого есть —
// показывает текущий и раскрывает меню. Два одинаково выделенных действия на
// странице означали бы, что человек угадывает, что нажать.
//
// Меню — обычная форма GET с кнопками: работает без скриптов, состояние
// видно в адресе страницы, а «одно primary» правило выполняется самой разметкой
// (R-A11Y-19: цвет не единственный носитель состояния — есть значок и текст).

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/** Значок статуса: тот же смысл, что и подпись, одним символом. */
const ICON = {
  watching: '▶',
  planned: '☆',
  watched: '✓',
  dropped: '✕',
  on_hold: '⏸',
};

const KEY = {
  watching: 'status.watching',
  planned: 'status.planned',
  watched: 'status.watched',
  dropped: 'status.dropped',
  on_hold: 'status.onHold',
};

const ORDER = ['watching', 'planned', 'watched', 'on_hold', 'dropped'];

/**
 * Кнопка статуса.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {string} args.slug сериал, к которому относится кнопка
 * @param {string|null} args.status текущий статус или `null`
 * @param {boolean} args.signedIn гость получает приглашение, а не кнопку
 * @param {string} args.csrf
 * @param {boolean} [args.archived] снятый с публикации: статус не меняется (EC-T8)
 * @param {string} [args.view] откуда нажали: `series` или `library`
 */
export function statusControl({ locale, slug, status, signedIn, csrf, archived = false, view = 'series' }) {
  if (!signedIn) return guestPrompt({ locale, slug, view });

  if (archived) {
    return html`
<p class="status status--readonly" role="status">${t(locale, 'status.archived')}</p>`;
  }

  const current = status && Object.hasOwn(KEY, status) ? status : null;

  return html`
<div class="status" data-status="${current ?? ''}">
  <form class="status__menu" method="post" action="/${locale}/series/${slug}/status"
        role="group" aria-label="${t(locale, 'status.label')}">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="view" value="${view}">

    ${when(current === null, () => html`
    <button class="status__primary" type="submit" name="status" value="watching">
      <span aria-hidden="true">${ICON.watching}</span> ${t(locale, KEY.watching)}
    </button>`)}

    ${when(current !== null, () => html`
    <details class="status__current">
      <summary class="status__button status__button--${current}">
        <span aria-hidden="true">${ICON[current]}</span> ${t(locale, KEY[current])}
      </summary>
      <ul class="status__list" role="list">
        ${ORDER.map((value) => html`
        <li>
          <button class="status__item status__item--${value}" type="submit" name="status" value="${value}">
            <span aria-hidden="true">${ICON[value]}</span> ${t(locale, KEY[value])}
          </button>
        </li>`)}
        <li>
          <button class="status__item status__item--remove" type="submit" name="status" value="">
            <span aria-hidden="true">✕</span> ${t(locale, 'status.remove')}
          </button>
        </li>
      </ul>
    </details>`)}
  </form>
</div>`;
}

/** Гость: приглашение со ссылкой на вход и возвратом на это же место (R-SEC-08). */
function guestPrompt({ locale, slug, view }) {
  const back = `/${locale}/series/${slug}`;
  const next = view === 'library' ? `/${locale}/library` : back;

  return html`
<div class="status status--guest">
  <a class="status__guest" href="/${locale}/login?next=${encodeURIComponent(next)}"
     >${t(locale, 'status.guest')}</a>
</div>`;
}

/** Подпись статуса текстом — для карточек и списков, где кнопки нет. */
export function statusLabel(locale, status) {
  return status && Object.hasOwn(KEY, status) ? t(locale, KEY[status]) : '';
}

/** Значок статуса для тех же мест. */
export function statusIcon(status) {
  return status && Object.hasOwn(ICON, status) ? ICON[status] : '';
}