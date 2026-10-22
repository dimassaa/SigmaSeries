// Экран «Импорт» (S-76, F-12-08).
//
// Маршрут тонкий: спрашивает отчёт, отдаёт разметку. Разбор параметров —
// белый список: исход позиции и страница приходят из адреса, и в базу они
// попадают только после проверки.
//
// Кнопки запуска не выполняют прогон: они заводят строку, а выполняет её
// планировщик. Тяжёлое не должно идти в веб-запросе (R-PERF-09).

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { layout, pageTitle } from '../view/layout.js';
import { studioImportView } from '../view/studioImport.js';
import { planManualRun } from '../services/import/runs.js';

const BASE = '/admin/import';

/** Таблицы стилей экрана: общая плюс админская. */
const STYLES = ['base', 'admin'];

/**
 * Маршруты экрана импорта.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {any} deps.report источник данных отчёта
 * @param {any} [deps.freeze] состояние режима защиты
 * @param {any} [deps.audit] журнал действий
 * @param {any} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createImportRoutes({ pool, report, freeze = null, audit = null, sessionMw = null }) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  // Только админ: для остальных раздела не существует (R-SEC-35).
  const adminOnly = (req, res, next) => {
    const roles = req.session?.user?.roles ?? [];
    if (!roles.includes('admin')) return next('router');
    return next();
  };

  router.get(`/:locale${BASE}`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    try {
      const runId = readId(req.query.run);
      const outcome = typeof req.query.outcome === 'string' ? req.query.outcome : '';
      const page = readPage(req.query.page);

      const [overview, runs, mode] = await Promise.all([
        report.overview(),
        report.runs(),
        freeze ? freeze.state() : Promise.resolve({ frozen: false, since: null }),
      ]);
      const detail = runId ? await report.run(runId, { outcome, page }) : null;

      return res.status(200).type('html').send(layout({
        account: req.account,
        locale,
        path: BASE,
        title: pageTitle(locale, t(locale, 'studio.import.title')),
        description: t(locale, 'studio.import.description'),
        styles: STYLES,
        body: studioImportView({
          locale,
          overview,
          runs,
          detail,
          mode,
          selected: detail?.run?.id ?? null,
          csrf: csrfToken(req.session),
        }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  });

  // Запуск по кнопке. Вид запуска — белый список: всё, чего в нём нет,
  // считается полным прогоном.
  router.post(`/:locale${BASE}/run`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const body = req.body ?? {};
    try {
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'studio.import.run.csrf'));
      }

      const kind = body.kind === 'schedule_sync' ? 'schedule_sync' : 'full_run';
      const dryRun = body.dry === '1';
      const result = await planManualRun({ pool, kind, dryRun });

      if (audit) {
        // Ручное действие — в журнал: кто и что запустил (R-SEC-36).
        await audit.write({
          actorId: req.session.user.id,
          action: 'import.run',
          objectType: 'import_run',
          objectId: result.id,
          result: result.ok ? 'ok' : 'denied',
          reason: `kind=${kind}; dry=${dryRun}; ${result.reason ?? 'ok'}`,
        });
      }

      if (!result.ok) {
        return res.status(409).type('text/plain; charset=utf-8')
          .send(t(locale, `studio.import.run.${result.reason}`));
      }
      const back = `/${locale}${BASE}`;
      return res.status(303).set('Location', back).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/** Номер запуска из адреса: только целое число. */
function readId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Страница: целое число, единица — первая. */
function readPage(value) {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}
