// Раздел администрирования: список пользователей и карточка человека
// (F-09-01, F-09-02, S-71, S-72).
//
// Раздел доступен администратору, и только администратору: он видит адреса
// и ограничения, а зрителю такое не показывают.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { layout, pageTitle } from '../view/layout.js';
import { adminUsersView, adminUserView } from '../view/adminUsers.js';
import { ADMIN } from '../config/settings.js';

const BASE = '/admin/users';

/** Ответ отправляется разобранной строкой: `send()` объекта ушёл бы в JSON. */
const rawHtml = (page) => page.__raw;

/**
 * Маршруты раздела пользователей.
 *
 * @param {object} deps
 * @param {object} deps.users сервис списка и карточки пользователей
 * @param {object|null} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createAdminUsersRoutes({ users, sessionMw = null }) {
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
      const list = await users.list({
        nickname: String(query.nickname ?? ''),
        email: String(query.email ?? ''),
        roles: [].concat(query.role ?? []).filter(Boolean),
        status: String(query.status ?? ''),
        registeredFrom: String(query.from ?? '') || null,
        registeredTo: String(query.to ?? '') || null,
        page: Number(query.page) || 1,
        pageSize: ADMIN.userPageSize,
      });

      return res.status(200).type('html').send(rawHtml(layout({
        account: req.account,
        locale,
        path: BASE,
        title: pageTitle(locale, t(locale, 'admin.users.title')),
        description: t(locale, 'admin.users.description'),
        noindex: true,
        styles: STYLES,
        body: adminUsersView({ locale, list, query }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  router.get(`/:locale${BASE}/:id`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(404).type('text/plain; charset=utf-8')
        .send(t(locale, 'admin.users.missing'));
    }

    try {
      const user = await users.one(id);
      if (!user) {
        return res.status(404).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.missing'));
      }
      return res.status(200).type('html').send(rawHtml(layout({
        account: req.account,
        locale,
        path: `${BASE}/${id}`,
        title: pageTitle(locale, t(locale, 'admin.user.title', { nickname: user.nickname })),
        description: t(locale, 'admin.user.description'),
        noindex: true,
        styles: STYLES,
        body: adminUserView({ locale, user }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/** Таблицы стилей экрана: общая плюс его собственная. */
const STYLES = ['base', 'admin'];
