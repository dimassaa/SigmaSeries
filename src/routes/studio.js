// Студия: список сериалов (S-73) и очередь неполных карточек (S-74).
//
// Маршруты тонкие: разбор фильтров, проверка роли, вызов источника, отдача
// разметки. Значения фильтров — белый список на стороне сервиса, поэтому
// сюда попадают только уже проверенные строки.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { layout, pageTitle } from '../view/layout.js';
import { studioListView, studioQueueView } from '../view/studio.js';
import { studioBannersView } from '../view/studioBanners.js';

const BASE = '/admin/catalog';

/** Таблицы стилей экрана: общая плюс админская. */
const STYLES = ['base', 'admin'];

/**
 * Маршруты студии.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {object} deps.studio источник данных студии
 * @param {object} [deps.picks] выборы редакции
 * @param {object|null} [deps.audit] журнал действий
 * @param {object|null} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createStudioRoutes({
  pool, studio, picks = null, bulk = null, audit = null, sessionMw = null,
}) {
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
        body: studioListView({
          locale, list, genres, filters, csrf: csrfToken(req.session),
        }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  });

  // Массовая операция над каталогом (F-10-11). Сначала прогноз: сколько
  // карточек затронет действие и какие не подойдут; потом выполнение.
  if (bulk) {
    router.post(`/:locale${BASE}/bulk`, adminOnly, async (req, res, next) => {
      const { locale } = req.params;
      if (!isLocale(locale)) return next('route');
      const body = req.body ?? {};
      try {
        if (!req.session || !csrfValid(req.session, body.csrf)) {
          return res.status(403).type('text/plain; charset=utf-8')
            .send(t(locale, 'admin.users.csrf'));
        }
        const ids = [].concat(body.ids ?? []).map((value) => Number(value)).filter(Number.isInteger);
        const action = String(body.action ?? '');
        const genre = body.genre ? String(body.genre) : null;
        const reason = body.reason ? String(body.reason) : null;

        if (body.confirm !== '1') {
          const plan = await bulk.preview({ action, ids, genre, reason });
          if (!plan.ok) {
            return res.status(400).type('text/plain; charset=utf-8')
              .send(t(locale, `studio.bulk.error.${plan.reason}`));
          }
          return res.status(200).type('html').send(layout({
            account: req.account,
            locale,
            path: BASE,
            title: pageTitle(locale, t(locale, 'studio.bulk.title')),
            description: t(locale, 'studio.bulk.description'),
            noindex: true,
            styles: STYLES,
            body: bulkPreviewView({
              locale,
              plan,
              action,
              genre,
              reason,
              csrf: csrfToken(req.session),
            }),
          }).__raw);
        }

        const result = await bulk.start({ action, ids, genre, reason, byId: req.session.user.id });
        if (audit) {
          await audit.write({
            actorId: req.session.user.id,
            action: 'catalogue.bulk',
            objectType: 'series',
            objectId: null,
            result: result.ok ? 'ok' : 'denied',
            reason: `${action}; затронуто ${result.affected ?? 0} из ${result.total ?? 0}`,
            after: { job_id: result.jobId ?? null, affected: result.affected ?? 0 },
          });
        }
        return res.status(303).set('Location', `/${locale}${BASE}`).end();
      } catch (error) {
        return next(error);
      }
    });
  }

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

  // «Выбор редакции» и предпросмотр баннеров (S-78, F-10-08).
  if (picks) {
    router.get('/:locale/admin/banners', adminOnly, async (req, res, next) => {
      const { locale } = req.params;
      if (!isLocale(locale)) return next('route');

      try {
        const now = new Date();
        const year = Number(req.query.year) || now.getFullYear();
        const month = Number(req.query.month) || now.getMonth() + 1;
        const date = String(req.query.date ?? '') || localDate(now);
        const [assigned, preview, candidates] = await Promise.all([
          picks.month({ year, month }),
          picks.preview({ date }),
          picks.candidates(50),
        ]);
        return res.status(200).type('html').send(layout({
          account: req.account,
          locale,
          path: '/admin/banners',
          title: pageTitle(locale, t(locale, 'studio.banners.title')),
          description: t(locale, 'studio.banners.note'),
          noindex: true,
          styles: STYLES,
          body: studioBannersView({
            locale,
            month: { year, month },
            picks: assigned,
            preview,
            candidates,
            date,
            csrf: csrfToken(req.session),
          }),
        }).__raw);
      } catch (error) {
        return next(error);
      }
    });

    router.post('/:locale/admin/banners', adminOnly, async (req, res, next) => {
      const { locale } = req.params;
      if (!isLocale(locale)) return next('route');

      const body = req.body ?? {};
      const date = String(body.date ?? '');
      const seriesId = Number(body.series_id);
      try {
        if (!csrfValid(req.session, body.csrf)) {
          return res.status(403).type('text/plain; charset=utf-8')
            .send(t(locale, 'admin.users.csrf'));
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(seriesId)) {
          return res.status(400).type('text/plain; charset=utf-8')
            .send(t(locale, 'studio.banners.badRequest'));
        }
        if (date < localDate()) {
          return res.status(400).type('text/plain; charset=utf-8')
            .send(t(locale, 'studio.banners.pastDate'));
        }
        const saved = await picks.assign({
          seriesId,
          date,
          byId: req.session.user.id,
          note: String(body.note ?? '').trim() || null,
        });
        if (!saved) {
          return res.status(409).type('text/plain; charset=utf-8')
            .send(t(locale, 'studio.banners.notFit'));
        }
        // Смена выбора посреди суток пересчитывает баннеры сразу: это
        // единственное исключение из суточного ритма (F-06-02 §5).
        if (date === localDate()) await picks.recompute({ date });
        if (audit) {
          await audit.write({
            actorId: req.session.user.id,
            action: 'editorial_pick.set',
            objectType: 'editorial_pick',
            objectId: null,
            result: 'ok',
            reason: `${date}; series=${seriesId}`,
            after: { date, series_id: seriesId },
          });
        }
        return res.status(303).set('Location', `/${locale}/admin/banners?date=${date}`).end();
      } catch (error) {
        return next(error);
      }
    });

    router.post('/:locale/admin/banners/clear', adminOnly, async (req, res, next) => {
      const { locale } = req.params;
      if (!isLocale(locale)) return next('route');

      const body = req.body ?? {};
      const date = String(body.date ?? '');
      try {
        if (!csrfValid(req.session, body.csrf)) {
          return res.status(403).type('text/plain; charset=utf-8')
            .send(t(locale, 'admin.users.csrf'));
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return res.status(400).type('text/plain; charset=utf-8')
            .send(t(locale, 'studio.banners.badRequest'));
        }
        const removed = await picks.clear({ date });
        if (audit) {
          await audit.write({
            actorId: req.session.user.id,
            action: 'editorial_pick.clear',
            objectType: 'editorial_pick',
            objectId: null,
            result: removed ? 'ok' : 'denied',
            reason: date,
            after: { date },
          });
        }
        return res.status(303).set('Location', `/${locale}/admin/banners?date=${date}`).end();
      } catch (error) {
        return next(error);
      }
    });
  }

  return router;
}

/**
 * Дата в формате YYYY-MM-DD.
 *
 * @param {Date} [at]
 * @returns {string}
 */
function localDate(at = new Date()) {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
    manual: query.manual === '1' || query.manual === 'on',
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
