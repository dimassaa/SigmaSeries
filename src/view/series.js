// S-06 — страница сериала.
// Спецификация: docs/01-product/features/M2-catalog.md, F-02-01.
//
// Порядок блоков задан якорем: шапка → меню → обзор → серии → в ролях →
// отзывы. Обсуждения, руководства и «похожие» не выводятся: их модули (M5,
// M11) не написаны, а блок без данных — это пустое место на странице.

import { html, when, raw } from './render.js';
import { t } from '../i18n/strings.js';
import { fullDate as formatDate } from './dates.js';
import { statusControl } from './status.js';
import { progressView } from './progress.js';
import { subscribeBell } from './subscribe.js';
import { seriesRatingBlock, number } from './rating.js';
import { reviewSection } from './reviews.js';
import { topReviews } from './reviewList.js';

/** Подписи состояний выхода (`exit_state` → ключ интерфейса). */
const STATE_KEY = {
  airing: 'series.state.airing',
  waiting: 'series.state.waiting',
  ended: 'series.state.ended',
  cancelled: 'series.state.cancelled',
  announced: 'series.state.announced',
};

function yearRange(series) {
  if (!series.yearStart) return '';
  return series.yearEnd ? `${series.yearStart}–${series.yearEnd}` : String(series.yearStart);
}

/**
 * @param {object} page
 * @param {string} page.locale
 * @param {object} page.series результат источника
 * @param {{value: string|null, csrf: string, signedIn: boolean, archived: boolean}|null} [page.status]
 *   статус зрителя; `null` — источник статусов не подключён или это гость без сессии
 * @param {object|null} [page.progress] прогресс и «продолжить» (F-03-03)
 * @param {{state: object|null, csrf: string, signedIn: boolean}|null} [page.subscribe]
 *   колокольчик подписки; `null` — источник подписок не подключён. Снятый с
 *   публикации сериал до вида не доходит: выше стоит 410 (EC-C1)
 * @param {string|null} [page.notice] отказ после действия: `limit`
 * @param {object|null} [page.reviewBlock] данные блока «Ваш отзыв» (F-04-04):
 *   `own`, `gate`, `review`, `rating`, `values`, `error`, `editing`
 * @param {object[]|null} [page.reviewTop] «Лучшие отзывы» (F-02-01 §4); пусто —
 *   блока нет
 * @param {Map|null} [page.votesById] id отзыва → данные кнопки «Полезно»
 *   (F-04-06) для карточек блока «Лучшие»
 * @param {string|null} [page.timezone] пояс посетителя: по нему подписывается
 *   день, с которого голос войдёт в рейтинг (EC-V4)
 */
export function seriesView({
  locale, series, status = null, progress = null, subscribe = null, ratingBlock = null,
  reviewBlock = null, reviewTop = null, votesById = null, notice = null, timezone = null,
  report = null,
  csrf = '',
}) {
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
      ${when(status, () => html`
      ${statusControl({
        locale,
        slug: series.slug,
        status: status.value,
        signedIn: status.signedIn,
        csrf: status.csrf,
        archived: status.archived,
      })}`)}

      ${when(subscribe, () => html`
      ${subscribeBell({
        locale,
        slug: series.slug,
        state: subscribe.state,
        csrf: subscribe.csrf,
        signedIn: subscribe.signedIn,
      })}`)}

      ${when(notice === 'limit', () => html`
      <p class="subs-notice" role="status">${t(locale, 'subs.notice.limit')}</p>`)}

      <h1 class="series__title">${series.title}</h1>
      ${when(series.titleOriginal !== series.title, () => html`
      <p class="series__original">${series.titleOriginal}</p>`)}
      <p class="series__meta">
        ${yearRange(series)}
        ${when(series.genres.length > 0, () => html` · ${series.genres.map((g) => g.name_ru).join(', ')}`)}
      </p>
      <p class="series__state">${t(locale, STATE_KEY[series.exitState] ?? 'series.state.waiting')}</p>
      ${progressView({ locale, series, progress })}
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

      ${when(ratingBlock, () => seriesRatingBlock({ locale, slug: series.slug, rating: ratingBlock, timezone }))}
    </div>
  </header>

  <nav class="series__menu" aria-label="${t(locale, 'series.menu')}">
    <ul role="list">
      <li><a href="#overview">${t(locale, 'series.menu.overview')}</a></li>
      ${when(episodesCount > 0, () => html`
      <li><a href="#episodes">${t(locale, 'series.menu.episodes', { count: episodesCount })}</a></li>`)}
      ${when(series.people.cast.length > 0, () => html`
      <li><a href="#cast">${t(locale, 'series.menu.cast')}</a></li>`)}
      ${when(reviewBlock, () => html`
      <li><a href="#reviews">${t(locale, 'series.menu.reviews')}</a></li>`)}
      <li><a href="/${locale}/series/${series.slug}/discussions">${t(locale, 'series.menu.discussions')}</a></li>
      <li><a href="/${locale}/series/${series.slug}/guides">${t(locale, 'series.menu.guides')}</a></li>
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
      <li class="people__item">
        <a href="/${locale}/people/${person.slug}">${person.name}</a>
      </li>`)}
    </ul>
  </section>`)}

  ${when(series.similar?.length > 0, () => similarSection({
    locale, items: series.similar, csrf, seriesSlug: series.slug,
  }))}

  ${when(reviewBlock, () => reviewSection({ locale, slug: series.slug, timezone, ...reviewBlock }))}

  ${when(reviewTop?.length > 0, () => topReviews({ locale, series, items: reviewTop, timezone, votesById, report }))}
</article>`;
}

/**
 * Похожие сериалы (F-02-08).
 *
 * Блок появляется, когда есть хоть один похожий: пустого блока «Похожие» на
 * странице нет. Карточки — те же, что в каталоге, со слоем по наведению
 * (UI-10).
 */
/**
 * Причина сходства: называет конкретное общее — человека, жанр или слово.
 *
 * @param {string} locale
 * @param {{kind: string, title: string, titleEn?: string}} reason
 * @returns {string}
 */
function similarReason(locale, reason) {
  const title = locale === 'en' ? (reason.titleEn ?? reason.title) : reason.title;
  if (reason.kind === 'person') return t(locale, 'series.similar.reason.person', { title });
  if (reason.kind === 'keyword') return t(locale, 'series.similar.reason.keyword', { title });
  return t(locale, 'series.similar.reason.genre', { title });
}

function similarSection({ locale, items, csrf = '', seriesSlug = '' }) {
  return html`
  <section class="series__similar" id="similar" aria-labelledby="h-similar">
    <h2 class="series__section-title" id="h-similar">${t(locale, 'series.similar')}</h2>
    <ol class="posters" role="list">
      ${items.map((item) => html`
      <li class="posters__item">
        <a class="poster" href="/${locale}/series/${item.slug}" data-poster-card="${item.slug}"
           data-track-impression="reco_impression" data-track-click="reco_click"
           data-poster-info="${t(locale, 'poster.card.info')}">
          <span class="poster__frame">
            ${when(item.posterWidth, () => html`<img class="poster__img"
               src="${imageUrl(locale, item.slug, 'poster', item.posterWidth)}"
               alt="" width="185" height="278" loading="lazy" decoding="async">`)}
            ${when(!item.posterWidth, () => html`<span class="poster__fallback" aria-hidden="true"></span>`)}
          </span>
          <span class="poster__title">${item.title}</span>
          ${when(item.reason, () => html`
          <span class="poster__reason">${similarReason(locale, item.reason)}</span>`)}
          <span class="poster__meta">
            ${when(item.yearStart, () => html`${item.yearStart}`)}
            ${when(item.exitState, () => html` · ${t(locale, `series.state.${item.exitState}`)}`)}
          </span>
        </a>
        <form class="posters__dismiss" method="post" action="/${locale}/reco/dismiss">
          <input type="hidden" name="csrf" value="${csrf}">
          <input type="hidden" name="series" value="${item.slug}">
          <input type="hidden" name="back" value="/${locale}/series/${seriesSlug}">
          <button class="button button--quiet" type="submit" data-track-click="reco_dismiss"
            >${t(locale, 'reco.dismiss')}</button>
        </form>
      </li>`)}
    </ol>
  </section>`;
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
