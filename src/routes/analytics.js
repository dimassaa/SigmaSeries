// Приём событий аналитики (M8, F-08-01) и согласие на них.
//
// Событие идёт после согласия: до согласия аналитика не загружается вовсе
// (F-08-01 §8г, R-AN-03). Согласие хранится в сессии — она на сервере,
// и подделать его нельзя.
//
// Токен приёма одноразовый: без него пачку событий можно было бы подделать
// из чужого браузера (R-AN-12).

import express from 'express';

import { t, isLocale } from '../i18n/strings.js';
import { clientIp } from '../http/helpers.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { userPseudoId } from '../services/analytics/events.js';
import {
  analyticsOverviewView,
  analyticsRetentionView,
  analyticsContentView,
  analyticsModerationView,
  analyticsPerformanceView,
} from '../view/analytics.js';
import { layout, pageTitle } from '../view/layout.js';

/**
 * Маршруты аналитики.
 *
 * @param {object} deps
 * @param {object} deps.analytics сервис приёма событий
 * @param {object|null} [deps.sessionMw]
 * @returns {import('express').Router}
 */
export function createAnalyticsRoutes({ analytics, metrics = null, sessionMw = null }) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  /**
   * Одноразовый токен приёма.
   */
  router.get('/:locale/analytics/token', (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');
    const token = analytics.issueToken();
    req.session.analyticsToken = token;
    // Токен формы едет вместе: баннер согласия тоже его шлёт, а разметка
    // страницы его не знает — гостю меню аккаунта нет.
    return res.status(200).json({ token, csrf: req.session ? csrfToken(req.session) : '' });
  });

  /**
   * Приём пачки событий.
   */
  router.post('/:locale/analytics/events', async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const body = req.body ?? {};
    try {
      // Без согласия события не принимаются: до согласия существуют только
      // серверные агрегированные счётчики без идентификаторов (R-AN-03).
      if (!req.session?.analyticsConsent) {
        return res.status(200).json({ accepted: 0, rejected: Array.isArray(body.events) ? body.events.length : 0 });
      }

      const result = await analytics.intake({
        events: body.events,
        token: body.token ?? null,
        expectedToken: req.session?.analyticsToken ?? null,
        context: {
          anonId: req.session?.analyticsAnonId ?? null,
          userPseudoId: req.session?.user ? userPseudoId(req.session.user.id) : null,
          locale,
          theme: req.session?.theme ?? null,
          deviceClass: deviceClassOf(req),
          sessionId: req.sessionID ?? null,
          pageType: body.page_type ?? null,
          source: clientIp(req),
        },
      });

      // Токен одноразовый: следующая пачка получит новый.
      req.session.analyticsToken = null;
      return res.status(200).json({ accepted: result.accepted, rejected: result.rejected });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * Согласие на аналитику: человек решает сам.
   */
  router.post('/:locale/analytics/consent', async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');
    const body = req.body ?? {};
    try {
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8').send(t(locale, 'mark.error.csrf'));
      }
      const granted = body.granted === 'on' || body.granted === 'true';
      req.session.analyticsConsent = granted;
      if (!req.session.analyticsAnonId) {
        req.session.analyticsAnonId = randomAnonId();
      }
      return res.status(303).set('Location', `/${locale}/`).end();
    } catch (error) {
      return next(error);
    }
  });

  // ─── Дашборды (M8, F-08-03…F-08-05) ───────────────────────────────────────
  //
  // Аналитика и администратор: данные продукта — не публичное знание.
  const staffOnly = (req, res, next) => {
    const roles = req.session?.user?.roles ?? [];
    if (!roles.includes('analyst') && !roles.includes('admin')) return next('router');
    return next();
  };

  /** Период: сутки, неделя или месяц. */
  function hoursOf(req) {
    const raw = String(req.query.period ?? '24h');
    if (raw === '7d') return 168;
    if (raw === '30d') return 720;
    return 24;
  }

  /** Демо-данные исключаются по умолчанию (R-AN-11). */
  function demoExcluded(req) {
    return req.query.demo !== '1';
  }

  /**
   * Страница дашборда.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {Function} view
   * @param {Function} load данные дашборда
   * @param {string} titleKey
   */
  async function page(req, res, view, load, titleKey) {
    const locale = req.params.locale;
    try {
      const hours = hoursOf(req);
      const data = await load({ hours, excludeDemo: demoExcluded(req) });
      return res.status(200).type('html').send(layout({
        account: req.account,
        locale,
        path: '/analytics',
        title: pageTitle(locale, t(locale, titleKey)),
        description: t(locale, 'analytics.description'),
        noindex: true,
        styles: ['analytics'],
        body: view({ locale, data }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  }

  router.get('/:locale/analytics', staffOnly, (req, res, next) => page(
    req, res, analyticsOverviewView,
    async (options) => {
      const overview = await metrics.overview(options);
      return { ...overview, rejects: await metrics.rejects() };
    },
    'analytics.overview.title',
  ));

  router.get('/:locale/analytics/retention', staffOnly, (req, res, next) => page(
    req, res, analyticsRetentionView,
    async (options) => ({ ...options, funnel: await metrics.funnel(options) }),
    'analytics.retention.title',
  ));

  router.get('/:locale/analytics/content', staffOnly, (req, res, next) => page(
    req, res, analyticsContentView,
    async (options) => ({ ...options, search: await metrics.search(options) }),
    'analytics.content.title',
  ));

  router.get('/:locale/analytics/moderation', staffOnly, (req, res, next) => page(
    req, res, analyticsModerationView,
    async (options) => ({ ...options, moderation: await metrics.moderation(options) }),
    'analytics.moderation.title',
  ));

  router.get('/:locale/analytics/performance', staffOnly, (req, res, next) => page(
    req, res, analyticsPerformanceView,
    async (options) => ({ ...options, vitals: await metrics.vitals(options) }),
    'analytics.performance.title',
  ));

  return router;
}

/**
 * Класс устройства: телефон, планшет или компьютер.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function deviceClassOf(req) {
  const width = Number(req.headers['x-viewport-width']) || 0;
  if (width > 0) {
    if (width < 768) return 'mobile';
    if (width < 1024) return 'tablet';
    return 'desktop';
  }
  return 'unknown';
}

/**
 * Псевдоним гостя: случайный и не связанный ни с чем.
 *
 * @returns {string}
 */
function randomAnonId() {
  return `anon_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

