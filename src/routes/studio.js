// Студия: список сериалов (S-73) и очередь неполных карточек (S-74).
//
// Маршруты тонкие: разбор фильтров, проверка роли, вызов источника, отдача
// разметки. Значения фильтров — белый список на стороне сервиса, поэтому
// сюда попадают только уже проверенные строки.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { layout, pageTitle } from '../view/layout.js';
import { studioListView, studioQueueView } from '../view/studio.js';

const BASE = '/admin/catalog';

/** Таблицы стилей экрана: общая плюс админская. */
const STYLES = ['base', 'admin'];

/**
 * Маршруты студии.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {object} deps.studio источник данных студии
 * @param {object|null} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createStudioRoutes({ pool, studio, sessionMw = null }) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  // Только админ: для остальных все адреса раздела отвечают 404
  // (R-SEC-35), а не 403 — раздела не существует.
  const adminOnly = (req, res, next) => {
    const roles = req.session?.user?.roles ?? [];
    if (!roles.includes('admin')) return next('router');
    return next();
  };

  router.get(`/:locale${BASE}`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    try {
      const filters = readFilters(req.query);
      const [list, genres] = await Promise.all([
        studio.list(filters),
        studio.genres(),
      ]);
      return res.status(200).type('html').send(layout({
        account: req.account,
        locale,
        path: BASE,
        title: pageTitle(locale, t(locale, 'studio.catalogue.title')),
        description: t(locale, 'studio.catalogue.description'),
        noindex: true,
        styles: STYLES,
        body: studioListView({ locale, list, genres, filters }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  });

  router.get(`/:locale${BASE}/incomplete`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const reason = String(req.query.reason ?? '');
      const queue = await studio.incomplete({ page, reason });
      return res.status(200).type('html').send(layout({
        account: req.account,
        locale,
        path: `${BASE}/incomplete`,
        title: pageTitle(locale, t(locale, 'studio.queue.title')),
        description: t(locale, 'studio.queue.description'),
        noindex: true,
        styles: STYLES,
        body: studioQueueView({ locale, queue, reason }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/**
 * Фильтры из адреса.
 *
 * @param {object} query
 * @returns {object}
 */
function readFilters(query = {}) {
  const reasons = []
    .concat(query.reason ?? [])
    .map((value) => String(value))
    .filter(Boolean);
  return {
    page: Math.max(1, Number(query.page) || 1),
    query: String(query.q ?? '').slice(0, 100),
    publication: String(query.publication ?? ''),
    exit: String(query.exit ?? ''),
    level: String(query.level ?? ''),
    reasons,
    genre: String(query.genre ?? ''),
    yearFrom: toYear(query.year_from),
    yearTo: toYear(query.year_to),
    sort: String(query.sort ?? 'popular'),
  };
}

/**
 * Год из адреса: только целое в разумных пределах.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toYear(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number < 1900 || number > 2200) return null;
  return Math.trunc(number);
}
