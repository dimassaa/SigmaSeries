// «Не интересно» (M11, F-11-03).
//
// Одно нажатие, без подтверждения: причина не спрашивается и не хранится.
// Скрытие действует и на «для вас», и на «похожих» — список отклонений один.

import express from 'express';

import { t, isLocale } from '../i18n/strings.js';
import { csrfValid } from '../services/auth/session.js';
import { safeReturnTo } from '../services/auth/login.js';

/**
 * Маршруты рекомендаций.
 *
 * @param {object} deps
 * @param {object} deps.recommendations сервис рекомендаций
 * @param {object|null} [deps.sessionMw]
 * @returns {import('express').Router}
 */
export function createRecommendationRoutes({ recommendations, sessionMw = null }) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  router.post('/:locale/reco/dismiss', async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).type('text/plain; charset=utf-8').send(t(locale, 'reco.error.signin'));
    }

    const body = req.body ?? {};
    try {
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8').send(t(locale, 'mark.error.csrf'));
      }
      const slug = String(body.series ?? '').trim();
      if (!slug) {
        return res.status(400).type('text/plain; charset=utf-8').send(t(locale, 'reco.error.series'));
      }
      await recommendations.dismiss(userId, slug);

      // Возврат — только внутрь приложения (R-SEC-08): адрес из тела запроса
      // может быть чужим, и такой переход увел бы человека с сайта.
      const back = safeReturnTo(body.back) || `/${locale}/`;
      return res.redirect(303, back);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

