// Кадры заставки (S-79, F-10-09).
//
// Экран: лента кадров с номерами и предупреждения о резкой смене яркости.
// Справа — предпросмотр: заставка показывает кадры размытыми, и в предпросмотре
// видно то же, что увидит человек.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { layout, pageTitle } from '../view/layout.js';
import { splashView } from '../view/studioSplash.js';

/** Таблицы стилей экрана: общая плюс админская. */
const STYLES = ['base', 'admin'];

/**
 * Маршруты кадров заставки.
 *
 * @param {object} deps
 * @param {object} deps.splash источник данных кадров
 * @param {object|null} [deps.audit] журнал действий
 * @param {object|null} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createSplashRoutes({ splash, audit = null, sessionMw = null }) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  const adminOnly = (req, res, next) => {
    const roles = req.session?.user?.roles ?? [];
    if (!roles.includes('admin')) return next('router');
    return next();
  };

  router.get('/:locale/admin/splash', adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    try {
      const [state, candidates] = await Promise.all([
        splash.frames(),
        splash.candidates({ limit: 60 }),
      ]);
      return res.status(200).type('html').send(layout({
        account: req.account,
        locale,
        path: '/admin/splash',
        title: pageTitle(locale, t(locale, 'studio.splash.title')),
        description: t(locale, 'studio.splash.description'),
        noindex: true,
        styles: STYLES,
        body: splashView({
          locale,
          state,
          candidates,
          csrf: req.session ? csrfToken(req.session) : '',
        }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:locale/admin/splash', adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    const body = req.body ?? {};
    try {
      if (!req.session || !csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      const result = await splash.add({
        imageId: Number(body.image_id),
        seriesId: body.series_id ? Number(body.series_id) : null,
        byId: req.session.user.id,
      });
      if (!result.ok) {
        return res.status(400).type('text/plain; charset=utf-8')
          .send(t(locale, `studio.splash.error.${result.reason}`));
      }
      if (audit) {
        await audit.write({
          actorId: req.session.user.id,
          action: 'splash.add',
          objectType: 'splash_frame',
          objectId: null,
          result: 'ok',
          reason: `image=${body.image_id}`,
        });
      }
      return res.status(303).set('Location', `/${locale}/admin/splash`).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:locale/admin/splash/order', adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    const body = req.body ?? {};
    try {
      if (!req.session || !csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      const where = ['up', 'down', 'first', 'last', 'position'].includes(body.where)
        ? body.where
        : 'up';
      await splash.reorder({
        frameId: Number(body.frame_id),
        where,
        position: Number(body.position ?? 0),
      });
      return res.status(303).set('Location', `/${locale}/admin/splash`).end();
    } catch (error) {
      return next(error);
    }
  });

  // Точка кадрирования кадра (F-10-09 §4, F-10-04): своя у кадра, а не у
  // картинки — одна картинка может стоять в двух кадрах.
  router.post('/:locale/admin/splash/focal', adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    const body = req.body ?? {};
    try {
      if (!req.session || !csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      const done = await splash.setFocal({
        frameId: Number(body.frame_id),
        focalX: Number(body.focal_x),
        focalY: Number(body.focal_y),
      });
      if (!done) {
        return res.status(404).type('text/plain; charset=utf-8')
          .send(t(locale, 'studio.splash.frameMissing'));
      }
      if (audit) {
        await audit.write({
          actorId: req.session.user.id,
          action: 'splash.focal',
          objectType: 'splash_frame',
          objectId: Number(body.frame_id),
          result: 'ok',
          reason: `x=${body.focal_x}; y=${body.focal_y}`,
        });
      }
      return res.status(303).set('Location', `/${locale}/admin/splash`).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:locale/admin/splash/remove', adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    const body = req.body ?? {};
    try {
      if (!req.session || !csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      const removed = await splash.remove({
        frameId: Number(body.frame_id),
        byId: req.session.user.id,
      });
      if (audit) {
        await audit.write({
          actorId: req.session.user.id,
          action: 'splash.remove',
          objectType: 'splash_frame',
          objectId: null,
          result: removed ? 'ok' : 'denied',
          reason: `frame=${body.frame_id}`,
        });
      }
      return res.status(303).set('Location', `/${locale}/admin/splash`).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
