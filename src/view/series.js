// S-06 — страница сериала.
// Спецификация: docs/01-product/features/M2-catalog.md, F-02-01.
//
// Порядок блоков задан якорем: шапка → меню → обзор → серии → в ролях.
// Отзывы, обсуждения, руководства и «похожие» не выводятся: их модули (M5,
// M11) не написаны, а блок без данных — это пустое место на странице.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/** Подписи состояний выхода (`exit_state` → ключ интерфейса). */
const STATE_KEY = {
  airing: 'series.state.airing',
  waiting: 'series.state.waiting',
  ended: 'series.state.ended',
  cancelled: 'series.state.cancelled',
  announced: 'series.state.announced',
};

/** Человеческая дата: 12 октября 2026 / 12 октября. */
function formatDate(locale, value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function yearRange(series) {
  if (!series.yearStart) return '';
  return series.yearEnd ? `${series.yearStart}–${series.yearEnd}` : String(series.yearStart);
}

/**
 * @param {object} page
 * @param {string} page.locale
 * @param {object} page.series результат источника
 */
export function seriesView({ locale, series }) {
  const episodesCount = series.seasons.reduce((sum, season) => sum + season.episodes.length, 0);

  return html`
<article class="series">
  <header class="series__header">
    ${when(series.backdropWidth, () => html`
    <img class="series__backdrop" src="${imageUrl(locale, series.slug, 'backdrop', series.backdropWidth)}"
         alt="" width="${series.backdropWidth}" height="${Math.round(series.backdropWidth * 9 / 16)}"
         fetchpriority="high" decoding="async">`,
      () => html`<div class="series__backdrop series__backdrop--placeholder" aria-hidden="true"></div>`)}
    ${when(series.posterWidth, () => html`
    <img class="series__poster" src="${imageUrl(locale, series.slug, 'poster', series.posterWidth)}"
         alt="${series.title}" width="${series.posterWidth}" height="${Math.round(series.posterWidth * 3 / 2)}"
         loading="lazy" decoding="async">`)}
    <div class="series__plate">
      <h1 class="series__title">${series.title}</h1>
      ${when(series.titleOriginal !== series.title, () => html`
      <p class="series__original">${series.titleOriginal}</p>`)}
      <p class="series__meta">
        ${yearRange(series)}
        ${when(series.genres.length > 0, () => html` · ${series.genres.map((g) => g.name_ru).join(', ')}`)}
      </p>
      <p class="series__state">${t(locale, STATE_KEY[series.exitState] ?? 'series.state.waiting')}</p>
      ${when(series.nextRelease, () => html`
      <p class="series__next">
        ${t(locale, 'series.next', {
          date: formatDate(locale, series.nextRelease.date),
          number: series.nextRelease.number ?? '',
        })}
      </p>`)}
      ${when(!series.nextRelease, () => html`
      <p class="series__next">${t(locale, 'series.waitingSeason')}</p>`)}
      ${when(hasAnyRating(series.ratings), () => html`
      <ul class="series__ratings" role="list">
        ${rating(locale, 'IMDb', series.ratings.imdb)}
        ${rating(locale, 'TMDB', series.ratings.tmdb)}
        ${rating(locale, t(locale, 'series.rating.site'), series.ratings.site)}
      </ul>`)}
    </div>
  </header>

  <nav class="series__menu" aria-label="${t(locale, 'series.menu')}">
    <ul role="list">
      <li><a href="#overview">${t(locale, 'series.menu.overview')}</a></li>
      ${when(episodesCount > 0, () => html`
      <li><a href="#episodes">${t(locale, 'series.menu.episodes', { count: episodesCount })}</a></li>`)}
      ${when(series.people.cast.length > 0, () => html`
      <li><a href="#cast">${t(locale, 'series.menu.cast')}</a></li>`)}
    </ul>
  </nav>

  <section class="series__overview" id="overview" aria-labelledby="h-overview">
    <h2 class="series__section-title" id="h-overview">${t(locale, 'series.overview')}</h2>
    ${when(series.description, () => html`<p class="series__description">${series.description}</p>`,
      () => html`<p class="empty">${t(locale, 'series.description.empty')}</p>`)}
  </section>

  ${when(episodesCount > 0, () => html`
  <section class="series__episodes" id="episodes" aria-labelledby="h-episodes">
    <h2 class="series__section-title" id="h-episodes">${t(locale, 'series.menu.episodes', { count: episodesCount })}</h2>
    ${series.seasons.map((season) => html`
    <details class="season"${season.number === series.seasons[0].number ? html` open` : ''}>
      <summary class="season__title">
        <!-- Сезон — отдельная страница (S-07), а не якорь: у неё свой адрес,
             своя разметка для поисковика и ею можно поделиться. -->
        <a href="/${locale}/series/${series.slug}/seasons/${season.number}">
          ${t(locale, 'series.season', { number: season.number })}
        </a>
        ${when(season.title && season.title !== t(locale, 'series.season', { number: season.number }),
          () => html` — ${season.title}`)}
      </summary>
      <ol class="episodes" role="list">
        ${season.episodes.map((episode) => html`
        <li class="episode">
          <a class="episode__link"
             href="/${locale}/series/${series.slug}/seasons/${season.number}/episodes/${episode.number}">
            <span class="episode__number">${episode.number}</span>
            <span class="episode__title">${episode.title || t(locale, 'series.episode.untitled')}</span>
            ${when(episode.date, () => html`<span class="episode__date">${formatDate(locale, episode.date)}</span>`)}
          </a>
        </li>`)}
      </ol>
    </details>`)}
  </section>`)}

  ${when(series.people.cast.length > 0, () => html`
  <section class="series__cast" id="cast" aria-labelledby="h-cast">
    <h2 class="series__section-title" id="h-cast">${t(locale, 'series.menu.cast')}</h2>
    <ul class="people" role="list">
      ${series.people.cast.map((person) => html`
      <li class="people__item">${person.name}</li>`)}
    </ul>
  </section>`)}
</article>`;
}

/** Адрес картинки: роль и ширина, локаль обязательна (ADR-003). */
function imageUrl(locale, slug, role, width) {
  return `/${locale}/images/${slug}/${role}-${width}.webp`;
}

function hasAnyRating(ratings) {
  return Boolean(ratings.imdb || ratings.tmdb || ratings.site);
}

function rating(locale, label, value) {
  return when(Boolean(value), () => html`
  <li class="series__rating"><span class="series__rating-label">${label}</span>
    <span class="series__rating-value">${value.value.toFixed(1).replace('.', locale === 'en' ? '.' : ',')}</span></li>`);
}

/** Страница снятого с публикации сериала: 410 (EC-C1). */
export function goneView({ locale, slug }) {
  return html`
<section class="gone">
  <h1 class="gone__title">${t(locale, 'series.gone.title')}</h1>
  <p class="gone__text">${t(locale, 'series.gone.text')}</p>
  <p><a href="/${locale}/">${t(locale, 'series.gone.home')}</a></p>
  <p class="gone__slug"><code>${slug}</code></p>
</section>`;
}
