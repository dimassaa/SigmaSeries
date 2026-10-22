// Настройки системы (S-83, M9).
//
// Экран показывает пороги и параметры и позволяет их менять. Значение,
// показанное здесь, обязано действовать: поэтому сервисы читают их из базы, а
// константы в коде остаются запасным вариантом для ключа, которого нет.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { layout, pageTitle } from '../view/layout.js';
import { systemSettingsView } from '../view/systemSettings.js';
import { RAW, setSetting } from '../services/settings.js';

const BASE = '/admin/settings';

/** Ответ отправляется разобранной строкой: `send()` объекта ушёл бы в JSON. */
const rawHtml = (page) => page.__raw;

/**
 * Маршруты настроек системы.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {any} [deps.audit] журнал действий
 * @param {any} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createSystemSettingsRoutes({ pool, audit = null, sessionMw = null }) {
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
      return res.status(200).type('html').send(rawHtml(layout({
        account: req.account,
        locale,
        path: BASE,
        title: pageTitle(locale, t(locale, 'admin.settings.title')),
        description: t(locale, 'admin.settings.description'),
        noindex: true,
        styles: STYLES,
        body: systemSettingsView({ locale, values: RAW, csrf: csrfToken(req.session) }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  router.post(`/:locale${BASE}`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const body = req.body ?? {};
    const key = String(body.key ?? '');
    const value = String(body.value ?? '');

    try {
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.settings.csrf'));
      }
      const reason = String(body.reason ?? '').trim();
      if (!reason) {
        return res.status(400).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.settings.reason'));
      }
      const saved = await setSetting(pool, key, value, req.session.user.id);
      if (!saved) {
        return res.status(400).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.settings.unknown'));
      }
      if (audit) {
        await audit.write({
          actorId: req.session.user.id,
          action: 'setting.update',
          objectType: 'setting',
          // Идентификатор у настройки строковый, а журнал ждёт число; ключ
          // уходит в причину записи.
          objectId: null,
          result: 'ok',
          reason: `${key}=${value}; ${reason}`,
          after: { value },
        });
      }
      return res.status(303).set('Location', `/${locale}${BASE}`).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/** Таблицы стилей экрана: общая плюс его собственная. */
const STYLES = ['base', 'admin'];
