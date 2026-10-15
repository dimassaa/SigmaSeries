// Прогресс и «продолжить» (F-03-03, OP-10).
//
// Показывается только вошедшему: гостю нечего продолжать, а пустая полоса на
// странице сериала выглядит как ошибка вёрстки.
//
// Числа моноширинные и без цветового кодирования (R-DES-04, R-A11Y-19): «12 из
// 24» читается глазом, и полоса рядом — для тех, кто хочет сравнить быстрее.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';
import { fullDate } from './dates.js';

/**
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.series карточка сериала
 * @param {object|null} args.progress прогресс зрителя или `null` у гостя
 */
export function progressView({ locale, series, progress }) {
  if (!progress) return '';

  const { marked, aired, percent, nextSeason, nextEpisode, nextDate, skipped, state } = progress;

  if (state === 'no-airdates') {
    return html`<p class="progress progress--empty">${t(locale, 'progress.noAired')}</p>`;
  }

  return html`
<div class="progress">
  <progress class="progress__bar" value="${marked}" max="${aired || 1}"
            aria-label="${t(locale, 'progress.label')}"></progress>
  <p class="progress__count">
    <span class="progress__numbers">${marked} / ${aired}</span>
    <span class="progress__percent">${percent}%</span>
  </p>

  ${when(nextEpisode !== null, () => html`
  <p class="progress__next">
    <a class="button" href="/${locale}/series/${series.slug}/seasons/${nextSeason}/episodes/${nextEpisode}"
       >${t(locale, 'progress.continue', { season: nextSeason, episode: nextEpisode })}</a>
    ${when(nextDate, () => html`<span class="progress__next-date">${fullDate(locale, nextDate)}</span>`)}
  </p>`)}

  ${when(state === 'all-aired-watched' && progress.awaitingDate, () => html`
  <p class="progress__awaiting">${t(locale, 'progress.awaiting', { date: fullDate(locale, progress.awaitingDate) })}</p>`)}

  ${when(skipped > 0, () => html`
  <p class="progress__skipped">${t(locale, 'progress.skipped', { count: skipped })}</p>`)}
</div>`;
}
