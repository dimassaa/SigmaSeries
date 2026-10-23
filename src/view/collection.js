// S-05 — подборка.
// Спецификация: docs/01-product/features/M2-catalog.md, F-02-05.
//
// Баннер 16:9 с фокусом, название слева, сетка сериалов в порядке админа. Под
// баннером — только то, что есть: если фона нет, страница начинается с
// названия, а не с пустой рамки, которую человек примет за сломанную картинку.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * @param {object} page
 * @param {string} page.locale
 * @param {any} page.collection данные источника
 */
export function collectionView({ locale, collection }) {
  return html`
<article class="collection">
  ${when(collection.banner, () => html`
  <div class="collection__banner">
    <img class="collection__banner-img"
         src="/${locale}/collections/${collection.slug}/banner-${collection.banner.width}.webp"
         alt="" width="${collection.banner.width}" height="${Math.round(collection.banner.width * 9 / 16)}"
         fetchpriority="high" decoding="async">
    <div class="collection__banner-plate">
      <span class="collection__banner-scrim" aria-hidden="true"></span>
      <h1 class="collection__title">${collection.title}</h1>
    </div>
  </div>`,
  () => html`
  <header class="collection__header">
    <h1 class="collection__title">${collection.title}</h1>
  </header>`)}

  ${when(collection.description, () => html`
  <p class="collection__description">${collection.description}</p>`)}

  <h2 class="collection__section-title">${t(locale, 'collection.series', { count: collection.total })}</h2>

  <ol class="posters" role="list">
    ${collection.series.map((item) => html`
    <li class="posters__item">
      <a class="poster" href="/${locale}/series/${item.slug}" data-poster-card="${item.slug}" data-poster-info="${t(locale, 'poster.card.info')}"">
        <span class="poster__frame">
          ${when(item.posterWidth, () => html`<img class="poster__img"
             src="/${locale}/images/${item.slug}/poster-${item.posterWidth}.webp"
             alt="" width="185" height="278" loading="lazy" decoding="async">`)}
          ${when(!item.posterWidth, () => html`<span class="poster__fallback" aria-hidden="true"></span>`)}
        </span>
        <span class="poster__title">${item.title}</span>
        ${when(item.year, () => html`<span class="poster__meta">${item.year}</span>`)}
      </a>
    </li>`)}
  </ol>
</article>`;
}