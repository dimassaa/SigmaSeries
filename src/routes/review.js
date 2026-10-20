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
import { timezoneOf } from '../services/timezone.js';

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
  sessionMw = null,
}) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

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

        return res.status(200).type('html').send(rawHtml(layout({
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
          }),
        })));
      } catch (error) {
        return next(error);
      }
    });
  }

  return router;
}
