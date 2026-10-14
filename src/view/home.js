// S-01 — главная страница.
// Спецификация: docs/01-product/features/M6-home.md, F-06-01…F-06-06.
//
// Порядок блоков задан и не переставляется: баннеры → свежее → подборки →
// жанры (input/spec.md). Причина — от самого важного к наименее важному,
// а подборки и жанры это способы уйти в каталог, а не самостоятельные цели.

import { html, raw, when } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * @param {object} page
 * @param {string} page.locale
 * @param {object} page.data результат data.js
 */
export function homeView({ locale, data }) {
  const body = html`
<h1 class="visually-hidden">${t(locale, 'home.title')}</h1>

<section class="block block--banners" aria-labelledby="h-banners">
  <h2 class="block__title" id="h-banners">${t(locale, 'home.banners.heading')}</h2>
  ${when(data.banners.length > 0, () => html`
  <ul class="banners" role="list">
    ${data.banners.map((b) => html`
    <li class="banners__item">
      <a class="banner" href="${locale}/series/${b.seriesSlug}/"
         aria-label="${t(locale, `home.banners.reason.${b.reason}`)}, ${b.title}, ${t(locale, 'home.banners.rating', { rating: b.imdb })}">
        <span class="banner__scrim"></span>
        <span class="banner__reason">${t(locale, `home.banners.reason.${b.reason}`)}</span>
        <span class="banner__title">${b.title}</span>
        <span class="banner__meta">${b.yearRange} · ${t(locale, 'home.banners.rating', { rating: b.imdb })}</span>
      </a>
    </li>`)}
  </ul>`)}
  ${when(data.banners.length === 0, () => html`<p class="empty">${t(locale, 'home.banners.empty')}</p>`)}
</section>

<section class="block block--fresh" aria-labelledby="h-fresh">
  <h2 class="block__title" id="h-fresh">${t(locale, 'home.fresh.heading')}</h2>
  ${when(data.fresh.length > 0, () => html`
  <ol class="posters" role="list">
    ${data.fresh.map((s) => html`
    <li class="posters__item">
      <a class="poster" href="${locale}/series/${s.slug}/"
         aria-label="${t(locale, 'home.fresh.itemLabel', { title: s.title, year: s.year })}">
        <span class="poster__frame">
          ${when(s.posterUrl, () => html`<img class="poster__img" src="${s.posterUrl}"
             alt="" width="200" height="300" loading="lazy" decoding="async">`)}
          ${when(!s.posterUrl, () => html`<span class="poster__fallback" aria-hidden="true"></span>`)}
        </span>
        <span class="poster__title">${s.title}</span>
        <span class="poster__meta">${s.year}</span>
      </a>
    </li>`)}
  </ol>`)}
  ${when(data.fresh.length === 0, () => html`<p class="empty">${t(locale, 'home.fresh.empty')}</p>`)}
</section>

<section class="block block--collections" aria-labelledby="h-collections">
  <h2 class="block__title" id="h-collections">${t(locale, 'home.collections.heading')}</h2>
  ${when(data.collections.length > 0, () => html`
  <ul class="marquee" role="list">
    ${data.collections.map((c) => html`
    <li class="marquee__item">
      <a class="collection" href="${locale}/collections/${c.slug}/"
         aria-label="${t(locale, 'home.collections.itemLabel', { title: c.title, count: c.count })}">
        <span class="collection__title">${c.title}</span>
        <span class="collection__count">${c.count}</span>
      </a>
    </li>`)}
  </ul>`)}
  ${when(data.collections.length === 0, () => html`<p class="empty">${t(locale, 'home.collections.empty')}</p>`)}
</section>

<section class="block block--genres" aria-labelledby="h-genres">
  <h2 class="block__title" id="h-genres">${t(locale, 'home.genres.heading')}</h2>
  ${when(data.genres.length > 0, () => html`
  <ul class="genres" role="list">
    ${data.genres.map((g) => html`
    <li class="genres__item">
      <a class="genre" href="${locale}/genres/${g.code}/"
         aria-label="${t(locale, 'home.genres.itemLabel', { title: g.title })}">
        <span class="genre__title">${g.title}</span>
      </a>
    </li>`)}
  </ul>`)}
  ${when(data.genres.length === 0, () => html`<p class="empty">${t(locale, 'home.genres.empty')}</p>`)}
</section>`;

  return raw(body.__raw);
}