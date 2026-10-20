// S-01 — главная страница.
// Спецификация: docs/01-product/features/M6-home.md, F-06-01…F-06-06.
//
// Порядок блоков задан и не переставляется: баннеры → свежее → подборки →
// жанры (input/spec.md). Причина — от самого важного к наименее важному,
// а подборки и жанры это способы уйти в каталог, а не самостоятельные цели.

import { html, raw, when } from './render.js';
import { t } from '../i18n/strings.js';
import { tPlural } from '../i18n/plural.js';

/**
 * Адрес картинки.
 *
 * Собирается здесь, а не в источнике: адрес содержит локали, а источник данных
 * о ней не знает (ADR-003). Роль и ширину он отдаёт готовыми.
 */
const imageUrl = (locale, slug, role, width) => (width ? `/${locale}/images/${slug}/${role}-${width}.webp` : null);

/**
 * @param {object} page
 * @param {string} page.locale
 * @param {object} page.data результат data.js
 */
export function homeView({ locale, data }) {
  // Ряд «Для вас» для вошедшего и «Популярное» для гостя — одна и та же
  // геометрия, разный только заголовок (F-06-06 §19).
  const forYou = data.forYou ?? { items: [], personalized: false };
  // Интервал бегущей строки — из настроек: он меняется администратором, а
  // значение в разметке осталось бы прежним.
  const marqueeInterval = Number(data.marqueeIntervalMs) > 0 ? Number(data.marqueeIntervalMs) : 4000;

  const body = html`
<h1 class="visually-hidden">${t(locale, 'home.title')}</h1>

<section class="block block--banners" aria-labelledby="h-banners">
  <h2 class="block__title" id="h-banners">${t(locale, 'home.banners.heading')}</h2>
  ${when(data.banners.length > 0, () => html`
  <ul class="banners" role="list">
    ${data.banners.map((b) => html`
    <li class="banners__item">
      <a class="banner" href="/${locale}/series/${b.seriesSlug}"
         aria-label="${t(locale, `home.banners.reason.${b.reason}`)}, ${b.title}, ${t(locale, 'home.banners.rating', { rating: b.imdb })}${when(b.withdrawn, () => `, ${t(locale, 'home.banners.withdrawn')}`)}">
        ${when(b.backdropWidth && !b.withdrawn,
          () => html`<img class="banner__image" src="${imageUrl(locale, b.seriesSlug, 'backdrop', b.backdropWidth)}"
                    alt="" width="1280" height="720" loading="lazy" decoding="async">`)}
        ${when(!b.backdropWidth || b.withdrawn,
          () => html`<span class="banner__placeholder" aria-hidden="true"></span>`)}
        <span class="banner__scrim"></span>
        ${when(b.withdrawn, () => html`<span class="banner__notice">${t(locale, 'home.banners.withdrawn')}</span>`)}
        <span class="banner__reason">${t(locale, `home.banners.reason.${b.reason}`)}</span>
        <span class="banner__title">${b.title}</span>
        <span class="banner__meta">${b.yearRange} · ${t(locale, 'home.banners.rating', { rating: b.imdb })}</span>
      </a>
    </li>`)}
  </ul>`)}
  ${when(data.banners.length === 0, () => html`<p class="empty">${t(locale, 'home.banners.empty')}</p>`)}
</section>

<section class="block block--foryou" aria-labelledby="h-foryou">
  <h2 class="block__title" id="h-foryou">
    ${t(locale, forYou.personalized ? 'home.foryou.heading' : 'home.foryou.popular')}
  </h2>
  ${when(forYou.items.length > 0, () => html`
  <ol class="posters" role="list">
    ${forYou.items.map((s) => html`
    <li class="posters__item">
      <a class="poster" href="/${locale}/series/${s.slug}"
         aria-label="${t(locale, 'home.fresh.itemLabel', { title: s.title, year: s.year })}">
        <span class="poster__frame">
          ${when(s.posterWidth, () => html`<img class="poster__img" src="${imageUrl(locale, s.slug, 'poster', s.posterWidth)}"
             alt="" width="185" height="278" loading="lazy" decoding="async">`)}
          ${when(!s.posterWidth, () => html`<span class="poster__fallback" aria-hidden="true"></span>`)}
        </span>
        <span class="poster__title">${s.title}</span>
        <span class="poster__meta">${s.year}</span>
      </a>
    </li>`)}
  </ol>`)}
</section>

<section class="block block--fresh" aria-labelledby="h-fresh">
  <h2 class="block__title" id="h-fresh">${t(locale, 'home.fresh.heading')}</h2>
  ${when(data.fresh.length > 0, () => html`
  <div class="carousel" data-carousel>
    <button class="carousel__button carousel__button--prev" type="button" data-carousel-prev
            aria-label="${t(locale, 'home.fresh.prev')}"><span aria-hidden="true">‹</span></button>
    <div class="carousel__slides">
      ${data.fresh.map((circle, index) => html`
      <ol class="posters carousel__circle" role="list" data-carousel-circle
         ${index === 0 ? '' : 'hidden'}>
        ${circle.map((s) => html`
        <li class="posters__item">
          <a class="poster" href="/${locale}/series/${s.slug}"
             aria-label="${t(locale, 'home.fresh.itemLabel', { title: s.title, year: s.year })}">
            <span class="poster__frame">
              ${when(s.posterWidth, () => html`<img class="poster__img" src="${imageUrl(locale, s.slug, 'poster', s.posterWidth)}"
                 alt="" width="185" height="278" loading="lazy" decoding="async">`)}
              ${when(!s.posterWidth, () => html`<span class="poster__fallback" aria-hidden="true"></span>`)}
            </span>
            <span class="poster__title">${s.title}</span>
            <span class="poster__meta">${s.year}</span>
          </a>
        </li>`)}
      </ol>`)}
    </div>
    <button class="carousel__button carousel__button--next" type="button" data-carousel-next
            aria-label="${t(locale, 'home.fresh.next')}"><span aria-hidden="true">›</span></button>
    ${when(data.fresh.length > 1, () => html`
    <div class="carousel__dots" data-carousel-dots>
      ${data.fresh.map((circle, index) => html`
      <button class="carousel__dot${index === 0 ? ' is-current' : ''}" type="button"
              data-carousel-dot="${index}" aria-current="${index === 0 ? 'true' : 'false'}"
              aria-label="${t(locale, 'home.fresh.dot', { n: index + 1 })}"></button>`)}
    </div>`)}
  </div>`)}
  ${when(data.fresh.length === 0, () => html`<p class="empty">${t(locale, 'home.fresh.empty')}</p>`)}
</section>

<section class="block block--collections" aria-labelledby="h-collections">
  <h2 class="block__title" id="h-collections">${t(locale, 'home.collections.heading')}</h2>
  ${when(data.collections.length > 0, () => html`
  <div class="marquee" data-marquee data-interval="${marqueeInterval}">
    <button class="marquee__button" type="button" data-marquee-prev
            aria-label="${t(locale, 'home.collections.prev')}"><span aria-hidden="true">‹</span></button>
    <div class="marquee__viewport" data-marquee-viewport>
      <ul class="marquee__track" role="list" data-marquee-track>
        ${data.collections.map((c) => html`
        <li class="marquee__item">
          <a class="collection" href="/${locale}/collections/${c.slug}"
             aria-label="${tPlural(locale, 'home.collections.itemLabel', c.count, { title: c.title })}">
            ${when(c.bannerWidth && c.bannerSlug,
              () => html`<img class="collection__banner" src="${imageUrl(locale, c.bannerSlug, 'backdrop', c.bannerWidth)}"
                   alt="" width="320" height="180" loading="lazy" decoding="async">`)}
            <span class="collection__body">
              <span class="collection__title">${c.title}</span>
              <span class="collection__count">${c.count}</span>
            </span>
          </a>
        </li>`)}
      </ul>
    </div>
    <button class="marquee__button" type="button" data-marquee-next
            aria-label="${t(locale, 'home.collections.next')}"><span aria-hidden="true">›</span></button>
  </div>`)}
  ${when(data.collections.length === 0, () => html`<p class="empty">${t(locale, 'home.collections.empty')}</p>`)}
</section>

<section class="block block--genres" aria-labelledby="h-genres">
  <h2 class="block__title" id="h-genres">${t(locale, 'home.genres.heading')}</h2>
  ${when(data.genres.length > 0, () => html`
  <ul class="genres" role="list">
    ${data.genres.map((g) => html`
    <li class="genres__item">
      <a class="genre" href="/${locale}/genres/${g.code}"
         aria-label="${t(locale, 'home.genres.itemLabel', { title: g.title })}">
        <span class="genre__title">${g.title}</span>
      </a>
    </li>`)}
  </ul>`)}
  ${when(data.genres.length === 0, () => html`<p class="empty">${t(locale, 'home.genres.empty')}</p>`)}
</section>`;

  return raw(body.__raw);
}