// Публичный профиль (S-18, F-01-07).
//
// Страница отвечает на вопрос «кто это написал»: ник, инициалы, дата
// регистрации и опубликованные работы. Статистика и список отмеченных
// сериалов видны, только если человек открыл их сам (F-01-07 §4): по
// умолчанию закрыто, и открытый профиль не должен превращаться в досье.
//
// Страница noindex — профиль личный, и в поиск он не годится (F-01-07 §8).
// Ссылок на удалённый аккаунт здесь нет: вместо профиля показывается текст
// «Пользователь удалён» (EC-A22).

import { html, when, raw } from './render.js';
import { t } from '../i18n/strings.js';
import { tPlural } from '../i18n/plural.js';
import { dayLabel, monthTitle } from './dates.js';
import { initialsOf } from './avatar.js';

/**
 * Ник автора: ссылка на профиль или текст, если аккаунт удалён.
 *
 * Удалённый аккаунт остаётся автором материала, но профиля у него нет: на
 * его месте показывается «Пользователь удалён», и ссылки на профиль нет
 * (EC-A22).
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {string} args.nickname
 * @param {string|null} [args.status] состояние аккаунта
 * @param {string} [args.className] класс обёртки
 * @returns {object} готовая разметка
 */
export function authorLink({ locale, nickname, status = null, className = '' }) {
  if (status === 'deleted') {
    const extra = className ? `${className} ` : '';
    return html`<span class="${extra}profile-author--deleted">${t(locale, 'profile.deleted')}</span>`;
  }
  return html`<a class="${className}" href="${profileHref(locale, nickname)}">${nickname}</a>`;
}

/**
 * Подпись статуса просмотра.
 *
 * В базе статус называется `on_hold`, а в каталоге строк — `status.onHold`:
 * имена в базе и в переводах живут по разным правилам, и мост между ними
 * нужен один раз, а не в каждом месте вывода.
 */
const STATUS_KEYS = {
  watching: 'status.watching',
  planned: 'status.planned',
  watched: 'status.watched',
  dropped: 'status.dropped',
  on_hold: 'status.onHold',
};

/**
 * Адрес профиля по нику.
 *
 * Ник может быть кириллическим, поэтому адрес собирается через
 * `encodeURIComponent`: иначе ссылка ведёт в никуда.
 *
 * @param {string} locale
 * @param {string} nickname
 * @returns {string}
 */
export function profileHref(locale, nickname) {
  return `/${locale}/u/${encodeURIComponent(String(nickname ?? ''))}`;
}

/**
 * Постраничная навигация списка.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {(page: number) => string} args.href адрес страницы
 * @param {number} args.page текущая страница
 * @param {number} args.pages всего страниц
 * @returns {object|null}
 */
function pager({ locale, href, page, pages }) {
  if (pages <= 1) return null;
  return html`
<nav class="profile__pager" aria-label="${t(locale, 'profile.pager.label')}">
  ${when(page > 1, () => html`
  <a class="profile__page" href="${href(page - 1)}" rel="prev">${t(locale, 'profile.pager.prev')}</a>`)}
  <span class="profile__page-now">${t(locale, 'profile.pager.now', { page, pages })}</span>
  ${when(page < pages, () => html`
  <a class="profile__page" href="${href(page + 1)}" rel="next">${t(locale, 'profile.pager.next')}</a>`)}
</nav>`;
}

/**
 * Публичный профиль пользователя.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {{id: number, nickname: string, status: string, registeredAt: string|number|Date,
 *   statsPublic: boolean, profilePublic: boolean}} args.user профиль
 * @param {{review: number, guide: number}} args.counts счётчики работ
 * @param {'reviews'|'guides'} args.tab открытая вкладка
 * @param {{items: object[], total: number, page: number, pages: number}} args.materials
 * @param {{marked: number, ratings: number, reviews: number}|null} [args.stats]
 * @param {{items: object[], total: number, page: number, pages: number}|null} [args.marked]
 * @param {number} [args.page] страница материалов
 * @param {number} [args.marksPage] страница отмеченных сериалов
 * @returns {object} готовая разметка
 */
export function profileView({
  locale,
  user,
  counts,
  tab,
  materials,
  stats = null,
  marked = null,
  page = 1,
  marksPage = 1,
}) {
  const deleted = user.status === 'deleted';
  const registered = new Date(user.registeredAt);
  const since = monthTitle(locale, registered.getUTCFullYear(), registered.getUTCMonth() + 1);
  const base = profileHref(locale, user.nickname);
  const reviewsHref = (number) => `${base}?tab=reviews${number > 1 ? `&page=${number}` : ''}`;
  const guidesHref = (number) => `${base}?tab=guides${number > 1 ? `&page=${number}` : ''}`;
  const marksHref = (number) => `${base}${tab === 'guides' ? '?tab=guides&' : '?'}marks=${number}`;

  return html`
<div class="profile">
  <header class="profile__head">
    <div class="avatar" aria-hidden="true">
      <span class="avatar__plate">${initialsOf(user.nickname)}</span>
    </div>
    <div class="profile__id">
      <h1 class="profile__nick" tabindex="-1">${user.nickname}</h1>
      <p class="profile__since">${t(locale, 'profile.since', { month: since })}</p>
    </div>
  </header>

  ${when(deleted, () => html`
  <p class="profile__deleted">${t(locale, 'profile.deleted')}</p>`)}

  ${when(!deleted, () => html`
  ${when(stats, () => html`
  <section class="profile__stats" aria-labelledby="profile-stats">
    <h2 class="profile__section" id="profile-stats">${t(locale, 'profile.stats.title')}</h2>
    <dl class="profile__stats-list">
      <div class="profile__stat">
        <dt>${t(locale, 'profile.stats.marked')}</dt>
        <dd>${stats.marked}</dd>
      </div>
      <div class="profile__stat">
        <dt>${t(locale, 'profile.stats.ratings')}</dt>
        <dd>${stats.ratings}</dd>
      </div>
      <div class="profile__stat">
        <dt>${t(locale, 'profile.stats.reviews')}</dt>
        <dd>${stats.reviews}</dd>
      </div>
    </dl>
  </section>`)}

  ${when(marked, () => html`
  <section class="profile__marked" aria-labelledby="profile-marked">
    <h2 class="profile__section" id="profile-marked">${t(locale, 'profile.marked.title')}</h2>
    ${when(marked.items.length === 0, () => html`
    <p class="profile__empty">${t(locale, 'profile.marked.empty')}</p>`, () => html`
    <ul class="profile__marked-list" role="list">
      ${marked.items.map((item) => html`
      <li class="profile__marked-item">
        <a class="profile__marked-link" href="/${locale}/series/${item.slug}">${item.title}</a>
        <span class="profile__marked-status">${t(locale, STATUS_KEYS[item.status] ?? 'status.watching')}</span>
      </li>`)}
    </ul>
    ${pager({ locale, href: marksHref, page: marksPage, pages: marked.pages })}`)}
  </section>`)}

  <nav class="profile__tabs" aria-label="${t(locale, 'profile.tabs.label')}">
    <a class="profile__tab${tab === 'reviews' ? ' profile__tab--current' : ''}"
      href="${reviewsHref(1)}"${raw(tab === 'reviews' ? ' aria-current="page"' : '')}
      >${t(locale, 'profile.tabs.reviews')} (${counts.review})</a>
    <a class="profile__tab${tab === 'guides' ? ' profile__tab--current' : ''}"
      href="${guidesHref(1)}"${raw(tab === 'guides' ? ' aria-current="page"' : '')}
      >${t(locale, 'profile.tabs.guides')} (${counts.guide})</a>
  </nav>

  ${when(materials.items.length === 0, () => html`
  <p class="profile__empty">${t(locale, 'profile.empty')}</p>`, () => html`
  <ul class="profile__items" role="list">
    ${materials.items.map((item) => html`
    <li class="profile__item">
      <p class="profile__item-meta">
        ${when(item.seriesTitle, () => html`
        <a class="profile__item-series" href="/${locale}/series/${item.seriesSlug}">${item.seriesTitle}</a> · `)}
        <time datetime="${new Date(item.createdAt).toISOString()}">${dayLabel(locale, item.createdAt)}</time>
      </p>
      ${when(tab === 'guides', () => html`
      <p class="profile__item-title">
        <a class="profile__item-link" href="/${locale}/guides/${item.slug}">${item.title}</a>
      </p>`)}
      <p class="profile__item-text">${item.excerpt}</p>
    </li>`)}
  </ul>`)}

  ${pager({
    locale,
    href: tab === 'guides' ? guidesHref : reviewsHref,
    page,
    pages: materials.pages,
  })}
  `)}
</div>`;
}
