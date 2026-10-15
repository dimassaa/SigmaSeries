// S-07 — сезон и S-08 — серия.
// Спецификация: docs/01-product/features/M2-catalog.md, F-02-02.
//
// Подписи дат берутся из `dates.js` — общего компонента `R-I18N-05`, которым
// пользуется и календарь.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';
import { releaseLabel } from './dates.js';
import { goneView } from './series.js';

function runtime(locale, minutes) {
  if (!minutes) return '';
  return new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'ru-RU').format(minutes) + ' '
    + t(locale, 'episode.minutes');
}

/** Адрес серии внутри сериала. */
const episodeHref = (locale, slug, season, episode) =>
  `/${locale}/series/${slug}/seasons/${season}/episodes/${episode}`;

/**
 * S-07 — сезон.
 *
 * @param {object} page
 * @param {string} page.locale
 * @param {object} page.page данные источника
 * @param {string} page.slug
 */
export function seasonView({ locale, page, slug }) {
  const { series, season } = page;

  return html`
<nav class="breadcrumbs" aria-label="${t(locale, 'season.menu')}">
  <a href="/${locale}/series/${slug}">${series.title}</a>
  <span aria-hidden="true">›</span>
  <span aria-current="page">${t(locale, 'season.number', { season: season.number })}</span>
</nav>

<h1 class="season__title">${t(locale, 'season.heading', {
  series: series.title,
  season: season.number,
})}</h1>

${when(season.title, () => html`<p class="season__subtitle">${season.title}</p>`)}

${when(season.allOutOn, () => html`
<p class="season__banner" role="status">${t(locale, 'season.allOut', {
  count: season.episodes.length,
  date: releaseLabel(locale, season.allOutOn),
})}</p>`)}

${when(page.prevSeason !== null || page.nextSeason !== null, () => html`
<nav class="season__switch" aria-label="${t(locale, 'season.switch')}">
  ${when(page.prevSeason !== null, () => html`
  <a class="season__switch-link" rel="prev"
     href="/${locale}/series/${slug}/seasons/${page.prevSeason}">${t(locale, 'season.prev')}</a>`)}
  ${when(page.nextSeason !== null, () => html`
  <a class="season__switch-link" rel="next"
     href="/${locale}/series/${slug}/seasons/${page.nextSeason}">${t(locale, 'season.next')}</a>`)}
</nav>`)}

${when(season.episodes.length === 0, () => html`
<p class="empty">${t(locale, 'season.empty')}</p>`)}

${when(season.episodes.length > 0, () => html`
<ol class="season__episode-list" role="list">
  ${season.episodes.map((episode) => html`
  <li class="season__episode">
    <a class="season__episode-link" href="${episodeHref(locale, slug, season.number, episode.number)}">
      <span class="season__episode-number">${episode.number}</span>
      <span class="season__episode-body">
        <span class="season__episode-title">${episode.title || t(locale, 'episode.numberOnly', { number: episode.number })}</span>
        ${when(episode.description, () => html`
        <span class="season__episode-desc">${episode.description}</span>`)}
      </span>
      <span class="season__episode-meta">
        ${when(episode.runtime, () => html`<span class="season__episode-runtime">${runtime(locale, episode.runtime)}</span>`)}
        <span class="season__episode-date">${releaseLabel(locale, episode.date)}</span>
      </span>
    </a>
  </li>`)}
</ol>`)}`;
}

/**
 * S-08 — серия.
 *
 * @param {object} page
 * @param {string} page.locale
 * @param {object} page.page данные источника
 * @param {string} page.slug
 */
export function episodeView({ locale, page, slug }) {
  const { series, season, episode } = page;

  return html`
<nav class="breadcrumbs" aria-label="${t(locale, 'episode.menu')}">
  <a href="/${locale}/series/${slug}">${series.title}</a>
  <span aria-hidden="true">›</span>
  <a href="/${locale}/series/${slug}/seasons/${season.number}">${t(locale, 'season.number', { season: season.number })}</a>
  <span aria-hidden="true">›</span>
  <span aria-current="page">${episode.number}</span>
</nav>

<h1 class="episode__title">${episode.title || t(locale, 'episode.numberOnly', { number: episode.number })}</h1>
<p class="episode__meta">${t(locale, 'episode.where', {
  series: series.title,
  season: season.number,
  number: episode.number,
})}</p>

<p class="episode__date">${releaseLabel(locale, episode.date)}</p>

${when(episode.description, () => html`
<p class="episode__description">${episode.description}</p>`)}

<nav class="episode__nav" aria-label="${t(locale, 'episode.menu')}">
  ${when(page.prevEpisode !== null, () => html`
  <a class="episode__nav-link" rel="prev"
     href="${episodeHref(locale, slug, season.number, page.prevEpisode)}">${t(locale, 'episode.prev')}</a>`)}
  ${when(page.nextEpisode !== null, () => html`
  <a class="episode__nav-link" rel="next"
     href="${episodeHref(locale, slug, season.number, page.nextEpisode)}">${t(locale, 'episode.next')}</a>`)}
</nav>

<p class="episode__note">${t(locale, 'episode.marksNote')}</p>`;
}

/** 410 у снятого сериала: тот же текст, что на странице сериала. */
export { goneView } from './series.js';