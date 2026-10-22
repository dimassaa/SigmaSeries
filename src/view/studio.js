// Студия: список сериалов (S-73) и очередь неполных карточек (S-74).
//
// Таблица плотная: админ смотрит много полей сразу, поэтому строка — одна
// строка таблицы, а не карточка. Фильтры сверху: меняются без перезагрузки
// адреса, но адрес остаётся верным — его можно передать другому.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';
import { tPlural } from '../i18n/plural.js';

/** Адрес списка студии: он же — основа ссылок на страницы. */
const BASE = '/admin/catalog';

/**
 * Ссылка с текущими фильтрами и одним изменённым параметром.
 *
 * @param {string} locale
 * @param {string} path
 * @param {any} filters
 * @param {any} changes
 * @returns {string}
 */
function linkWith(locale, path, filters, changes) {
  const params = new URLSearchParams();
  const all = { ...filters, ...changes };
  if (all.query) params.set('q', all.query);
  if (all.publication) params.set('publication', all.publication);
  if (all.exit) params.set('exit', all.exit);
  if (all.level) params.set('level', all.level);
  if (all.reasons && all.reasons.length) params.set('reason', all.reasons.join(','));
  if (all.genre) params.set('genre', all.genre);
  if (all.yearFrom) params.set('year_from', String(all.yearFrom));
  if (all.yearTo) params.set('year_to', String(all.yearTo));
  if (all.sort && all.sort !== 'popular') params.set('sort', all.sort);
  if (all.page && all.page > 1) params.set('page', String(all.page));
  const query = params.toString();
  return `/${locale}${path}${query ? `?${query}` : ''}`;
}

/**
 * Список сериалов.
 *
 * @param {object} args
 * @param {any} [args.csrf]
 * @param {any} [args.jobs]
 * @param {string} args.locale
 * @param {any} args.list
 * @param {any[]} args.genres
 * @param {any} args.filters
 * @returns {any}
 */
export function studioListView({
  locale, list, genres = [], filters = {}, jobs = [], csrf = '',
}) {
  return html`
<div class="studio">
  <h1 class="studio__title">${t(locale, 'studio.catalogue.title')}</h1>

  <form class="studio__filters" method="get" action="/${locale}/admin/catalog">
    <span class="studio__filter">
      <label class="field__label" for="studio-q">${t(locale, 'studio.filter.query')}</label>
      <input class="field__input" id="studio-q" name="q" type="search" value="${filters.query ?? ''}">
    </span>
    <span class="studio__filter">
      <label class="field__label" for="studio-publication">${t(locale, 'studio.filter.publication')}</label>
      <select class="field__input" id="studio-publication" name="publication">
        ${['', 'imported', 'published', 'archived'].map((value) => html`
        <option value="${value}" ${value === (filters.publication ?? '') ? 'selected' : ''}>
          ${value ? t(locale, `studio.publication.${value}`) : t(locale, 'studio.filter.any')}
        </option>`)}
      </select>
    </span>
    <span class="studio__filter">
      <label class="field__label" for="studio-exit">${t(locale, 'studio.filter.exit')}</label>
      <select class="field__input" id="studio-exit" name="exit">
        ${['', 'announced', 'airing', 'waiting', 'ended', 'cancelled'].map((value) => html`
        <option value="${value}" ${value === (filters.exit ?? '') ? 'selected' : ''}>
          ${value ? t(locale, `studio.exit.${value}`) : t(locale, 'studio.filter.any')}
        </option>`)}
      </select>
    </span>
    <span class="studio__filter">
      <label class="field__label" for="studio-level">${t(locale, 'studio.filter.level')}</label>
      <select class="field__input" id="studio-level" name="level">
        ${['', 'full', 'displayable', 'minimum'].map((value) => html`
        <option value="${value}" ${value === (filters.level ?? '') ? 'selected' : ''}>
          ${value ? t(locale, `studio.level.${value}`) : t(locale, 'studio.filter.any')}
        </option>`)}
      </select>
    </span>
    <span class="studio__filter">
      <label class="field__label" for="studio-genre">${t(locale, 'studio.filter.genre')}</label>
      <select class="field__input" id="studio-genre" name="genre">
        <option value="">${t(locale, 'studio.filter.any')}</option>
        ${genres.map((genre) => html`
        <option value="${genre.code}" ${genre.code === filters.genre ? 'selected' : ''}>${genre.title}</option>`)}
      </select>
    </span>
    <span class="studio__filter">
      <label class="field__label" for="studio-year-from">${t(locale, 'studio.filter.yearFrom')}</label>
      <input class="field__input" id="studio-year-from" name="year_from" type="number"
        min="1900" max="2200" value="${filters.yearFrom ?? ''}">
    </span>
    <span class="studio__filter">
      <label class="field__label" for="studio-year-to">${t(locale, 'studio.filter.yearTo')}</label>
      <input class="field__input" id="studio-year-to" name="year_to" type="number"
        min="1900" max="2200" value="${filters.yearTo ?? ''}">
    </span>
    <span class="studio__filter">
      <label class="studio-field__origin">
      <input type="checkbox" name="manual" value="1" ${filters.manual ? 'checked' : ''}>
      <span>${t(locale, 'studio.filter.manual')}</span>
    </label>

    <label class="field__label" for="studio-sort">${t(locale, 'studio.filter.sort')}</label>
      <select class="field__input" id="studio-sort" name="sort">
        ${['popular', 'updated', 'title'].map((value) => html`
        <option value="${value}" ${value === (filters.sort ?? 'popular') ? 'selected' : ''}>
          ${t(locale, `studio.sort.${value}`)}
        </option>`)}
      </select>
    </span>
    <span class="studio__filter studio__filter--actions">
      <button class="button button--primary" type="submit">${t(locale, 'studio.filter.apply')}</button>
      <a class="button" href="/${locale}/admin/catalog">${t(locale, 'studio.filter.reset')}</a>
    </span>
  </form>

  <p class="studio__summary">${tPlural(locale, 'studio.list.total', list.total, { count: list.total })}</p>

  ${when(jobs.length, () => html`
  <section class="studio__section">
    <h2 class="studio__section-title">${t(locale, 'studio.bulk.jobs')}</h2>
    <ul class="studio-history" role="list">
      ${jobs.map((job) => html`
      <li class="studio-history__item">
        <span class="studio-history__action">${t(locale, `studio.bulk.actions.${job.action}`)}</span>
        <span class="studio-history__reason">${job.done} / ${job.total}</span>
        <span class="studio-history__at">${t(locale, `studio.bulk.state.${job.state}`)}</span>
        ${when(job.failed, () => html`
        <span class="studio-history__reason">${t(locale, 'studio.bulk.failed', { count: job.failed })}</span>`)}
      </li>`)}
    </ul>
  </section>`)}

  ${when(list.rows.length === 0, () => html`
  <p class="empty">${t(locale, 'studio.list.empty')}</p>`)}

  <form class="studio-bulk" method="post" action="/${locale}/admin/catalog/bulk">
    <input type="hidden" name="csrf" value="${csrf}">
    <div class="studio-bulk__panel">
      <label class="field__label" for="bulk-action">${t(locale, 'studio.bulk.action')}</label>
      <select class="field__input" id="bulk-action" name="action">
        <option value="publish">${t(locale, 'studio.bulk.actions.publish')}</option>
        <option value="archive">${t(locale, 'studio.bulk.actions.archive')}</option>
        <option value="add_genre">${t(locale, 'studio.bulk.actions.add_genre')}</option>
        <option value="remove_genre">${t(locale, 'studio.bulk.actions.remove_genre')}</option>
      </select>
      <label class="field__label" for="bulk-genre">${t(locale, 'studio.bulk.genre')}</label>
      <input class="field__input" id="bulk-genre" name="genre" type="text" placeholder="drama">
      <button class="button button--primary" type="submit">${t(locale, 'studio.bulk.apply')}</button>
    </div>

  ${when(list.rows.length > 0, () => html`
  <table class="studio__table">
    <caption class="visually-hidden">${t(locale, 'studio.catalogue.title')}</caption>
    <thead>
      <tr>
        <th scope="col"><span class="visually-hidden">${t(locale, 'studio.bulk.check')}</span></th>
        <th scope="col">${t(locale, 'studio.column.title')}</th>
        <th scope="col">${t(locale, 'studio.column.publication')}</th>
        <th scope="col">${t(locale, 'studio.column.exit')}</th>
        <th scope="col">${t(locale, 'studio.column.level')}</th>
        <th scope="col">${t(locale, 'studio.column.reasons')}</th>
        <th scope="col">${t(locale, 'studio.column.placement')}</th>
        <th scope="col">${t(locale, 'studio.column.rating')}</th>
        <th scope="col">${t(locale, 'studio.column.updated')}</th>
      </tr>
    </thead>
    <tbody>
      ${list.rows.map((row) => html`
      <tr class="studio__row">
        <td class="studio__check">
          <input type="checkbox" name="ids" value="${row.id}"
            aria-label="${t(locale, 'studio.bulk.checkOne', { title: row.title })}">
        </td>
        <th scope="row" class="studio__title-cell">
          <a class="studio__title-link" href="/${locale}/admin/catalog/${row.id}">
            ${when(row.posterWidth, () => html`
            <img class="studio__poster" src="/${locale}/images/${row.slug}/poster-${row.posterWidth}.webp"
                 alt="" width="40" height="60" loading="lazy" decoding="async">`)}
            <span class="studio__name">${row.title}</span>
          </a>
          <span class="studio__original">${row.titleOriginal}</span>
          <span class="studio__year">${row.year}</span>
        </th>
        <td><span class="studio__state studio__state--${row.publicationState}">${t(locale, `studio.publication.${row.publicationState}`)}</span></td>
        <td><span class="studio__state studio__state--${row.exitState}">${t(locale, `studio.exit.${row.exitState}`)}</span></td>
        <td><span class="studio__level studio__level--${row.level}">${t(locale, `studio.level.${row.level}`)}</span></td>
        <td class="studio__reasons">
          ${row.reasons.map((reason) => html`
          <span class="studio__reason studio__reason--${reason.kind}" title="${reason.code}">${reason.code}</span>`)}
        </td>
        <td class="studio__places">
          ${when(row.canBanner, () => html`<span class="studio__place">${t(locale, 'studio.place.banner')}</span>`)}
          ${when(row.canBanner, () => html`<span class="studio__place">${t(locale, 'studio.place.splash')}</span>`)}
          ${when(row.canCalendar, () => html`<span class="studio__place">${t(locale, 'studio.place.calendar')}</span>`)}
          ${when(row.canFresh, () => html`<span class="studio__place">${t(locale, 'studio.place.fresh')}</span>`)}
        </td>
        <td class="studio__rating">
          ${when(row.imdb !== null, () => html`${String(row.imdb).replace('.', ',')}`)}
          ${when(row.imdbVotes !== null, () => html`<span class="studio__votes">${row.imdbVotes}</span>`)}
        </td>
        <td class="studio__updated">${formatDate(row.addedAt)}</td>
      </tr>`)}
    </tbody>
  </table>
  </form>

  ${pagination(locale, list, BASE, filters)}`)}
</div>`;
}

/**
 * Очередь неполных карточек.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {any} args.queue
 * @param {string} args.reason
 * @returns {any}
 */
export function studioQueueView({ locale, queue, reason = '' }) {
  const reasons = [
    'no_tmdb', 'pair_doubt', 'no_genre', 'no_poster', 'no_overview', 'no_overview_ru',
    'no_people', 'no_backdrop', 'schedule_gap', 'new_genre', 'no_age',
  ];
  return html`
<div class="studio">
  <h1 class="studio__title">${t(locale, 'studio.queue.title')}</h1>

  <nav class="studio__reasons-nav" aria-label="${t(locale, 'studio.queue.filterLabel')}">
    <a class="studio__reason-link${reason ? '' : ' is-current'}"
       href="/${locale}/admin/catalog/incomplete">${t(locale, 'studio.filter.any')}</a>
    ${reasons.map((code) => html`
    <a class="studio__reason-link${code === reason ? ' is-current' : ''}"
       href="/${locale}/admin/catalog/incomplete?reason=${code}"><code>${code}</code></a>`)}
  </nav>

  <p class="studio__summary">${tPlural(locale, 'studio.list.total', queue.total, { count: queue.total })}</p>

  ${when(queue.rows.length === 0, () => html`
  <p class="empty">${t(locale, 'studio.queue.empty')}</p>`)}

  ${when(queue.rows.length > 0, () => html`
  <table class="studio__table">
    <caption class="visually-hidden">${t(locale, 'studio.queue.title')}</caption>
    <thead>
      <tr>
        <th scope="col">${t(locale, 'studio.column.title')}</th>
        <th scope="col">${t(locale, 'studio.column.level')}</th>
        <th scope="col">${t(locale, 'studio.column.reasons')}</th>
        <th scope="col">${t(locale, 'studio.column.rating')}</th>
        <th scope="col">${t(locale, 'studio.column.updated')}</th>
      </tr>
    </thead>
    <tbody>
      ${queue.rows.map((row) => html`
      <tr class="studio__row">
        <th scope="row" class="studio__title-cell">
          <a class="studio__title-link" href="/${locale}/admin/catalog/${row.id}">
            <span class="studio__name">${row.title}</span>
          </a>
          <span class="studio__original">${row.titleOriginal}</span>
          <span class="studio__year">${row.year}</span>
        </th>
        <td><span class="studio__level studio__level--${row.level}">${t(locale, `studio.level.${row.level}`)}</span></td>
        <td class="studio__reasons">
          ${row.reasons.map((reasonItem) => html`
          <span class="studio__reason studio__reason--${reasonItem.kind}" title="${reasonItem.code}">${reasonItem.code}</span>`)}
        </td>
        <td class="studio__rating">
          ${when(row.imdb !== null, () => html`${String(row.imdb).replace('.', ',')}`)}
          ${when(row.imdbVotes !== null, () => html`<span class="studio__votes">${row.imdbVotes}</span>`)}
        </td>
        <td class="studio__updated">${formatDate(row.addedAt)}</td>
      </tr>`)}
    </tbody>
  </table>

  ${pagination(locale, queue, `${BASE}/incomplete`, { reason })}`)}
</div>`;
}

/**
 * Постраничная навигация.
 *
 * @param {string} locale
 * @param {any} list
 * @param {string} path
 * @param {any} filters
 * @returns {any}
 */
function pagination(locale, list, path, filters) {
  if (list.pages <= 1) return '';
  return html`
  <nav class="studio__pagination" aria-label="${t(locale, 'studio.pagination.label')}">
    ${when(list.page > 1, () => html`
    <a class="button" href="${linkWith(locale, path, filters, { page: list.page - 1 })}"
       rel="prev">${t(locale, 'studio.pagination.prev')}</a>`)}
    <span class="studio__page">${t(locale, 'studio.pagination.page', { page: list.page, pages: list.pages })}</span>
    ${when(list.page < list.pages, () => html`
    <a class="button" href="${linkWith(locale, path, filters, { page: list.page + 1 })}"
       rel="next">${t(locale, 'studio.pagination.next')}</a>`)}
  </nav>`;
}

/**
 * Дата в коротком виде.
 *
 * @param {Date|string|null} value
 * @returns {string}
 */
function formatDate(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 10);
}
