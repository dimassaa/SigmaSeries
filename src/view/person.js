// S-15 — персона.
// Спецификация: docs/01-product/features/M2-catalog.md, F-02-09.
//
// Фото нет: источник IMDb `name.basics` его не даёт, поэтому вместо картинки
// плашка с инициалами. Роли показываются все: человек нередко играет и
// режиссирует в одном каталоге, и одна строка «Актёр» была бы половиной правды.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/** `e_series_person.role` → ключ интерфейса. */
const ROLE_KEY = {
  actor: 'person.role.actor',
  director: 'person.role.director',
  creator: 'person.role.creator',
};

/**
 * @param {object} page
 * @param {string} page.locale
 * @param {object} page.person данные источника
 */
export function personView({ locale, person }) {
  const roles = person.roles.map((role) => t(locale, ROLE_KEY[role] ?? 'person.role.actor'));

  return html`
<article class="person">
  <header class="person__header">
    <span class="person__plate" aria-hidden="true">${person.initials}</span>
    <div class="person__intro">
      <h1 class="person__name">${person.name}</h1>
      <p class="person__roles">${roles.join(' · ')}</p>
    </div>
  </header>

  <h2 class="person__section-title">${t(locale, 'person.series', { count: person.total })}</h2>

  <ol class="posters" role="list">
    ${person.series.map((item) => html`
    <li class="posters__item">
      <a class="poster" href="/${locale}/series/${item.slug}">
        <span class="poster__frame">
          ${when(item.posterWidth, () => html`<img class="poster__img"
             src="/${locale}/images/${item.slug}/poster-${item.posterWidth}.webp"
             alt="" width="185" height="278" loading="lazy" decoding="async">`)}
          ${when(!item.posterWidth, () => html`<span class="poster__fallback" aria-hidden="true"></span>`)}
        </span>
        <span class="poster__title">${item.title}</span>
        <span class="poster__meta">${meta({ locale, item })}</span>
      </a>
    </li>`)}
  </ol>

  ${when(person.pages > 1, () => html`
  <nav class="pagination" aria-label="${t(locale, 'catalog.pagination.label')}">
    ${when(person.page > 1, () => html`
    <a class="pagination__step" rel="prev"
       href="/${locale}/people/${person.slug}?page=${person.page - 1}">${t(locale, 'catalog.pagination.prev')}</a>`)}
    <span class="pagination__item" aria-current="page">${person.page}</span>
    ${when(person.page < person.pages, () => html`
    <a class="pagination__step" rel="next"
       href="/${locale}/people/${person.slug}?page=${person.page + 1}">${t(locale, 'catalog.pagination.next')}</a>`)}
  </nav>`)}
</article>`;
}

/** Подпись под постером: год и роль, в которой человек там снимался. */
function meta({ locale, item }) {
  const parts = [
    item.year ? String(item.year) : '',
    t(locale, ROLE_KEY[item.role] ?? 'person.role.actor'),
  ].filter(Boolean);
  return parts.join(' · ');
}