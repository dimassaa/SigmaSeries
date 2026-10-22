// Данные заставки для первого открытия (M0, F-00-06).
//
// Браузер спрашивает их один раз за визит и показывает оверлей поверх уже
// загруженной страницы: заставка не должна задерживать первую отрисовку.

import express from 'express';

import { isLocale } from '../i18n/strings.js';

/**
 * Маршрут данных заставки.
 *
 * @param {object} deps
 * @param {any} deps.splash источник кадров
 * @returns {import('express').Router}
 */
export function createPublicSplashRoutes({ splash }) {
  const router = express.Router({ strict: true });

  router.get('/:locale/splash/data', async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    try {
      const data = await splash.data();
      return res.status(200).json({
        frames: data.frames.map((frame) => ({
          id: frame.id,
          ordinal: frame.ordinal,
          width: frame.width,
          height: frame.height,
          focalX: frame.focalX,
          focalY: frame.focalY,
          seriesSlug: frame.seriesSlug,
          seriesTitle: frame.seriesTitle,
        })),
        counterFrom: data.counterFrom,
        counterTo: data.counterTo,
        maxDurationMs: data.maxDurationMs,
        fadeMs: data.fadeMs,
        enough: data.enough,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
