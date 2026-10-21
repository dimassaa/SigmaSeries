// Страница уведомлений (F-03-09, S-31).
//
// Текст уведомления не хранится, а собирается здесь из типа и параметров
// (R-I18N-14): язык читателя известен только в момент чтения, и сохранённая
// строка была бы написана на языке того, кто её создал. Даты приходят через
// `Intl`, как и на остальных экранах.

import { html, raw, when } from './render.js';
import { t } from '../i18n/strings.js';
import { fullDate } from './dates.js';

/** Значок типа. Текст рядом обязателен: значок не носитель смысла (R-A11Y-19). */
const ICON = {
  release_today: '🎞',
  release_changed: '📅',
  release_cancelled: '⛔',
  schedule_announced: '✨',
  moderation_result: '🛡',
  reply: '💬',
  import_failed: '⚙',
  import_key_rejected: '🔑',
  import_partial: '⚠️',
  mail_failed: '✉',
  collection_hidden: '🚫',
  spam_surge: '📈',
  spam_budget_hit: '🛑',
  queue_threshold: '⏳',
  rating_anomaly: '⭐',
  recap_ready: '🎞',
};

/**
 * Заголовок и текст уведомления.
 *
 * @param {string} locale язык читателя
 * @param {object} row запись ленты
 * @returns {{title: string, body: string}}
 */
export function notificationText(locale, row) {
  const params = row.params ?? {};

  if (params.digest) {
    return {
      title: t(locale, 'notify.release_today.digest.title'),
      body: t(locale, 'notify.release_today.digest.body', { count: params.digest.count }),
    };
  }

  const episodes = Array.isArray(params.episodes) ? params.episodes.join(', ') : '';
  const values = {
    series: params.seriesTitle ?? params.seriesSlug ?? '',
    season: params.season ?? '',
    episodes,
    date: params.date ? fullDate(locale, params.date) : '',
  };

  switch (row.kind) {
    case 'recap_ready':
      return {
        title: t(locale, 'notify.recap_ready.title'),
        body: t(locale, 'notify.recap_ready.body', { year: params.year ?? '' }),
      };
    case 'import_key_rejected':
      return {
        title: t(locale, 'notify.import_key_rejected.title'),
        body: t(locale, 'notify.import_key_rejected.body', {
          runId: params.runId ?? '',
        }),
      };
    case 'import_partial':
      return {
        title: t(locale, 'notify.import_partial.title'),
        body: t(locale, 'notify.import_partial.body', {
          runId: params.runId ?? '',
          done: params.done ?? 0,
          total: params.total ?? 0,
        }),
      };
    case 'rating_anomaly':
      return {
        title: t(locale, 'notify.rating_anomaly.title'),
        body: t(locale, 'notify.rating_anomaly.body', {
          series: params.seriesTitle ?? params.seriesSlug ?? '',
          count: params.countWindow ?? 0,
          share: params.extremeShare ?? 100,
        }),
      };
    case 'release_changed':
      return {
        title: t(locale, 'notify.release_changed.title'),
        body: t(locale, 'notify.release_changed.body', values),
      };
    case 'release_cancelled':
      return {
        title: t(locale, 'notify.release_cancelled.title'),
        body: t(locale, 'notify.release_cancelled.body', values),
      };
    case 'release_today':
    case 'schedule_announced':
    default:
      return {
        title: t(locale, 'notify.release_today.title'),
        body: t(locale, 'notify.release_today.body', values),
      };
  }
}

/**
 * Подпись дня: «Сегодня», «Вчера» или дата.
 *
 * @param {string} locale
 * @param {string} day `YYYY-MM-DD`
 * @param {string} today сегодня пояса читателя
 * @returns {string}
 */
function dayLabel(locale, day, today) {
  const diff = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000,
  );
  if (diff === 0) return t(locale, 'notifications.day.today');
  if (diff === 1) return t(locale, 'notifications.day.yesterday');
  return fullDate(locale, day);
}

/**
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.feed данные ленты
 * @param {string} args.csrf
 * @param {number} args.unread
 */
export function notificationsView({ locale, feed, csrf, unread }) {
  const { groups, total, page, pages, category, today } = feed;

  return html`
<h1 class="notifications__title">${t(locale, 'notifications.title')}</h1>

${unread > 0 ? html`
<form class="notifications__all" method="post" action="/${locale}/notifications">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="read-all">
  <button class="button button--quiet" type="submit">${t(locale, 'notifications.readAll')}</button>
</form>` : ''}

${when(total === 0, () => html`
<p class="empty">${t(locale, 'notifications.empty')}</p>`)}

${when(total > 0, () => html`
${categories({ locale, category })}

<ol class="notifications__feed" role="list">
  ${groups.map((group) => html`
  <li class="notifications__day">
    <h2 class="notifications__day-title" id="day-${group.day}">${dayLabel(locale, group.day, today)}</h2>
    <ul class="notifications__items" role="list" aria-labelledby="day-${group.day}">
      ${group.items.map((row) => item({ locale, row, csrf, feed }))}
    </ul>
  </li>`)}
</ol>

${pager({ locale, feed })}`)}

<p class="notifications__hint">${t(locale, 'notifications.hint')}</p>`;
}

/** Одна запись: значок, текст, время и действия. */
function item({ locale, row, csrf, feed }) {
  const { title, body } = notificationText(locale, row);
  const unread = row.read_at === null;

  return html`
<li class="notifications__item${unread ? ' notifications__item--unread' : ''}">
  <span class="notifications__icon" aria-hidden="true">${ICON[row.kind] ?? '•'}</span>
  <div class="notifications__body">
    <p class="notifications__item-title">
      ${title}${when(unread, () => html`<span class="visually-hidden">${t(locale, 'notifications.unread')}</span>`)}
    </p>
    <p class="notifications__item-text">${body}</p>
    <p class="notifications__item-meta">
      <time datetime="${row.created_at.toISOString()}">${timeOf(locale, row.created_at)}</time>
      ${when(!row.available && row.params?.seriesSlug, () => html`
      <span class="notifications__gone">${t(locale, 'notifications.gone')}</span>`)}
    </p>
  </div>
  <div class="notifications__actions">
    ${when(row.available && row.params?.seriesSlug, () => html`
    <a class="notifications__open" href="/${locale}${openHref(row)}">${t(locale, 'notifications.open')}</a>`)}
    <form method="post" action="/${locale}/notifications">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="id" value="${row.id}">
      <input type="hidden" name="page" value="${feed.page}">
      <input type="hidden" name="action" value="${unread ? 'read' : 'unread'}">
      <button class="button button--quiet" type="submit">${t(locale, unread ? 'notifications.markRead' : 'notifications.markUnread')}</button>
    </form>
    <form method="post" action="/${locale}/notifications">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="id" value="${row.id}">
      <input type="hidden" name="page" value="${feed.page}">
      <input type="hidden" name="name" value="remove">
      <button class="button button--quiet" type="submit">${t(locale, 'notifications.remove')}</button>
    </form>
  </div>
</li>`;
}

/** Куда ведёт «открыть»: одна серия — на неё, иначе на сериал. */
function openHref(row) {
  const params = row.params ?? {};
  const only = Array.isArray(params.episodes) && params.episodes.length === 1 ? params.episodes[0] : null;
  const season = Number.isInteger(params.season) ? params.season : 0;

  return only && season > 0
    ? `/series/${params.seriesSlug}/seasons/${season}/episodes/${only}`
    : `/series/${params.seriesSlug}`;
}

/** Время: «14:32» сегодня, дата — иначе. */
function timeOf(locale, when) {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(when);
}

/** Фильтр по категории — ссылками, без скрипта. */
function categories({ locale, category }) {
  const link = (key, label) => html`<a class="notifications__filter${key === (category ?? '') ? ' notifications__filter--on' : ''}"
    href="/${locale}/notifications${key ? `?category=${key}` : ''}"
    ${key === (category ?? '') ? raw('aria-current="true"') : ''}>${label}</a>`;

  return html`
<nav class="notifications__categories" aria-label="${t(locale, 'notifications.filter')}">
  ${link('', t(locale, 'notifications.filter.all'))}
  ${link('release', t(locale, 'notify.category.release'))}
  ${link('moderation', t(locale, 'notify.category.moderation'))}
  ${link('reply', t(locale, 'notify.category.reply'))}
</nav>`;
}

/** Постраничность: адресом, без скрипта. */
function pager({ locale, feed }) {
  if (feed.pages <= 1) return '';

  const href = (page) => `/${locale}/notifications?page=${page}`
    + (feed.category ? `&category=${feed.category}` : '');

  return html`
<nav class="pagination" aria-label="${t(locale, 'catalog.pagination.label')}">
  ${when(feed.page > 1, () => html`
  <a class="pagination__step" href="${href(feed.page - 1)}" rel="prev">${t(locale, 'catalog.pagination.prev')}</a>`)}
  <span class="pagination__item">${feed.page} / ${feed.pages}</span>
  ${when(feed.page < feed.pages, () => html`
  <a class="pagination__step" href="${href(feed.page + 1)}" rel="next">${t(locale, 'catalog.pagination.next')}</a>`)}
</nav>`;
}