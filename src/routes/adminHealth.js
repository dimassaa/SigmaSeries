// Здоровье системы (F-09-06, S-82).
//
// Экран только для администратора. Он ничего не решает и не меняет: данные
// собираются сервисом, а единственное действие — проверка восстановления
// копии, продублированная из S-83. Не-админ получает 404, как и на остальных
// служебных адресах: 403 выдавал бы существование маршрута.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { csrfToken } from '../services/auth/session.js';
import { layout, pageTitle } from '../view/layout.js';
import { adminHealthView } from '../view/adminHealth.js';

const BASE = '/admin/health';

/** Ответ отправляется разобранной строкой: `send()` объекта ушёл бы в JSON. */
const rawHtml = (page) => page.__raw;

/**
 * Маршруты здоровья системы.
 *
 * @param {object} deps
 * @param {any} deps.health источник снимка
 * @param {any} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createHealthRoutes({ health, sessionMw = null }) {
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
      const data = await health.screen();
      return res.status(200).type('html').send(rawHtml(layout({
        account: req.account,
        locale,
        path: BASE,
        title: pageTitle(locale, t(locale, 'admin.health.title')),
        description: t(locale, 'admin.health.description'),
        noindex: true,
        styles: STYLES,
        body: adminHealthView({ locale, data, csrf: csrfToken(req.session) }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/** Таблицы стилей экрана: общая плюс его собственная. */
const STYLES = ['base', 'admin'];
