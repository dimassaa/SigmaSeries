// Страница отзыва (F-04-09, S-10).
//
// Маршрут тонкий: разбор адреса, выбор локали, чтение отзыва, отдача вида.
// Правила видимости и права — в сервисе отзывов, разметка — в
// `src/view/reviewPage.js`.
//
// Голос «Полезно» и жалоба на этой странице отправляются теми же
// адресами, что и в списке (серия знает свой адрес): отдельные адреса
// действий завели бы второе место, где правила прав живут.

import express from 'express';

import { layout, pageTitle } from '../view/layout.js';
import { notFound } from './home.js';
import { goneView } from '../view/series.js';
import { reviewPageView } from '../view/reviewPage.js';
import { reportStateFor, voteStateFor } from './review-actions.js';
import { t, isLocale } from '../i18n/strings.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { timezoneOf } from '../services/timezone.js';
// Таблицы стилей этой страницы: общая плюс нужные группам. Список
// берётся из `src/config/styles.js`, порядок подключения — оттуда же.
const STYLES = ['reviews'];


/** Ответ отправляется разобранной строкой: `send()` объекта ушёл бы в JSON. */
const rawHtml = (page) => page.__raw;

/**
 * Маршруты страницы отзыва.
 *
 * @param {object} deps
 * @param {object|null} [deps.reviewList] источник отзывов
 * @param {object|null} [deps.votes] сервис голосов «Полезно»
 * @param {object|null} [deps.reports] сервис жалоб
 * @param {object|null} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createReviewRoutes({
  reviewList = null,
  votes = null,
  reports = null,
  discussions = null,
  dictionary = null,
  sessionMw = null,
}) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  // Ответ на отзыв: комментарий под чужим мнением (F-05-07, S-10).
  if (discussions) {
    router.post('/:locale/reviews/:id/comments', async (req, res, next) => {
      const { locale } = req.params;
      if (!isLocale(locale)) return next('route');

      const id = Number(req.params.id);
      const body = req.body ?? {};
      try {
        if (!csrfValid(req.session, body.csrf)) {
          return res.status(403).type('text/plain; charset=utf-8')
            .send(t(locale, 'admin.users.csrf'));
        }
        const user = req.session?.user ?? null;
        if (!user) {
          return res.status(403).type('text/plain; charset=utf-8')
            .send(t(locale, 'discussions.signIn'));
        }
        const result = await discussions.addComment({
          userId: user.id,
          reviewId: id,
          body: body.body,
          spoiler: body.spoiler === '1' || body.spoiler === 'on',
          dictionary: dictionary ? await dictionary.load() : { block: [], allow: [], available: false },
        });
        if (!result.ok) {
          return res.status(400).type('text/plain; charset=utf-8')
            .send(t(locale, `discussions.error.${result.reason}`));
        }
        return res.status(303).set('Location', `/${locale}/reviews/${id}`).end();
      } catch (error) {
        return next(error);
      }
    });
  }

  if (reviewList) {
    router.get('/:locale/reviews/:id', async (req, res, next) => {
      const { locale } = req.params;
      if (!isLocale(locale)) return next('route');

      try {
        const found = await reviewList.one({ id: req.params.id });
        if (!found.ok) {
          // Нет отзыва, отзыв не опубликован или автор под баном — все три
          // случая выглядят снаружи одинаково (F-04-09 §5): отличить их
          // человеку нечего, а отличать было бы утечкой о внутреннем
          // состоянии материала.
          return res.status(404).type('html').send(notFound(locale, req.account).__raw);
        }

        // Снятый с публикации сериал — 410, а не 404: отзыв был, и человек
        // должен знать, что случилось (EC-V14, как на странице сериала).
        if (found.series.archived) {
          return res.status(410).type('html').send(rawHtml(layout({
            styles: STYLES,
            account: req.account,
            locale,
            path: `/reviews/${found.review.id}`,
            title: t(locale, 'series.gone.title'),
            description: t(locale, 'series.gone.text'),
            noindex: true,
            body: goneView({ locale, slug: found.series.slug }),
          })));
        }

        const session = req.session ?? null;
        const user = session?.user ?? null;
        const back = `/${locale}/reviews/${found.review.id}`;
        const voteState = await voteStateFor({
          votes,
          user,
          session,
          items: [found.review],
          locale,
          slug: found.series.slug,
          back,
        });
        const reportState = reports
          ? reportStateFor({ req, locale, slug: found.series.slug, back, user, session })
          : null;

        // Комментарии к отзыву: ответы под чужим мнением (F-05-07, S-10).
        const comments = discussions
          ? await discussions.comments(found.review.id)
          : [];

        return res.status(200).type('html').send(rawHtml(layout({
          styles: STYLES,
          account: req.account,
          locale,
          path: `/reviews/${found.review.id}`,
          title: pageTitle(locale, t(locale, 'review.page.title', { title: found.series.title })),
          description: t(locale, 'review.page.description', { title: found.series.title }),
          noindex: true,
          body: reviewPageView({
            locale,
            review: found.review,
            series: found.series,
            timezone: timezoneOf(req),
            vote: voteState?.get(found.review.id) ?? null,
            report: reportState,
            comments,
            user,
            csrf: csrfToken(req.session),
          }),
        })));
      } catch (error) {
        return next(error);
      }
    });
  }

  return router;
}
