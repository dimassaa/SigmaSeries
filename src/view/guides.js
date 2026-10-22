// Руководства: список (S-11) и статья (S-12).
//
// Статья читается блоками: заголовок раздела и текст под ним. Спойлер-метка
// на разделе прячет этот раздел, но не всю статью (F-05-06 §8б).

import { html, when } from './render.js';
import { authorLink } from './profile.js';
import { t } from '../i18n/strings.js';

/**
 * Дата по-русски: 20.10.2026.
 *
 * @param {Date|string} value
 * @returns {string}
 */
function dayOf(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return [
    String(date.getDate()).padStart(2, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    date.getFullYear(),
  ].join('.');
}

/**
 * Список руководств.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.list
 * @param {object|null} [args.series] сериал, если список по сериалу
 * @param {object|null} [args.user]
 * @param {string} args.csrf
 * @returns {object}
 */
export function guidesListView({ locale, list = { rows: [], total: 0 }, series = null, user = null, csrf = '' }) {
  return html`
<div class="guides">
  <h1 class="guides__title">${series ? series.title : t(locale, 'guides.title')}</h1>
  <p class="guides__subtitle">${t(locale, 'guides.total', { count: list.total })}</p>

  ${when(user, () => html`
  <form class="guides__form" method="post" action="/${locale}/guides">
    <input type="hidden" name="csrf" value="${csrf}">
    <label class="field__label" for="guide-title">${t(locale, 'guides.newTitle')}</label>
    <input class="field__input" id="guide-title" name="title" type="text" maxlength="100" required>
    <label class="field__label" for="guide-series">${t(locale, 'guides.series')}</label>
    ${when(series, () => html`
    <input type="hidden" name="series_slug" value="${series.slug}">
    <p class="guides__note">${t(locale, 'guides.seriesOf', { title: series.title })}</p>`,
    () => html`
    <input class="field__input" id="guide-series" name="series_slug" type="text"
      placeholder="breaking-bad" required>`)}
    <label class="field__label" for="guide-text">${t(locale, 'guides.newText')}</label>
    <textarea class="field__input" id="guide-text" name="text" rows="12" required></textarea>
    <p class="guides__note">${t(locale, 'guides.newNote')}</p>
    <label class="guides__spoiler">
      <input type="checkbox" name="spoiler" value="1">
      <span>${t(locale, 'guides.spoiler')}</span>
    </label>
    <p class="guides__actions">
      <button class="button button--primary" type="submit">${t(locale, 'guides.submit')}</button>
    </p>
  </form>`, () => html`
  <p class="guides__signin">
    <a class="button" href="/${locale}/signin">${t(locale, 'guides.signIn')}</a>
  </p>`)}

  ${when(list.rows.length === 0, () => html`
  <p class="empty">${t(locale, 'guides.empty')}</p>`)}

  ${when(list.rows.length > 0, () => html`
  <ul class="guides__list" role="list">
    ${list.rows.map((guide) => html`
    <li class="guides__item">
      <a class="guides__link" href="/${locale}/guides/${guide.slug}">${guide.title}</a>
      <span class="guides__meta">
        ${authorLink({ locale, nickname: guide.author, status: guide.authorStatus })} · ${dayOf(guide.createdAt)}
        ${when(guide.seriesTitle, () => html` · ${guide.seriesTitle}`)}
      </span>
      ${when(guide.spoiler, () => html`
      <span class="discussion__pinned">${t(locale, 'guides.spoilerMark')}</span>`)}
    </li>`)}
  </ul>`)}
</div>`;
}

/**
 * Статья руководства.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.guide
 * @param {object|null} [args.user]
 * @returns {object}
 */
export function guideView({ locale, guide, user = null }) {
  return html`
<div class="guide">
  <h1 class="guide__title">${guide.title}</h1>
  <p class="guide__meta">
    ${authorLink({ locale, nickname: guide.author, status: guide.authorStatus })} · ${dayOf(guide.createdAt)}
    ${when(guide.seriesSlug, () => html`
    · <a class="guide__series" href="/${locale}/series/${guide.seriesSlug}">${guide.seriesTitle}</a>`)}
  </p>

  ${when(guide.spoiler, () => html`
  <details class="reviews__spoiler">
    <summary class="reviews__spoiler-toggle">
      <span class="reviews__spoiler-show">${t(locale, 'guides.spoilerShow')}</span>
      <span class="reviews__spoiler-hide">${t(locale, 'guides.spoilerHide')}</span>
    </summary>
    <div class="guide__body" data-nosnippet>${sectionsOf(guide, locale)}</div>
  </details>`, () => html`
  <div class="guide__body">${sectionsOf(guide, locale)}</div>`)}
</div>`;
}

/**
 * Разделы статьи в разметке.
 *
 * @param {object} guide
 * @param {string} locale
 * @returns {object}
 */
function sectionsOf(guide, locale) {
  const sections = guide.sections ?? [];
  if (!sections.length) {
    return html`<p class="guide__text">${guide.excerpt}</p>`;
  }
  return html`${sections.map((section) => html`
  <section class="guide__section">
    ${when(section.heading, () => html`<h2 class="guide__heading">${section.heading}</h2>`)}
    ${section.text.split('\n').filter((line) => line.trim()).map((line) => html`
    <p class="guide__text">${line}</p>`)}
  </section>`)}`;
}
