// Слой подробной карточки постера (F-02-07, UI-10).
//
// Отдельный адрес отдаёт готовый фрагмент слоя: клиент только показывает его и
// убирает. Данные спрашиваются по намерению (R-PERF-11), кэш — на клиенте.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { posterCardView } from '../view/posterCard.js';

/**
 * Маршруты слоя карточки.
 *
 * @param {object} deps
 * @param {any} deps.card источник данных слоя
 * @param {any} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createPosterCardRoutes({ card, sessionMw = null }) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  router.get('/:locale/series/:slug/card', async (req, res, next) => {
    const { locale, slug } = req.params;
    if (!isLocale(locale)) return next('route');

    try {
      const data = await card.forSlug(slug);
      if (!data) {
        return res.status(404).type('text/plain; charset=utf-8')
          .send(t(locale, 'poster.card.notfound'));
      }
      // Нижняя панель для touch: в ней есть кнопка «Открыть» — постер на
      // touch-устройстве ведёт на страницу, но карточка показывается поверх.
      const panel = req.query.panel === '1';
      const body = posterCardView({ locale, data, open: panel });
      return res.status(200).type('html; charset=utf-8').send(body.__raw);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
