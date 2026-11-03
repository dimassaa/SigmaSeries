// S-05 — подборка.
// Спецификация: docs/01-product/features/M2-catalog.md, F-02-05.
//
// Баннер 16:9 с фокусом, название слева, сетка сериалов в порядке админа. Под
// баннером — только то, что есть: если фона нет, страница начинается с
// названия, а не с пустой рамки, которую человек примет за сломанную картинку.

import { html, when, raw } from './render.js';
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
      <a class="poster" href="/${locale}/series/${item.slug}" data-poster-card="${item.slug}" data-poster-info="${t(locale, 'poster.card.info')}">
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

/**
 * Название подборки для карточки сетки: своё, при пустом — текст другой
 * локали с пометкой языка (R-I18N-06). Оба пусты — подпись из адреса: ссылка
 * без имени недоступна с клавиатуры и не имеет смысла, а титул обязателен.
 *
 * Цепочка живёт здесь, а не в двух местах, потому что её читают двое: вид
 * карточки (текст с пометкой языка) и JSON-LD сетки (маршрут — только
 * текст): расхождение разметки и экрана заметили бы по тегу `lang` лишь
 * случайно.
 *
 * @param {string} locale
 * @param {{slug: string, titleRu: string, titleEn: string|null}} item
 * @returns {{text: string, lang: string|null}}
 */
export function cardTitleOf(locale, item) {
  const own = ((locale === 'en' ? item.titleEn : item.titleRu) ?? '').trim();
  const other = ((locale === 'en' ? item.titleRu : item.titleEn) ?? '').trim();
  const text = own || other || item.slug;
  // Свой текст — язык уже верный; заимствованный помечаем, чтобы озвучка и
  // расстановка переносов выбирались по нему (R-I18N-06).
  return { text, lang: own ? null : (other ? (locale === 'en' ? 'ru' : 'en') : null) };
}

/**
 * S-04 — сетка всех подборок (F-02-05 §1).
 *
 * Карточка — баннер 16:9 и название; счётчик сериалов на плитке не выводится:
 * число живёт внутри подборки, а плитка отвечает на вопрос «куда пойду».
 * Первый баннер грузится сразу — он вероятный LCP, остальные лениво; место
 * под них зарезервировано атрибутами и aspect-ratio, сдвига нет (R-PERF-03).
 *
 * @param {object} page
 * @param {string} page.locale
 * @param {Array<{slug: string, titleRu: string, titleEn: string|null,
 *   bannerWidth: number|null}>} page.items все видимые подборки по весу админа
 */
export function collectionsView({ locale, items }) {
  return html`
<h1 class="collections__title">${t(locale, 'collections.title')}</h1>
${when(items.length === 0, () => html`
<div class="empty-state">
  <p class="empty-state__title">${t(locale, 'collections.empty.title')}</p>
  <p class="empty-state__text">${t(locale, 'collections.empty.text')}</p>
  <p><a class="button" href="/${locale}/series">${t(locale, 'nav.allSeries')}</a></p>
</div>`)}
${when(items.length > 0, () => html`
<ol class="collections__grid" role="list">
  ${items.map((item, index) => collectionCard({ locale, item, index }))}
</ol>`)}`;
}

/**
 * Карточка подборки в сетке.
 *
 * @param {object} card
 * @param {string} card.locale
 * @param {{slug: string, titleRu: string, titleEn: string|null,
 *   bannerWidth: number|null}} card.item
 * @param {number} card.index позиция в сетке: первый баннер грузится сразу
 */
function collectionCard({ locale, item, index }) {
  const { text, lang } = cardTitleOf(locale, item);
  return html`
  <li class="collections__cell">
    <a class="collection-card" href="/${locale}/collections/${item.slug}">
      ${when(item.bannerWidth, () => html`
      <span class="collection-card__frame">
        <img class="collection-card__img"
             src="/${locale}/collections/${item.slug}/banner-${item.bannerWidth}.webp"
             alt="" width="${item.bannerWidth}" height="${Math.round(item.bannerWidth * 9 / 16)}"
             ${when(index === 0, () => raw('fetchpriority="high"'))}
             ${raw(index === 0 ? '' : 'loading="lazy"')}
             decoding="async">
      </span>`)}
      ${when(!item.bannerWidth, () => html`
      <span class="collection-card__frame collection-card__frame--sunken" aria-hidden="true"></span>`)}
      <span class="collection-card__title"${lang ? html` lang="${lang}"` : ''}>${text}</span>
    </a>
  </li>`;
}