// Флажок отметки и действия над серией (F-03-02, UI-10).
//
// Цель касания флажка — 44 px, а не сам квадрат: на телефоне отметить серию
// пальцем, промахнувшись мимо на десять пикселей, — это не «случайно», это
// «не работает». Размер даёт рамка вокруг поля, само поле остаётся маленьким.
//
// Массовые действия стоят не рядом с флажком одной серии, а отдельной строкой:
// они необратимы на вид, и ставить их рядом с «отметить одну» — значит
// предлагать человеку нажать не то.

import { html, raw, when } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * Флажок одной серии.
 *
 * Не вышедшая серия отключена, но не спрятана: человек видит, что серия есть и
 * когда она выйдет (EC-T2), вместо того чтобы гадать, где он ошибся.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {string} args.slug
 * @param {number} args.season
 * @param {number} args.episode номер серии в сезоне
 * @param {number} args.episodeId идентификатор строки серии
 * @param {string} args.csrf
 * @param {boolean} args.marked
 * @param {boolean} args.aired
 * @param {string|null} [args.date] дата выхода для подсказки
 * @param {boolean} [args.signedIn]
 */
export function markCheckbox({ locale, slug, season, episode, episodeId, csrf, marked, aired, date, signedIn = true }) {
  if (!signedIn) return html`<span class="mark mark--guest" aria-hidden="true"></span>`;

  const label = t(locale, marked ? 'mark.unmark' : 'mark.mark', { episode });
  const title = aired ? label : t(locale, 'mark.soon', { date: date ?? '' });

  return html`
<form class="mark" method="post" action="/${locale}/series/${slug}/mark">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="episode">
  <input type="hidden" name="season" value="${season}">
  <!-- Номер серии нужен человеку и действию «все до этой», а база знает только
       идентификатор: одна и та же форма отправляет оба. -->
  <input type="hidden" name="episode" value="${episode}">
  <input type="hidden" name="episodeId" value="${episodeId}">
  <input type="hidden" name="on" value="${marked ? '0' : '1'}">
  <button class="mark__button${marked ? ' mark__button--on' : ''}" type="submit"
          ${raw(aired ? '' : 'disabled aria-disabled="true"')}
          aria-pressed="${marked ? 'true' : 'false'}" title="${title}">
    <span aria-hidden="true">${marked ? '✓' : ''}</span>
    <span class="visually-hidden">${title}</span>
  </button>
</form>`;
}

/**
 * «Все до этой» под конкретной серией.
 *
 * Порядок отметки — по (сезон, номер), поэтому действие у серии 5 отмечает и
 * серии первых четырёх, а не «пять штук подряд» (EC-T11).
 */
export function markUpTo({ locale, slug, season, episode, csrf, signedIn = true }) {
  if (!signedIn) return '';

  return html`
<form class="mark mark--bulk" method="post" action="/${locale}/series/${slug}/mark">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="upto">
  <input type="hidden" name="season" value="${season}">
  <input type="hidden" name="episode" value="${episode}">
  <button class="button button--quiet" type="submit"
          >${t(locale, 'mark.upto', { episode })}</button>
</form>`;
}

/**
 * «Отметить все вышедшие серии сезона» (EC-T6).
 *
 * @param {object} args
 * @param {number} args.seasonId идентификатор сезона: по нему база знает, что
 *   именно этот сезон помечается, а не «сезон с таким номером у этого сериала»
 */
export function markSeason({ locale, slug, season, seasonId, csrf, signedIn = true }) {
  if (!signedIn) return '';

  return html`
<form class="mark mark--bulk" method="post" action="/${locale}/series/${slug}/mark">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="season">
  <input type="hidden" name="season" value="${season}">
  <input type="hidden" name="seasonId" value="${seasonId}">
  <button class="button button--quiet" type="submit"
          >${t(locale, 'mark.seasonAll')}</button>
</form>`;
}

/**
 * Сообщение после массовой отметки и отказов.
 *
 * Отмена показывается `tracking.undo_window_s` секунд — окно живёт в разметке,
 * а прячет кнопку скрипт: сервер отмену принимает и позже, потому что отмена
 * удаляет только отметки своего пакета и ничего не ломает, даже если человек
 * нажал её через час.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {string} args.slug
 * @param {string} args.csrf
 * @param {string|null} args.message `soon`, `nothing-aired`, `undone` или `done`
 * @param {number} [args.marked]
 * @param {number} [args.batch]
 * @param {number} [args.undoWindow] секунд
 */
export function markNotice({ locale, slug, csrf, message, marked, batch, undoWindow = 10 }) {
  if (!message) return '';

  if (message === 'soon') {
    return html`<p class="mark-notice mark-notice--warn" role="status">${t(locale, 'mark.notice.soon')}</p>`;
  }
  if (message === 'nothing-aired') {
    return html`<p class="mark-notice" role="status">${t(locale, 'mark.notice.nothing')}</p>`;
  }
  if (message === 'undone') {
    return html`<p class="mark-notice" role="status">${t(locale, 'mark.notice.undone')}</p>`;
  }
  if (message !== 'done') return '';

  return html`
<p class="mark-notice" role="status">
  <span>${t(locale, 'mark.notice.done', { count: marked ?? 0 })}</span>
  ${when(batch, () => html`
  <form class="mark-notice__undo" method="post" action="/${locale}/series/${slug}/mark"
        data-undo-window="${undoWindow}">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="action" value="undo">
    <input type="hidden" name="batch" value="${batch}">
    <button class="button button--quiet" type="submit"
            >${t(locale, 'mark.undo')}</button>
  </form>`)}
</p>`;
}