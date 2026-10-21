// Экран «Импорт» (S-76, F-12-08).
//
// Маршрут тонкий: спрашивает отчёт, отдаёт разметку. Разбор параметров —
// белый список: исход позиции и страница приходят из адреса, и в базу они
// попадают только после проверки.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { layout, pageTitle } from '../view/layout.js';
import { studioImportView } from '../view/studioImport.js';

const BASE = '/admin/import';

/** Таблицы стилей экрана: общая плюс админская. */
const STYLES = ['base', 'admin'];

/**
 * Маршруты экрана импорта.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {object} deps.report источник данных отчёта
 * @param {object|null} [deps.freeze] состояние режима защиты
 * @param {object|null} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createImportRoutes({ pool, report, freeze = null, sessionMw = null }) {
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
          csrf: req.csrf ?? '',
        }),
      }).__raw);
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
