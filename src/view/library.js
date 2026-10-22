// S-30 — закладки.
// Спецификация: docs/01-product/features/M3-tracking.md, F-03-04.
//
// Состояние живёт в адресе (`?status=watching&sort=next`), и страница при этом
// `noindex`: это личный список, в выдаче ему не место, а по ссылке он
// открывается целиком.
//
// Вкладки — счётчики из всех статусов, а не из выборки: цифра, которая
// меняется при переключении вкладки, читается как ошибка (F-03-04 §8).
//
// Правая панель «Предстоящие» здесь отсутствует (H-30), и вкладки не
// превращаются в карусель: список читают целиком, по нему ставят статус.

import { html, when, raw } from './render.js';
import { t } from '../i18n/strings.js';
import { statusControl } from './status.js';
import { subscribeBell } from './subscribe.js';
import { fullDate, releaseLabel } from './dates.js';

const TABS = ['all', 'watching', 'planned', 'watched', 'dropped', 'on_hold'];

/**
 * @param {object} page
 * @param {string} page.locale
 * @param {any} page.library данные источника
 * @param {string} page.csrf
 * @param {Map<number, object>|null} [page.subs] состояние подписки по сериалам
 */
export function libraryView({ locale, library, csrf, subs = null }) {
  return html`
<h1 class="library__title">${t(locale, 'library.title')}</h1>

${tabs({ locale, library })}

<form class="library__controls" method="get" action="/${locale}/library">
  <label class="visually-hidden" for="library-q">${t(locale, 'library.search')}</label>
  <input class="library__search" id="library-q" type="search" name="q" value="${library.query}"
         placeholder="${t(locale, 'library.search')}">
  ${library.status ? html`<input type="hidden" name="status" value="${library.status}">` : ''}
  <label class="visually-hidden" for="library-sort">${t(locale, 'library.sort')}</label>
  <select class="library__sort" id="library-sort" name="sort">
    ${Object.keys(SORT_LABEL).map((key) => html`
    <option value="${key}" ${library.sort === key ? 'selected' : ''}>${t(locale, SORT_LABEL[key])}</option>`)}
  </select>
  ${viewToggle({ locale, view: library.view })}
  <button class="button" type="submit">${t(locale, 'library.apply')}</button>
</form>

${when(library.items.length === 0, () => emptyView({ locale, library }))}

${when(library.items.length > 0, () => html`
${library.view === 'list' ? html`
<ol class="library__rows" role="list">
  ${library.items.map((item) => denseRow({ locale, item, csrf, subs: subs?.get(item.seriesId) ?? null }))}
</ol>` : html`
<ol class="library__list" role="list">
  ${library.items.map((item) => card({ locale, item, csrf, subs: subs?.get(item.seriesId) ?? null }))}
</ol>`}

${when(library.pages > 1, () => pagination({ locale, library }))}`)}`;
}

/**
 * Вкладки статусов со счётчиками.
 *
 * «Все» считается сложением счётчиков, а не числом строк на странице: цифра
 * «3» на вкладке «Все» должна оставаться «3» и после того, как человек
 * открыл вкладку «Смотрю» (F-03-04 §8).
 */
function tabs({ locale, library }) {
  const count = (tab) => (tab === 'all'
    ? Object.values(library.counts).reduce((sum, value) => sum + value, 0)
    : library.counts[tab] ?? 0);

  return html`
<nav class="library__tabs" aria-label="${t(locale, 'library.tabs')}">
  ${TABS.map((tab) => html`
  <a class="library__tab${library.status === tab || (!library.status && tab === 'all') ? ' library__tab--on' : ''}"
     href="${tabHref(locale, library, tab)}"
     ${library.status === tab || (!library.status && tab === 'all') ? raw('aria-current="true"') : ''}>
    ${t(locale, `library.tab.${tab}`)} <span class="library__tab-count">${count(tab)}</span>
  </a>`)}
</nav>`;
}

function tabHref(locale, library, tab) {
  const params = new URLSearchParams();
  if (tab !== 'all') params.set('status', tab);
  if (library.sort !== 'recent') params.set('sort', library.sort);
  if (library.query) params.set('q', library.query);
  // Вид — часть состояния страницы: переключение не должно сбрасывать
  // вкладку, сортировку и поиск, иначе человек терял бы настроенное.
  if (library.view !== 'cards') params.set('view', library.view);
  const query = params.toString();
  return `/${locale}/library${query ? `?${query}` : ''}`;
}

/**
 * Переключатель вида: карточки или плотный список (F-03-04 §4).
 *
 * Две кнопки той же формы вместо ссылок со скриптом: выбор уезжает в адрес и
 * работает без JavaScript, а текущий вид помечен `aria-pressed`.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {'cards'|'list'} args.view
 * @returns {any}
 */
function viewToggle({ locale, view }) {
  const button = (value, icon, label) => html`
  <button class="library__view-button${view === value ? ' library__view-button--on' : ''}"
          type="submit" name="view" value="${value}"
          aria-pressed="${view === value ? 'true' : 'false'}" title="${t(locale, label)}">
    <span aria-hidden="true">${icon}</span>
    <span class="visually-hidden">${t(locale, label)}</span>
  </button>`;

  return html`
<div class="library__view" role="group" aria-label="${t(locale, 'library.view')}">
  ${button('cards', '▦', 'library.viewCards')}
  ${button('list', '☰', 'library.viewList')}
</div>`;
}

/**
 * Плотная строка закладки (#127, F-03-04 §4).
 *
 * Три части в строке: постер, название с прогрессом и датой, действия. Рядом
 * с постером закладка занимает одну строку, и человек, у которого их сотня,
 * видит больше за один экран. Название, статус и следующая дата стоят там же,
 * где у карточек, — переключение вида не переучивает человека.
 */
function denseRow({ locale, item, csrf, subs }) {
  return html`
<li class="library__row${item.archived ? ' library__row--archived' : ''}">
  <span class="library__row-poster" aria-hidden="true">
    ${when(item.posterWidth, () => html`
    <img class="library__row-poster-img" src="/${locale}/images/${item.slug}/poster-${item.posterWidth}.webp"
         alt="" width="48" height="72" loading="lazy" decoding="async">`)}
    ${when(!item.posterWidth, () => html`<span class="library__row-poster-fallback"></span>`)}
  </span>

  <div class="library__row-body">
    <h2 class="library__row-name">
      <a href="/${locale}/series/${item.slug}">${item.title}</a>
      ${when(item.year, () => html`<span class="library__year">${item.year}</span>`)}
    </h2>

    ${when(!item.archived && item.progress.total > 0, () => html`
    <div class="library__row-progress">${progressBlock({ locale, item })}</div>`)}

    ${when(item.nextReleaseDate && !item.archived, () => html`
    <p class="library__row-next">${t(locale, 'library.nextRelease', {
    date: fullDate(locale, item.nextReleaseDate),
  })}</p>`)}

    ${when(item.archived, () => html`
    <p class="library__archived">${t(locale, 'library.archived')}</p>`)}
  </div>

  <div class="library__row-actions">
    ${statusControl({ locale, slug: item.slug, status: item.status, signedIn: true, csrf, archived: item.archived, view: 'library' })}
    ${subscribeBell({ locale, slug: item.slug, state: subs, csrf, signedIn: true, archived: item.archived, view: 'library' })}
  </div>
</li>`;
}

/** Карточка закладки: постер, название, статус, прогресс, «Продолжить». */
function card({ locale, item, csrf, subs }) {
  return html`
<li class="library__item${item.archived ? ' library__item--archived' : ''}">
  <article class="library__card">
    <a class="library__poster" href="/${locale}/series/${item.slug}">
      ${when(item.posterWidth, () => html`
      <img class="library__poster-img" src="/${locale}/images/${item.slug}/poster-${item.posterWidth}.webp"
           alt="" width="185" height="278" loading="lazy" decoding="async">`)}
      ${when(!item.posterWidth, () => html`<span class="library__poster-fallback" aria-hidden="true"></span>`)}
    </a>

    <div class="library__body">
      <h2 class="library__name">
        <a href="/${locale}/series/${item.slug}">${item.title}</a>
        ${item.year ? html`<span class="library__year">${item.year}</span>` : ''}
      </h2>

      ${when(item.status === 'watched' && item.progress.total > item.progress.marked, () => html`
      <p class="library__badge">${t(locale, 'library.badgeNew')}</p>`)}

      ${when(item.archived, () => html`
      <p class="library__archived">${t(locale, 'library.archived')}</p>
      ${statusControl({ locale, slug: item.slug, status: item.status, signedIn: true, csrf, archived: true, view: 'library' })}
      ${subscribeBell({ locale, slug: item.slug, state: subs, csrf, signedIn: true, archived: true, view: 'library' })}`,
      () => html`
      ${statusControl({ locale, slug: item.slug, status: item.status, signedIn: true, csrf, view: 'library' })}
      ${subscribeBell({ locale, slug: item.slug, state: subs, csrf, signedIn: true, view: 'library' })}

      ${progressBlock({ locale, item })}

      ${when(item.nextReleaseDate, () => html`
      <p class="library__next">${t(locale, 'library.nextRelease', { date: fullDate(locale, item.nextReleaseDate) })}</p>`)}
      `)}
    </div>

  </article>
</li>`;
}

/**
 * Прогресс и «продолжить» в карточке (F-03-03).
 *
 * Показываются все пять состояний, а не только «сколько отмечено»: у человека
 * на руках сериал, у которого всё вышедшее отмечено, и для него главное —
 * «когда следующая», а не процент.
 */
function progressBlock({ locale, item }) {
  const { progress } = item;
  const { total, marked, percent } = progress;

  if (total === 0) {
    return html`<p class="library__progress-text">${t(locale, 'library.progressNoAired')}</p>`;
  }

  return html`
<div class="library__progress">
  <progress class="library__progress-bar" value="${percent}" max="100"
            aria-label="${t(locale, 'library.progress')}"></progress>
  <span class="library__progress-text">${t(locale, 'library.progressText', { marked, total })}</span>
  <span class="library__progress-percent">${percent}%</span>
</div>

${when(progress.nextEpisode !== null, () => html`
<p class="library__continue">
  <a href="/${locale}/series/${item.slug}/seasons/${progress.nextSeason}/episodes/${progress.nextEpisode}"
     >${t(locale, 'library.continue', { season: progress.nextSeason, episode: progress.nextEpisode })}</a>
  ${when(progress.nextEpisodeDate, () => html`
  <span class="library__next-date">${releaseLabel(locale, progress.nextEpisodeDate)}</span>`)}
</p>`)}

${when(progress.state === 'all-aired-watched' && item.nextReleaseDate, () => html`
<p class="library__next">${t(locale, 'library.awaiting', { date: fullDate(locale, item.nextReleaseDate) })}</p>`)}

${when(progress.skipped > 0, () => html`
<p class="library__skipped">${t(locale, 'library.skipped', { count: progress.skipped })}</p>`)}`;
}

const SORT_LABEL = {
  recent: 'library.sort.recent',
  title: 'library.sort.title',
  progress: 'library.sort.progress',
  next: 'library.sort.next',
  year: 'library.sort.year',
};

/** Пустое состояние: пустой список и фильтр без результата — разные вещи. */
function emptyView({ locale, library }) {
  if (library.status || library.query) {
    return html`
<p class="empty">${t(locale, 'library.emptyFiltered')}</p>
<p><a class="button" href="/${locale}/library">${t(locale, 'library.reset')}</a></p>`;
  }
  return html`
<p class="empty">${t(locale, 'library.empty')}</p>
<p><a class="button" href="/${locale}/series">${t(locale, 'library.toCatalogue')}</a></p>`;
}

function pagination({ locale, library }) {
  const href = (page) => {
    const params = new URLSearchParams();
    if (library.status) params.set('status', library.status);
    if (library.sort !== 'recent') params.set('sort', library.sort);
    if (library.query) params.set('q', library.query);
    if (library.view !== 'cards') params.set('view', library.view);
    if (page > 1) params.set('page', String(page));
    const query = params.toString();
    return `/${locale}/library${query ? `?${query}` : ''}`;
  };

  return html`
<nav class="pagination" aria-label="${t(locale, 'catalog.pagination.label')}">
  ${when(library.page > 1, () => html`
  <a class="pagination__step" rel="prev" href="${href(library.page - 1)}">${t(locale, 'catalog.pagination.prev')}</a>`)}
  <span class="pagination__item" aria-current="page">${library.page}</span>
  ${when(library.page < library.pages, () => html`
  <a class="pagination__step" rel="next" href="${href(library.page + 1)}">${t(locale, 'catalog.pagination.next')}</a>`)}
</nav>`;
}