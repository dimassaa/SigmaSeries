// Раздел администрирования: список пользователей и карточка человека
// (F-09-01, F-09-02, S-71, S-72).
//
// Раздел доступен администратору, и только администратору: он видит адреса
// и ограничения, а зрителю такое не показывают.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { csrfValid } from '../services/auth/session.js';
import { safeReturnTo } from '../services/auth/login.js';
import { MODERATION } from '../config/settings.js';
import { leavesNoAdmin } from '../services/admin/users.js';
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
export function createAdminUsersRoutes({
  users, auth = null, restrictions = null, audit = null, pool = null, sessionMw = null,
}) {
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

  // Действия карточки: роль и ограничение. Каждое — с обязательной
  // причиной (F-09-02 §8а), и каждое пишется в аудит с указанием, кто и
  // почему (F-09-02 §8г).
  router.post(`/:locale${BASE}/:id/role`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const id = Number(req.params.id);
    const body = req.body ?? {};
    const role = String(body.role ?? '');
    const reason = String(body.reason ?? '').trim();
    const action = String(body.action ?? 'grant');

    try {
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      if (!reason || reason.length > 500) {
        return res.status(400).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.reason'));
      }

      let result;
      if (action === 'revoke') {
        // Последнего администратора снять нельзя: иначе раздел останется без
        // того, кто может его открыть (F-09-02 §5).
        if (role === 'admin' && leavesNoAdmin(await users.admins(), id)) {
          return res.status(409).type('text/plain; charset=utf-8')
            .send(t(locale, 'admin.users.lastAdmin'));
        }
        result = await auth.revokeRole({ userId: id, role });
        result = { ok: true, removed: result.removed };
      } else {
        const days = Number(body.days);
        const expiresAt = role === 'admin'
          ? null
          : new Date(Date.now() + (Number.isFinite(days) && days > 0 ? days : 30) * 86_400_000);
        result = await auth.assignRole({
          userId: id, role, grantedBy: req.session.user.id, expiresAt, reason,
        });
      }

      if (!result.ok) {
        const key = {
          'unknown-role': 'admin.users.role',
          'no-reason': 'admin.users.reason',
          'no-expiry': 'admin.users.role',
          'not-admin': 'admin.users.notAdmin',
        }[result.reason] ?? 'admin.users.role';
        return res.status(400).type('text/plain; charset=utf-8').send(t(locale, key));
      }

      await audit.write({
        actorId: req.session.user.id,
        action: action === 'revoke' ? 'role_revoke' : 'role_grant',
        objectType: 'user',
        objectId: id,
        result: 'ok',
        reason,
        after: { role },
      });

      const back = body.back ? safeReturnTo(body.back) : `/${locale}${BASE}/${id}`;
      return res.status(303).set('Location', back).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post(`/:locale${BASE}/:id/restrict`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const id = Number(req.params.id);
    const body = req.body ?? {};
    const reason = String(body.reason ?? '').trim();
    const action = String(body.action ?? 'mute');
    const hours = Number(body.hours ?? MODERATION.muteMinHours);
    const hideMaterials = body.hide_materials === '1' || body.hide_materials === 'on';
    const isAdmin = (req.session?.user?.roles ?? []).includes('admin');

    try {
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      if (!reason || reason.length > 500) {
        return res.status(400).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.reason'));
      }
      // Человека нельзя ограничить на себя: администратор ушёл бы из-под
      // собственного решения (F-09-02 §5).
      if (id === req.session.user.id) {
        return res.status(409).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.self'));
      }
      // Бан выдаёт только администратор: редактор ограничивает поток, но не
      // отнимает доступ к сервису (F-05-08 §2).
      if (action === 'ban' && !isAdmin) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.banForbidden'));
      }

      let result;
      if (action === 'revoke') {
        result = await restrictions.revoke({ userId: id, byId: req.session.user.id, reason });
      } else if (action === 'ban') {
        result = await restrictions.ban({
          userId: id, reason, byId: req.session.user.id, hideMaterials,
        });
      } else {
        result = await restrictions.mute({
          userId: id, hours, reason, byId: req.session.user.id, isAdmin,
        });
      }

      if (!result.ok) {
        const key = {
          reason: 'admin.users.reason',
          hours: 'admin.users.hours',
          privileged: 'admin.users.privileged',
        }[result.reason] ?? 'admin.users.reason';
        return res.status(400).type('text/plain; charset=utf-8').send(t(locale, key));
      }

      const back = body.back ? safeReturnTo(body.back) : `/${locale}${BASE}/${id}`;
      return res.status(303).set('Location', back).end();
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
        body: adminUserView({ locale, user, csrf: req.session?.csrf ?? null }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/** Таблицы стилей экрана: общая плюс его собственная. */
const STYLES = ['base', 'admin'];
