// Системный обзор (F-09-05, F-09-06, S-70).
//
// Вход администратора: сюда приходят, когда что-то пошло не так. Наверху —
// предупреждения, которые требуют решения (растущая очередь, открытые
// аномалии оценок), ниже — спокойные числа.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { layout, pageTitle } from '../view/layout.js';
import { adminOverviewView } from '../view/adminOverview.js';
import { csrfToken } from '../services/auth/session.js';

const BASE = '/admin';

/** Ответ отправляется разобранной строкой: `send()` объекта ушёл бы в JSON. */
const rawHtml = (page) => page.__raw;

/**
 * Маршруты системного обзора.
 *
 * @param {object} deps
 * @param {object} deps.overview источник данных обзора
 * @param {object|null} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createOverviewRoutes({ overview, sessionMw = null }) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  const adminOnly = (req, res, next) => {
    const roles = req.session?.user?.roles ?? [];
    if (!roles.includes('admin')) return next('router');
    return next();
  };

  router.get(`/:locale${BASE}`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    try {
      const data = await overview.overview();
      return res.status(200).type('html').send(rawHtml(layout({
        account: req.account,
        locale,
        path: BASE,
        title: pageTitle(locale, t(locale, 'admin.overview.title')),
        description: t(locale, 'admin.overview.description'),
        noindex: true,
        styles: STYLES,
        body: adminOverviewView({ locale, data, csrf: csrfToken(req.session) }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/** Таблицы стилей экрана: общая плюс его собственная. */
const STYLES = ['base', 'admin'];
