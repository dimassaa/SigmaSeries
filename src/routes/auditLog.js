// Журнал аудита (F-09-03, S-81).
//
// Только чтение: журнал — свидетельство того, что делал администратор, и
// правка его записей противоречила бы смыслу (R-MOD-18: только добавление).

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { layout, pageTitle } from '../view/layout.js';
import { auditLogView } from '../view/auditLog.js';

const BASE = '/admin/audit';

/** Ответ отправляется разобранной строкой: `send()` объекта ушёл бы в JSON. */
const rawHtml = (page) => page.__raw;

/**
 * Маршруты журнала аудита.
 *
 * @param {object} deps
 * @param {any} deps.audit журнал действий
 * @param {any} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createAuditRoutes({ audit, sessionMw = null }) {
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
      const query = req.query;
      const list = await audit.list({
        action: String(query.action ?? '') || null,
        objectType: String(query.object_type ?? '') || null,
        objectId: Number(query.object_id) || null,
        from: String(query.from ?? '') || null,
        to: String(query.to ?? '') || null,
        page: Number(query.page) || 1,
      });

      return res.status(200).type('html').send(rawHtml(layout({
        account: req.account,
        locale,
        path: BASE,
        title: pageTitle(locale, t(locale, 'admin.audit.title')),
        description: t(locale, 'admin.audit.description'),
        noindex: true,
        styles: STYLES,
        body: auditLogView({ locale, list, query }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/** Таблицы стилей экрана: общая плюс его собственная. */
const STYLES = ['base', 'admin'];
