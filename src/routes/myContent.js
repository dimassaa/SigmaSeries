// «Мои материалы» (F-05-09, S-35).
//
// Экран показывает автору состояния его материалов: что опубликовано, что на
// проверке, что запрещено и почему. Текст материала не показывается —
// список про состояния.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { layout, pageTitle } from '../view/layout.js';
import { myContentView } from '../view/myContent.js';
import { safeReturnTo } from '../services/auth/login.js';

const BASE = '/my/content';

/** Таблицы стилей экрана: общая плюс его собственная. */
const STYLES = ['base', 'my'];

/**
 * Маршруты «Моих материалов».
 *
 * @param {object} deps
 * @param {object} deps.materials сервис материалов пользователя
 * @param {object|null} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createMyContentRoutes({ materials, sessionMw = null }) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  // Материалы видит только вошедший: список чужого человека — внутреннее
  // дело модерации, а не публичная страница.
  const viewerOnly = (req, res, next) => {
    if (!req.session?.user) return next('router');
    return next();
  };

  router.get(`/:locale${BASE}`, viewerOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    try {
      const list = await materials.own({
        userId: req.session.user.id,
        kind: String(req.query.kind ?? '') || null,
        state: String(req.query.state ?? '') || null,
        page: Number(req.query.page) || 1,
      });

      return res.status(200).type('html').send(rawHtml(layout({
        account: req.account,
        locale,
        path: BASE,
        title: pageTitle(locale, t(locale, 'my.content.title')),
        description: t(locale, 'my.content.description'),
        noindex: true,
        styles: STYLES,
        body: myContentView({
          locale,
          list,
          csrf: csrfToken(req.session),
        }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  router.post(`/:locale${BASE}/:id/delete`, viewerOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(404).type('text/plain; charset=utf-8')
        .send(t(locale, 'my.content.missing'));
    }

    try {
      if (!csrfValid(req.session, req.body?.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'my.content.csrf'));
      }
      const removed = await materials.remove({ materialId: id, userId: req.session.user.id });
      if (!removed) {
        return res.status(404).type('text/plain; charset=utf-8')
          .send(t(locale, 'my.content.missing'));
      }
      const back = req.body?.back ? safeReturnTo(req.body.back) : `/${locale}${BASE}`;
      return res.status(303).set('Location', back).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/** Ответ отправляется разобранной строкой: `send()` объекта ушёл бы в JSON. */
const rawHtml = (page) => page.__raw;
