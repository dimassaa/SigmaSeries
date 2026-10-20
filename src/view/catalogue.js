// S-02 — каталог сериалов.
// Спецификация: docs/01-product/features/M2-catalog.md, F-02-03.
//
// Фильтры — обычная форма GET, а не скрипт: ссылки настоящие, страницу можно
// переслать, а человек с отключёнными скриптами получает ту же выдачу.
// Скрипт может улучшить (переключать без перезагрузки), но не является
// условием работы страницы.

import { html, when, raw } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * Адрес каталога с заданными фильтрами.
 *
 * Единая точка сборки адреса: и сортировка, и постраничность, и «Сбросить»
 * обязаны давать одинаковый вид ссылки — иначе по ссылке нельзя поделиться,
 * а канонический адрес и постраничность разъезжаются (R-SEO-02, R-SEO-09).
 * Пустые значения в адрес не попадают: `?sort=popular&page=1` — мусор.
 *
 * @param {string} locale
 * @param {object} filters
 * @returns {string}
 */
export function href(locale, filters) {
  const params = new URLSearchParams();
  if (filters.genres?.length) params.set('genre', filters.genres.join(','));
  if (filters.yearFrom) {
    params.set('year', filters.yearTo ? `${filters.yearFrom}-${filters.yearTo}` : String(filters.yearFrom));
  }
  if (filters.ratingFrom) params.set('rating', String(filters.ratingFrom));
  if (filters.states?.length) params.set('state', filters.states.join(','));
  if (filters.countries?.length) params.set('country', filters.countries.join(','));
  if (filters.networks?.length) params.set('network', filters.networks.join(','));
  if (filters.networkSearch) params.set('network_q', filters.networkSearch);
  if (filters.sort && filters.sort !== 'popular') params.set('sort', filters.sort);
  if (filters.page && filters.page > 1) params.set('page', String(filters.page));

  const query = params.toString();
  return `/${locale}/series${query ? `?${query}` : ''}`;
}

const STATE_KEY = {
  airing: 'series.state.airing',
  waiting: 'series.state.waiting',
  announced: 'series.state.announced',
  ended: 'series.state.ended',
  cancelled: 'series.state.cancelled',
};

/** Рейтинг в записи локали: 9.1 → «9,1» / «9.1». */
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

/** Подсказка «убрать последний фильтр»: показываем самый узкий из включённых. */
function dropHint({ locale, filters }) {
  const hints = [];
  if (filters.ratingFrom) hints.push({ key: 'catalog.empty.dropRating', value: `rating=${filters.ratingFrom}` });
  if (filters.yearFrom) hints.push({ key: 'catalog.empty.dropYear', value: filters.yearTo ? `year=${filters.yearFrom}-${filters.yearTo}` : `year=${filters.yearFrom}` });
  if (filters.states.length) hints.push({ key: 'catalog.empty.dropState', value: `state=${filters.states.join(',')}` });
  if (filters.networks.length) hints.push({ key: 'catalog.empty.dropNetwork', value: `network=${filters.networks.join(',')}` });
  if (filters.countries.length) hints.push({ key: 'catalog.empty.dropCountry', value: `country=${filters.countries.join(',')}` });
  if (filters.genres.length) hints.push({ key: 'catalog.empty.dropGenre', value: `genre=${filters.genres.join(',')}` });
  return hints.length ? hints[0] : null;
}

/**
 * @param {object} page
 * @param {string} page.locale
 * @param {object} page.page выдача источника данных
 * @param {object} page.bounds границы фильтров из каталога
 * @param {object} page.filters разобранный адрес
 * @param {string[]} page.sorts
 * @param {string[]} page.states
 */
export function catalogueView({ locale, page, bounds, filters, sorts, states }) {
  const withFilters = Boolean(
    filters.genres.length || filters.yearFrom || filters.ratingFrom || filters.states.length
    || filters.countries.length || filters.networks.length,
  );

  return html`
<h1 class="catalog__title">${t(locale, 'catalog.title')}</h1>

<div class="catalog">
  <form class="filters" method="get" action="/${locale}/series" data-filters>
    <h2 class="filters__title">${t(locale, 'catalog.filters.title')}</h2>

    <fieldset class="filters__group">
      <legend class="filters__legend">${t(locale, 'catalog.filters.genres')}</legend>
      ${bounds.genres.map((genre) => html`
      <label class="filters__check">
        <input type="checkbox" name="genre" value="${genre.code}"
               ${when(filters.genres.includes(genre.code), () => 'checked')}>
        <span>${locale === 'en' ? genre.nameEn : genre.nameRu}</span>
        <span class="filters__count">${genre.count}</span>
      </label>`)}
    </fieldset>

    <fieldset class="filters__group">
      <legend class="filters__legend">${t(locale, 'catalog.filters.year')}</legend>
      <label class="filters__field">
        <span class="visually-hidden">${t(locale, 'catalog.filters.year')}</span>
        <!-- Диапазон одним полем, а не двумя ползунками: без скриптов два
             независимых поля дают «из 2015 по 2010», который молча
             превратился бы в пустую выдачу. Ползунки — улучшение поверх
             этого поля (F-02-03 §6). -->
        <input type="text" name="year" inputmode="numeric" autocomplete="off"
               value="${filters.yearFrom ? `${filters.yearFrom}${filters.yearTo ? `-${filters.yearTo}` : ''}` : ''}"
               placeholder="${bounds.yearMin}–${bounds.yearMax}">
      </label>
      <p class="filters__hint">${t(locale, 'catalog.filters.yearHint')}</p>
    </fieldset>

    <fieldset class="filters__group">
      <legend class="filters__legend">${t(locale, 'catalog.filters.rating')}</legend>
      <label class="filters__field">
        <span>${t(locale, 'catalog.filters.ratingFrom')}</span>
        <input type="number" name="rating" min="${bounds.ratingMin}" max="${bounds.ratingMax}" step="0.1"
               value="${filters.ratingFrom ?? ''}" placeholder="${bounds.ratingMin}">
      </label>
    </fieldset>

    <fieldset class="filters__group">
      <legend class="filters__legend">${t(locale, 'catalog.filters.country')}</legend>
      ${bounds.countries.map((country) => html`
      <label class="filters__check">
        <input type="checkbox" name="country" value="${country.code}"
               ${when(filters.countries.includes(country.code), () => 'checked')}>
        <span>${locale === 'en' ? country.nameEn : country.nameRu}</span>
        <span class="filters__count">${country.count}</span>
      </label>`)}
      ${when(bounds.countries.length === 0, () => html`<p class="filters__hint">${t(locale, 'catalog.filters.none')}</p>`)}
    </fieldset>

    <fieldset class="filters__group">
      <legend class="filters__legend">${t(locale, 'catalog.filters.network')}</legend>
      <!-- Поиск сужает список вариантов, а не выдачу, и работает без скриптов:
           это обычное поле той же формы (F-02-03 §3, «несколько, с поиском»). -->
      <label class="filters__field">
        <span class="visually-hidden">${t(locale, 'catalog.filters.networkSearch')}</span>
        <input type="search" name="network_q" value="${filters.networkSearch}"
               placeholder="${t(locale, 'catalog.filters.networkSearch')}" autocomplete="off">
      </label>
      ${bounds.networks.map((network) => html`
      <label class="filters__check">
        <input type="checkbox" name="network" value="${network.id}"
               ${when(filters.networks.includes(String(network.id)), () => 'checked')}>
        <span>${network.name}</span>
        <span class="filters__count">${network.count}</span>
      </label>`)}
      ${when(bounds.networks.length === 0, () => html`<p class="filters__hint">${t(locale, 'catalog.filters.none')}</p>`)}
    </fieldset>

    <fieldset class="filters__group">
      <legend class="filters__legend">${t(locale, 'catalog.filters.state')}</legend>
      ${states.map((key) => {
        const count = bounds.states.find((row) => row.key === key)?.count ?? 0;
        return html`
      <label class="filters__check">
        <input type="checkbox" name="state" value="${key}"
               ${when(filters.states.includes(key), () => 'checked')}
               ${when(count === 0, () => 'disabled')}>
        <span>${t(locale, STATE_KEY[key])}</span>
        <span class="filters__count">${count}</span>
      </label>`;
      })}
    </fieldset>

    <div class="filters__actions">
      <button class="button" type="submit">${t(locale, 'catalog.filters.apply')}</button>
      ${when(withFilters, () => html`<a class="filters__reset" href="/${locale}/series">${t(locale, 'catalog.filters.reset')}</a>`)}
    </div>
  </form>

  <section class="results" aria-labelledby="h-results">
    <div class="results__bar">
      <!-- Атрибут с числом результатов — факт страницы: по нему видно, сколько
           нашлось, не считая карточки глазами, и он же нужен проверке. -->
      <p class="results__count" data-total="${page.total}">${t(locale, 'catalog.results', { count: page.total })}</p>
      <nav class="sorts" aria-label="${t(locale, 'catalog.sort.label')}">
        ${sorts.map((key) => html`
        <a class="sorts__item" href="${href(locale, { ...filters, sort: key, page: 1 })}"
           ${when(page.sort === key, () => raw('aria-current="true"'))}>${t(locale, `catalog.sort.${key}`)}</a>`)}
      </nav>
    </div>

    ${when(page.items.length > 0, () => html`
    <ol class="posters" role="list">
      ${page.items.map((item) => {
        const poster = imageUrl(locale, item);
        return html`
      <li class="posters__item">
        <a class="poster" href="/${locale}/series/${item.slug}">
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

    ${when(page.items.length === 0, () => emptyView({ locale, filters }))}

    ${when(page.pages > 1, () => pagination({ locale, page, filters }))}
  </section>
</div>`;
}

/** Пустое состояние: причина, кнопка «Сбросить» и подсказка (EC-K5). */
function emptyView({ locale, filters }) {
  const hint = dropHint({ locale, filters });
  return html`
<div class="empty-state">
  <p class="empty-state__title">${t(locale, 'catalog.empty.title')}</p>
  <p class="empty-state__text">${t(locale, 'catalog.empty.text')}</p>
  ${when(hint, () => html`<p class="empty-state__hint">${t(locale, hint.key, { value: hint.value })}</p>`)}
  <p><a class="button" href="/${locale}/series">${t(locale, 'catalog.filters.reset')}</a></p>
</div>`;
}

/**
 * Постраничность настоящими ссылками (R-SEO-09): без них страницу не видно
 * поисковику и нельзя переслать.
 *
 * Показывается окно вокруг текущей страницы плюс первая и последняя: человек
 * приходит за второй страницей из выдачи, а не за «всеми 48».
 */
function pagination({ locale, page, filters }) {
  const last = page.pages;
  const current = page.page;
  const from = Math.max(1, Math.min(current - 2, last - 4));
  const to = Math.min(last, Math.max(current + 2, 5));
  const numbers = [];
  for (let page1 = from; page1 <= to; page1 += 1) numbers.push(page1);

  return html`
<nav class="pagination" aria-label="${t(locale, 'catalog.pagination.label')}">
  ${when(current > 1, () => html`
  <a class="pagination__step" href="${href(locale, { ...filters, page: current - 1 })}"
     rel="prev">${t(locale, 'catalog.pagination.prev')}</a>`)}

  ${when(from > 1, () => html`<span class="pagination__gap" aria-hidden="true">…</span>`)}
  ${numbers.map((number) => html`
  <a class="pagination__item" href="${href(locale, { ...filters, page: number })}"
     ${when(number === current, () => raw('aria-current="page"'))}>${number}</a>`)}
  ${when(to < last, () => html`<span class="pagination__gap" aria-hidden="true">…</span>`)}

  ${when(current < last, () => html`
  <a class="pagination__step" href="${href(locale, { ...filters, page: current + 1 })}"
     rel="next">${t(locale, 'catalog.pagination.next')}</a>`)}
</nav>`;
}