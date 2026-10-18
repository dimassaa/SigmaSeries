// S-07 — сезон и S-08 — серия.
// Спецификация: docs/01-product/features/M2-catalog.md, F-02-02.
//
// Подписи дат берутся из `dates.js` — общего компонента `R-I18N-05`, которым
// пользуется и календарь.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';
import { tPlural } from '../i18n/plural.js';
import { releaseLabel } from './dates.js';
import { goneView } from './series.js';
import { markCheckbox, markUpTo, markSeason, markNotice } from './mark.js';
import { episodeRatingBlock, episodeRatingCell, hasEpisodeRating } from './rating.js';

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
 * @param {{csrf: string, signedIn: boolean, undoWindow: number}|null} [page.marks]
 *   отметки: без источника их на странице нет даже для гостя
 * @param {string|null} [page.notice] что сообщить после действия
 * @param {number} [page.noticeMarked]
 * @param {number|null} [page.noticeBatch]
 * @param {Map<number, object>|null} [page.ratings] блоки оценки по
 *   идентификатору серии; `null` — источник оценок не подключён
 */
export function seasonView({
  locale, page, slug, marks = null, notice = null, noticeMarked = 0, noticeBatch = null,
  ratings = null,
}) {
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
<p class="season__banner" role="status">${tPlural(locale, 'season.allOut', season.episodes.length, {
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

${markNotice({
    locale,
    slug,
    csrf: marks?.csrf ?? '',
    message: notice,
    marked: noticeMarked,
    batch: noticeBatch,
    undoWindow: marks?.undoWindow,
  })}

${when(season.episodes.length > 0, () => html`
<div class="season__actions">
  ${markSeason({ locale, slug, season: season.number, seasonId: season.id, csrf: marks?.csrf ?? '', signedIn: marks?.signedIn })}
</div>

<ol class="season__episode-list" role="list">
  ${season.episodes.map((episode) => {
    const rate = ratings?.get(episode.id) ?? null;
    // Формы стоят рядом со ссылкой, а не внутри неё: кнопка внутри ссылки —
    // это вложенное действие, и нажатие уводило бы на страницу серии вместо
    // отметки или оценки. `id` — тот же якорь `ep-{номер}`, на который
    // возвращает запись оценки: он указывает на строку той серии, которую
    // человек только что оценил.
    const withUpto = Boolean(marks?.signedIn) && episode.aired;
    const withRating = hasEpisodeRating(rate);
    return html`
  <li class="season__episode" id="ep-${episode.number}">
    ${markCheckbox({
      locale,
      slug,
      season: season.number,
      episode: episode.number,
      episodeId: episode.id,
      csrf: marks?.csrf ?? '',
      marked: Boolean(episode.marked),
      aired: episode.aired,
      date: episode.date,
      signedIn: marks?.signedIn ?? false,
    })}
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
    ${when(withUpto || withRating, () => html`
    <div class="season__episode-controls">
      ${when(withUpto, () => markUpTo({
        locale,
        slug,
        season: season.number,
        episode: episode.number,
        csrf: marks?.csrf ?? '',
        signedIn: true,
      }))}
      ${when(withRating, () => episodeRatingCell({
        locale,
        slug,
        season: season.number,
        episode: episode.number,
        rating: rate,
      }))}
    </div>`)}
  </li>`;
  })}
</ol>`)}`;
}

/**
 * S-08 — серия.
 *
 * @param {object} page
 * @param {string} page.locale
 * @param {object} page.page данные источника
 * @param {string} page.slug
 * @param {{csrf: string, signedIn: boolean}|null} [page.marks]
 * @param {object|null} [page.rating] данные блока оценки серии (F-04-02)
 * @param {string|null} [page.timezone] пояс посетителя для подписи дозревания
 */
export function episodeView({ locale, page, slug, marks = null, rating = null, timezone = null }) {
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

<div class="episode__mark">
  ${markCheckbox({
    locale,
    slug,
    season: season.number,
    episode: episode.number,
    episodeId: episode.id,
    csrf: marks?.csrf ?? '',
    marked: Boolean(episode.marked),
    aired: episode.aired,
    date: episode.date,
    signedIn: marks?.signedIn ?? false,
  })}
  <p class="episode__date">${releaseLabel(locale, episode.date)}</p>
</div>

${when(episode.description, () => html`
<p class="episode__description">${episode.description}</p>`)}

${when(rating, () => episodeRatingBlock({
  locale,
  slug,
  season: season.number,
  episode: episode.number,
  rating,
  timezone,
}))}

<nav class="episode__nav" aria-label="${t(locale, 'episode.menu')}">
  ${when(page.prevEpisode !== null, () => html`
  <a class="episode__nav-link" rel="prev"
     href="${episodeHref(locale, slug, season.number, page.prevEpisode)}">${t(locale, 'episode.prev')}</a>`)}
  ${when(page.nextEpisode !== null, () => html`
  <a class="episode__nav-link" rel="next"
     href="${episodeHref(locale, slug, season.number, page.nextEpisode)}">${t(locale, 'episode.next')}</a>`)}
</nav>`;
}

/** 410 у снятого сериала: тот же текст, что на странице сериала. */
export { goneView } from './series.js';