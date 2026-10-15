// S-17 — результаты поиска.
// Спецификация: docs/01-product/features/M2-catalog.md, F-02-06.
//
// Группы идут в порядке «что человек искал раньше всего»: сериалы, люди,
// подборки. Порядок задан спецификацией и не переставляется по числу совпадений —
// иначе при пяти подборках и одном сериале человек увидит подборку раньше
// сериала, ради которого пришёл.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

const STATE_KEY = {
  airing: 'series.state.airing',
  waiting: 'series.state.waiting',
  announced: 'series.state.announced',
  ended: 'series.state.ended',
  cancelled: 'series.state.cancelled',
};

function year(item) {
  if (!item.yearStart) return '';
  return item.yearEnd ? `${item.yearStart}–${item.yearEnd}` : String(item.yearStart);
}

/**
 * @param {object} page
 * @param {string} page.locale
 * @param {string} page.query как введено человеком; выводится дословно
 * @param {object|null} page.result результат источника; `null` — превышен лимит
 * @param {object[]} page.genres жанры для пустого состояния
 */
export function searchView({ locale, query, result, genres }) {
  const empty = !result || result.total === 0;

  return html`
<h1 class="search__title">${t(locale, 'search.title')}</h1>

<form class="search__form" method="get" action="/${locale}/search" role="search">
  <label class="visually-hidden" for="search-q">${t(locale, 'search.field')}</label>
  <input class="search__input" id="search-q" type="search" name="q" value="${query}"
         placeholder="${t(locale, 'search.placeholder')}" autocomplete="off"
         enterkeyhint="search">
  <button class="button" type="submit">${t(locale, 'search.submit')}</button>
</form>

${when(result?.layoutFixed, () => html`
<p class="search__layout" role="status">
  ${t(locale, 'search.layoutHint', { value: result.layoutFixed })}
  <a class="search__layout-as-is" href="/${locale}/search?q=${encodeURIComponent(query)}"
     data-as-is>${t(locale, 'search.layoutAsIs')}</a>
</p>`)}

${when(empty, () => emptyView({ locale, result, genres }))}
${when(result && !empty, () => results({ locale, result }))}`;
}

/** Три группы по порядку из спецификации. */
function results({ locale, result }) {
  return html`
<p class="search__count" role="status">${t(locale, 'search.found', { count: result.total })}</p>

${when(result.series.length > 0, () => html`
<section class="search__group" aria-labelledby="h-search-series">
  <h2 class="search__group-title" id="h-search-series">${t(locale, 'search.group.series')}</h2>
  <ol class="posters" role="list">
    ${result.series.map((item) => html`
    <li class="posters__item">
      <a class="poster" href="/${locale}/series/${item.slug}">
        <span class="poster__frame">
          ${when(item.posterWidth, () => html`<img class="poster__img"
             src="/${locale}/images/${item.slug}/poster-${item.posterWidth}.webp"
             alt="" width="185" height="278" loading="lazy" decoding="async">`)}
          ${when(!item.posterWidth, () => html`<span class="poster__fallback" aria-hidden="true"></span>`)}
        </span>
        <span class="poster__title">${item.title}</span>
        <span class="poster__meta">${year(item)}</span>
        <span class="visually-hidden">${t(locale, STATE_KEY[item.exitState] ?? 'series.state.waiting')}</span>
      </a>
    </li>`)}
  </ol>
</section>`)}

${when(result.people.length > 0, () => html`
<section class="search__group" aria-labelledby="h-search-people">
  <h2 class="search__group-title" id="h-search-people">${t(locale, 'search.group.people')}</h2>
  <ul class="search__list" role="list">
    ${result.people.map((person) => html`
    <li class="search__row">
      <a class="search__link" href="/${locale}/people/${person.slug}">
        <span class="search__row-title">${person.name}</span>
        <span class="search__row-meta">${t(locale, `search.person.${person.kind}`)}</span>
      </a>
    </li>`)}
  </ul>
</section>`)}

${when(result.collections.length > 0, () => html`
<section class="search__group" aria-labelledby="h-search-collections">
  <h2 class="search__group-title" id="h-search-collections">${t(locale, 'search.group.collections')}</h2>
  <ul class="search__list" role="list">
    ${result.collections.map((collection) => html`
    <li class="search__row">
      <a class="search__link" href="/${locale}/collections/${collection.slug}">
        <span class="search__row-title">${collection.title}</span>
      </a>
    </li>`)}
  </ul>
</section>`)}`;
}

/**
 * Ничего не нашлось.
 *
 * Три подсказки по порядку полезности: другая раскладка (если человек её
 * упустил), жанры, где результат точно есть. Пустое состояние без предложений
 * — это просто «ничего не найдено», и человек уходит.
 */
function emptyView({ locale, result, genres }) {
  return html`
<div class="empty-state">
  <p class="empty-state__title">${t(locale, 'search.empty.title')}</p>
  ${when(result?.query, () => html`<p class="empty-state__text">${t(locale, 'search.empty.text', { query: result.query })}</p>`)}
  ${when(result?.layoutFixed, () => html`
  <p class="empty-state__hint">${t(locale, 'search.layoutHint', { value: result.layoutFixed })}</p>`)}
  ${when(genres.length > 0, () => html`
  <p class="empty-state__hint">${t(locale, 'search.empty.tryGenre')}</p>
  <ul class="empty-state__genres" role="list">
    ${genres.map((genre) => html`
    <li><a class="chip" href="/${locale}/genres/${genre.code}">${genre.title}</a></li>`)}
  </ul>`)}
</div>`;
}