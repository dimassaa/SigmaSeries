// Служебные страницы: «О проекте и данных», правила сообщества и
// «Конфиденциальность и cookies» (F-00-05, S-40…S-42).
//
// Страницы статические: ни базы, ни персонализации (F-00-05 §9). Индексируются
// все три (в отличие от служебных разделов админки).

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { layout, pageTitle } from '../view/layout.js';
import { aboutView, rulesView, privacyView } from '../view/pages.js';

/** Таблицы стилей экрана: общая плюс его собственная. */
const STYLES = ['base', 'admin'];

/**
 * Маршруты служебных страниц.
 *
 * @param {object} deps
 * @param {object|null} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createPageRoutes({ sessionMw = null } = {}) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  const pages = [
    { path: '/about', view: aboutView, key: 'page.about.title' },
    { path: '/rules', view: rulesView, key: 'page.rules.title' },
    { path: '/privacy', view: privacyView, key: 'page.privacy.title' },
  ];

  for (const page of pages) {
    router.get(`/:locale${page.path}`, (req, res, next) => {
      const { locale } = req.params;
      if (!isLocale(locale)) return next('route');
      return res.status(200).type('html').send(layout({
        styles: STYLES,
        account: req.account,
        locale,
        path: page.path,
        title: pageTitle(locale, t(locale, page.key)),
        description: t(locale, page.key),
        body: page.view({ locale, account: req.account }),
      }).__raw);
    });
  }

  return router;
}
