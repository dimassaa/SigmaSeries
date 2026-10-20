// Резервные копии: журнал, расписание и ручной запуск (F-09-04, S-82).
//
// Статус копии важнее её размера: «проверена» означает, что копию на самом
// деле восстановили во временную базу и она ответила (F-09-04 §8а). Ротация
// трогает только проверенные копии, и этот экран показывает, какие именно.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { csrfValid } from '../services/auth/session.js';
import { layout, pageTitle } from '../view/layout.js';
import { backupsView } from '../view/backups.js';

const BASE = '/admin/backups';

/** Ответ отправляется разобранной строкой: `send()` объекта ушёл бы в JSON. */
const rawHtml = (page) => page.__raw;

/**
 * Маршруты резервных копий.
 *
 * @param {object} deps
 * @param {object} deps.backups журнал копий
 * @param {Function} [deps.readSchedule] чтение расписания
 * @param {Function} [deps.runBackup] ручной запуск копии
 * @param {object|null} [deps.audit] журнал действий
 * @param {object|null} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createBackupRoutes({
  backups, readSchedule = null, runBackup = null, audit = null, sessionMw = null,
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
      const copies = await backups.recent({ limit: 20 });
      const schedule = readSchedule ? await readSchedule() : null;
      return res.status(200).type('html').send(rawHtml(layout({
        account: req.account,
        locale,
        path: BASE,
        title: pageTitle(locale, t(locale, 'admin.backups.title')),
        description: t(locale, 'admin.backups.description'),
        noindex: true,
        styles: STYLES,
        body: backupsView({ locale, copies, schedule, csrf: req.session?.csrf ?? null }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  router.post(`/:locale${BASE}/run`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const body = req.body ?? {};
    try {
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.backups.csrf'));
      }
      if (!runBackup) {
        return res.status(501).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.backups.unavailable'));
      }

      const result = await runBackup();
      if (audit) {
        await audit.write({
          actorId: req.session.user.id,
          action: 'backup.run',
          objectType: 'backup',
          objectId: null,
          result: result?.status === 'verified' ? 'ok' : 'error',
          reason: `status=${result?.status ?? 'unknown'}; bytes=${result?.bytes ?? 0}`,
        });
      }
      const back = `/${locale}${BASE}`;
      return res.status(303).set('Location', back).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/** Таблицы стилей экрана: общая плюс его собственная. */
const STYLES = ['base', 'admin'];
