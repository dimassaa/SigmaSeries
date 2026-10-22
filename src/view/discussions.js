// Обсуждения сериала: список тем (S-13) и тема с постами (S-14).
//
// Список тем — по сериалу; тема — плоский список постов с закреплённым
// сверху: закреплённый пост и есть ответ на вопрос «с чего начать читать».

import { html, when } from './render.js';
import { authorLink } from './profile.js';
import { t } from '../i18n/strings.js';
import { tPlural } from '../i18n/plural.js';

/**
 * Дата по-русски: 20.10.2026, с временем — 20.10.2026 19:41.
 *
 * @param {Date|string} value
 * @param {boolean} [withTime]
 * @returns {string}
 */
function dayOf(value, withTime = false) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = [
    String(date.getDate()).padStart(2, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    date.getFullYear(),
  ].join('.');
  if (!withTime) return parts;
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${parts} ${time}`;
}

/**
 * Список тем сериала.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.series
 * @param {object} args.topics
 * @param {number} args.page
 * @param {object|null} args.user
 * @param {string} args.csrf
 * @returns {object}
 */
export function discussionsListView({ locale, series, topics, page = 1, user = null, csrf = '' }) {
  return html`
<div class="discussions">
  <h1 class="discussions__title">${t(locale, 'discussions.title')}</h1>
  <p class="discussions__subtitle">${series.title ?? series.title_ru ?? ''}</p>

  ${when(user, () => html`
  <form class="discussions__form" method="post" action="/${locale}/series/${series.slug}/discussions">
    <input type="hidden" name="csrf" value="${csrf}">
    <label class="field__label" for="topic-title">${t(locale, 'discussions.newTitle')}</label>
    <input class="field__input" id="topic-title" name="title" type="text" maxlength="100" required>
    <label class="field__label" for="topic-body">${t(locale, 'discussions.newBody')}</label>
    <textarea class="field__input" id="topic-body" name="body" rows="5" required></textarea>
    <label class="discussions__spoiler">
      <input type="checkbox" name="spoiler" value="1">
      <span>${t(locale, 'discussions.spoiler')}</span>
    </label>
    <p class="discussions__actions">
      <button class="button button--primary" type="submit">${t(locale, 'discussions.create')}</button>
    </p>
  </form>`, () => html`
  <p class="discussions__signin">
    <a class="button" href="/${locale}/signin">${t(locale, 'discussions.signIn')}</a>
  </p>`)}

  ${when(topics.rows.length === 0, () => html`
  <p class="empty">${t(locale, 'discussions.empty')}</p>`)}

  ${when(topics.rows.length > 0, () => html`
  <ul class="discussions__list" role="list">
    ${topics.rows.map((topic) => html`
    <li class="discussions__item">
      <a class="discussions__link" href="/${locale}/discussions/${topic.id}">${topic.title}</a>
      <span class="discussions__meta">
        ${authorLink({ locale, nickname: topic.author, status: topic.authorStatus })} · ${tPlural(locale, 'discussions.posts', topic.posts, { count: topic.posts })} ·
        ${dayOf(topic.createdAt)}
      </span>
      ${when(topic.pinned, () => html`
      <span class="discussions__pinned">${t(locale, 'discussions.pinned')}</span>`)}
    </li>`)}
  </ul>`)}
</div>`;
}

/**
 * Тема с постами.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.topic
 * @param {object|null} args.user
 * @param {string} args.csrf
 * @returns {object}
 */
export function discussionTopicView({ locale, topic, user = null, csrf = '' }) {
  return html`
<div class="discussion">
  <h1 class="discussion__title">${topic.title}</h1>
  <p class="discussion__meta">
    ${authorLink({ locale, nickname: topic.author, status: topic.authorStatus })} · ${dayOf(topic.createdAt)} ·
    <a class="discussion__back" href="/${locale}/series/${topic.seriesSlug}/discussions">${t(locale, 'discussions.all')}</a>
  </p>

  <article class="discussion__post discussion__post--first">
    <p class="discussion__body">${topic.body}</p>
  </article>

  ${when(topic.posts.length === 0, () => html`
  <p class="empty">${t(locale, 'discussions.noPosts')}</p>`)}

  <ol class="discussion__posts" role="list">
    ${topic.posts.map((post) => html`
    <li class="discussion__post">
      ${when(post.pinned, () => html`
      <span class="discussion__pinned">${t(locale, 'discussions.pinnedByEditor')}</span>`)}
      <p class="discussion__body">${post.body}</p>
      <p class="discussion__meta">
        ${authorLink({ locale, nickname: post.author, status: post.authorStatus })} · ${dayOf(post.createdAt, true)}
        ${when(user && (user.roles ?? []).includes('admin'), () => html`
        <form class="discussion__pin" method="post" action="/${locale}/discussions/${topic.id}/pin">
          <input type="hidden" name="csrf" value="${csrf}">
          <input type="hidden" name="post_id" value="${post.id}">
          <button class="button button--quiet" type="submit">${t(locale, 'discussions.pin')}</button>
        </form>`)}
      </p>
    </li>`)}
  </ol>

  ${when(user, () => html`
  <form class="discussion__form" method="post" action="/${locale}/discussions/${topic.id}/reply">
    <input type="hidden" name="csrf" value="${csrf}">
    <label class="field__label" for="reply-body">${t(locale, 'discussions.reply')}</label>
    <textarea class="field__input" id="reply-body" name="body" rows="4" required></textarea>
    <label class="discussions__spoiler">
      <input type="checkbox" name="spoiler" value="1">
      <span>${t(locale, 'discussions.spoiler')}</span>
    </label>
    <p class="discussions__actions">
      <button class="button button--primary" type="submit">${t(locale, 'discussions.send')}</button>
    </p>
  </form>`, () => html`
  <p class="discussions__signin">
    <a class="button" href="/${locale}/signin">${t(locale, 'discussions.signIn')}</a>
  </p>`)}
</div>`;
}
