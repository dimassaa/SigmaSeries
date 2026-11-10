// S-03 — страница жанра.
// Спецификация: docs/01-product/features/M2-catalog.md, F-02-04.
//
// Сетка, сортировки и постраничность — как на каталоге (F-02-03): жанр задаёт
// только фильтр, поэтому человек должен узнавать экран. Отличия — шапка:
// название жанра, число сериалов и описание из справочника вместо формы
// фильтров; жанр здесь нельзя ни добавить, ни снять, он пришёл из адреса.

import { html, when, raw } from './render.js';
import { t } from '../i18n/strings.js';
import { tPlural } from '../i18n/plural.js';

const STATE_KEY = {
  airing: 'series.state.airing',
  waiting: 'series.state.waiting',
  announced: 'series.state.announced',
  ended: 'series.state.ended',
  cancelled: 'series.state.cancelled',
};

/**
 * Адрес страницы жанра с сортировкой и постраничностью.
 *
 * Параметры кладутся в адрес только тогда, когда они нестандартные: народная
 * ссылка — `/ru/genres/drama`, и её должен получать поисковик без мусора.
 *
 * @param {string} locale
 * @param {string} code код жанра
 * @param {{sort?: string|null, page?: number}} [extra]
 */
function genreHref(locale, code, extra = {}) {
  const params = new URLSearchParams();
  if (extra.sort && extra.sort !== 'popular') params.set('sort', extra.sort);
  if (extra.page && extra.page > 1) params.set('page', String(extra.page));
  const query = params.toString();
  return `/${locale}/genres/${code}${query ? `?${query}` : ''}`;
}

/** Рейтинг в записи локали: 9.1 → «9,1» / «9.1» (как на каталоге). */
function rating(value, locale) {
  if (value == null) return '';
  return new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'ru-RU', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function years(item) {
  if (!item.yearStart) return '';
  return item.yearEnd ? `${item.yearStart}–${item.yearEnd}` : String(item.yearStart);
}

function imageUrl(locale, item) {
  return item.posterWidth ? `/${locale}/images/${item.slug}/poster-${item.posterWidth}.webp` : null;
}

/**
 * Описание жанра в записи страницы: своё, а при пустом — текст другой локали
 * с пометкой языка (R-I18N-06). Оба описания пусты → блок не выводится:
 * подпись «описания нет» была бы обманом там, где справочник просто ещё
 * не заполнен (F-10-10 §4).
 *
 * @param {string} locale
 * @param {{descriptionRu: string|null, descriptionEn: string|null}} genre
 * @returns {{text: string, lang: string|null}}
 */
function descriptionOf(locale, genre) {
  const own = ((locale === 'en' ? genre.descriptionEn : genre.descriptionRu) ?? '').trim();
  const other = ((locale === 'en' ? genre.descriptionRu : genre.descriptionEn) ?? '').trim();
  const text = own || other;
  // Свой текст — язык уже правилен; чужой — помечаем, чтобы озвучка и
  // расстановка переносов выбирались по нему, а не по языку страницы.
  return { text, lang: own ? null : (text ? (locale === 'en' ? 'ru' : 'en') : null) };
}

/**
 * Страница выдачи каталога — то, что `pgCatalogueList` возвращает под вызов
 * вида `list({ genres, sort, page })`; фильтры жанра через панель здесь не
 * нужны, поэтому поля карточки перечислены выборочно.
 *
 * @typedef {object} ListingPage
 * @property {Array<{slug: string, title: string, yearStart: number|null,
 *   yearEnd: number|null, exitState: string, genreCode: string|null,
 *   genreName: string|null, rating: number|null, posterWidth: number|null}>} items
 * @property {number} total
 * @property {number} page
 * @property {number} pages
 * @property {string} sort
 */

/**
 * @param {object} page
 * @param {string} page.locale
 * @param {{code: string, nameRu: string, nameEn: string,
 *   descriptionRu: string|null, descriptionEn: string|null,
 *   displayOrder: number|null, count: number}} page.genre жанр с числом видимых сериалов
 * @param {ListingPage} page.page выдача каталога с фильтром жанра
 * @param {string[]} page.sorts ключи сортировок в порядке показа
 */
export function genreView({ locale, genre, page, sorts }) {
  const name = locale === 'en' ? genre.nameEn : genre.nameRu;
  const { text, lang } = descriptionOf(locale, genre);
  // Сортировка едет вместе с постраничностью; популярная — стандарт адреса,
  // её строку не пишем (такой же адрес уже виден в сортировках).
  const sortParam = page.sort !== 'popular' ? page.sort : null;

  return html`
<h1 class="catalog__title">${name}</h1>
<p class="results__count" data-total="${genre.count}">${tPlural(locale, 'genre.count', genre.count)}</p>
${when(text, () => html`
<p class="genre__description"${lang ? html` lang="${lang}"` : ''}>${text}</p>`)}

<section class="results" aria-labelledby="h-results">
  <div class="results__bar">
    <nav class="sorts" aria-label="${t(locale, 'catalog.sort.label')}">
      ${sorts.map((key) => html`
      <a class="sorts__item" href="${genreHref(locale, genre.code, { sort: key })}"
         ${when(page.sort === key, () => raw('aria-current="true"'))}>${t(locale, `catalog.sort.${key}`)}</a>`)}
    </nav>
  </div>

  ${when(page.items.length > 0, () => html`
  <ol class="posters" role="list">
    ${page.items.map((item) => {
      const poster = imageUrl(locale, item);
      return html`
      <li class="posters__item">
        <a class="poster" href="/${locale}/series/${item.slug}"
           data-poster-card="${item.slug}" data-poster-info="${t(locale, 'poster.card.info')}">
          <span class="poster__frame">
            ${when(poster, () => html`<img class="poster__img" src="${poster}"
               alt="" width="185" height="278" loading="lazy" decoding="async">`)}
            ${when(!poster, () => html`<span class="poster__fallback" aria-hidden="true"></span>`)}
          </span>
          <span class="poster__title">${item.title}</span>
          <span class="poster__meta">
            ${years(item)}${when(item.genreName, () => html` · ${item.genreName}`)}${when(item.rating != null, () => html` · ${rating(item.rating, locale)}`)}
          </span>
          <span class="visually-hidden">${t(locale, STATE_KEY[item.exitState])}</span>
        </a>
      </li>`;
    })}
  </ol>`)}

  ${when(page.items.length === 0, () => html`
  <div class="empty-state">
    <p class="empty-state__title">${t(locale, 'genre.empty.title')}</p>
    <p class="empty-state__text">${t(locale, 'genre.empty.text')}</p>
    <p><a class="button button--primary" href="/${locale}/series">${t(locale, 'nav.allSeries')}</a></p>
  </div>`)}

  ${when(page.pages > 1, () => pagination({ locale, genre, page, sortParam }))}
</section>`;
}

/**
 * Постраничность внутри жанра (R-SEO-09): настоящие ссылки, сортировка
 * сохраняется.
 */
function pagination({ locale, genre, page, sortParam }) {
  const last = page.pages;
  const current = page.page;
  const from = Math.max(1, Math.min(current - 2, last - 4));
  const to = Math.min(last, Math.max(current + 2, 5));
  const numbers = [];
  for (let number = from; number <= to; number += 1) numbers.push(number);

  return html`
<nav class="pagination" aria-label="${t(locale, 'catalog.pagination.label')}">
  ${when(current > 1, () => html`
  <a class="pagination__step" href="${genreHref(locale, genre.code, { sort: sortParam, page: current - 1 })}"
     rel="prev">${t(locale, 'catalog.pagination.prev')}</a>`)}

  ${when(from > 1, () => html`<span class="pagination__gap" aria-hidden="true">…</span>`)}
  ${numbers.map((number) => html`
  <a class="pagination__item" href="${genreHref(locale, genre.code, { sort: sortParam, page: number })}"
     ${when(number === current, () => raw('aria-current="page"'))}>${number}</a>`)}
  ${when(to < last, () => html`<span class="pagination__gap" aria-hidden="true">…</span>`)}

  ${when(current < last, () => html`
  <a class="pagination__step" href="${genreHref(locale, genre.code, { sort: sortParam, page: current + 1 })}"
     rel="next">${t(locale, 'catalog.pagination.next')}</a>`)}
</nav>`;
}
