// Страница отзыва (F-04-09, S-10).
//
// Страница отличается от карточки списка тремя вещами: текст целиком (в
// списке он обрезан), сверху шапка с сериалом (отзыв без сериала не
// отвечает на вопрос «о чём это») и `noindex` — страница отзыва не должна
// попадать в выдачу, она нужна по ссылке.
//
// Футер (голос «Полезно» и жалоба) и шапка отзыва (ник, оценка, дата, язык)
// — те же, что в списке: правила прав не зависят от того, где стоит отзыв.
//
// Комментарии-ответы (M5) здесь не рисуются: конвейера комментариев в
// проекте нет, создавать их некому, а пустой раздел обещал бы то, чего
// нет. Блок добавится вместе с M5 (см. IMPROVEMENTS.md).

import { html, when } from './render.js';
import { authorLink } from './profile.js';
import { t } from '../i18n/strings.js';
import { paragraphs } from './reviews.js';
import { reviewActions, reviewMeta, reportDialog } from './reviewList.js';

/**
 * Страница отзыва.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {any} args.review строка отзыва из `pgReviewList.one()`
 * @param {any} args.series сериал отзыва (`slug`, `title`)
 * @param {string|null} [args.timezone] пояс посетителя для подписи даты
 * @param {any} [args.vote] данные кнопки «Полезно»
 * @param {any} [args.report] состояние жалобы страницы
 * @returns {string}
 */
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

export function reviewPageView({
  locale, review, series, timezone = null, vote = null, report = null,
  comments = [], user = null, csrf = '',
}) {
  // Язык текста — свой: отзыв может быть на языке, отличном от языка
  // страницы, и тогда читающий экран должен читать его правильным голосом
  // (R-I18N-08).
  const text = html`${paragraphs(review.body).map((part) => html`<p>${part}</p>`)}`;

  return html`
<div class="review-page">
  <article class="review-page__card" data-review-id="${review.id}">
    <p class="review-page__kicker">${t(locale, 'review.page.label')}</p>
    <h1 class="review-page__title">
      <a class="review-page__series" href="/${locale}/series/${series.slug}">${series.title}</a>
    </h1>
    ${reviewMeta({ locale, item: review, timezone })}
    ${when(!review.spoiler, () => html`
    <div class="reviews__text review-page__text" lang="${review.lang}">${text}</div>`)}
    ${when(review.spoiler, () => html`
    <details class="reviews__spoiler">
      <summary class="reviews__spoiler-toggle">
        <span class="reviews__spoiler-show">${t(locale, 'review.spoiler.show')}</span>
        <span class="reviews__spoiler-hide">${t(locale, 'review.spoiler.hide')}</span>
      </summary>
      <div class="reviews__text review-page__text" lang="${review.lang}" data-nosnippet>${text}</div>
    </details>`)}
    ${reviewActions({ locale, item: review, vote, report })}
  </article>

  <section class="review-page__comments" aria-labelledby="h-review-comments">
    <h2 class="block__title" id="h-review-comments">${t(locale, 'review.page.comments')}</h2>
    ${when(comments.length === 0, () => html`
    <p class="empty">${t(locale, 'review.page.commentsEmpty')}</p>`)}
    ${when(comments.length > 0, () => html`
    <ul class="comment__list" role="list">
      ${comments.map((comment) => html`
      <li class="comment__item">
        <p class="discussion__body">${comment.body}</p>
        <p class="discussion__meta">${authorLink({ locale, nickname: comment.author, status: comment.authorStatus })} · ${dayOf(comment.createdAt)}</p>
      </li>`)}
    </ul>`)}
    ${when(user, () => html`
    <form class="discussion__form" method="post" action="/${locale}/reviews/${review.id}/comments">
      <input type="hidden" name="csrf" value="${csrf}">
      <label class="field__label" for="comment-body">${t(locale, 'review.page.commentLabel')}</label>
      <textarea class="field__input" id="comment-body" name="body" rows="3" required></textarea>
      <p class="discussions__actions">
        <button class="button button--primary" type="submit">${t(locale, 'review.page.commentSend')}</button>
      </p>
    </form>`)}
  </section>

  ${reportDialog({ locale, series, report })}
</div>`;
}
