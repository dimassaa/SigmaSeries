// Руководства: список (S-11) и статья (S-12).
//
// Подача идёт по общему конвейеру модерации: словарь, лимиты частоты,
// «осторожный» режим. Маршрут только спрашивает источник и показывает ответ.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { layout, pageTitle } from '../view/layout.js';
import { guidesListView, guideView } from '../view/guides.js';

const BASE = '/guides';

/** Таблицы стилей экрана: общая плюс каталог и отзывы — там постеры и формы. */
const STYLES = ['base', 'series', 'reviews'];

/**
 * Маршруты руководств.
 *
 * @param {object} deps
 * @param {object} deps.guides источник данных руководств
 * @param {object} deps.series каталог: сериал по адресу
 * @param {object|null} [deps.dictionary] словарь проверки
 * @param {object|null} [deps.limits] бюджет модерации
 * @param {object|null} [deps.restrictions] ограничения пользователя
 * @param {object|null} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createGuideRoutes({
  guides, series, dictionary = null, limits = null, restrictions = null, sessionMw = null,
}) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  const writer = (req) => req.session?.user ?? null;

  router.get(`/:locale${BASE}`, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const list = await guides.list({ page });
      return res.status(200).type('html').send(layout({
        account: req.account,
        locale,
        path: BASE,
        title: pageTitle(locale, t(locale, 'guides.title')),
        description: t(locale, 'guides.description'),
        styles: STYLES,
        body: guidesListView({
          locale, list, user: writer(req), csrf: csrfToken(req.session),
        }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:locale/series/:slug/guides', async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    try {
      const found = await series.bySlug(req.params.slug);
      if (!found) return next('route');
      const list = await guides.list({ seriesId: found.id });
      return res.status(200).type('html').send(layout({
        account: req.account,
        locale,
        path: `/series/${req.params.slug}/guides`,
        title: pageTitle(locale, t(locale, 'guides.title')),
        description: t(locale, 'guides.description'),
        styles: STYLES,
        body: guidesListView({
          locale, list, series: found, user: writer(req), csrf: csrfToken(req.session),
        }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  });

  router.get(`/:locale${BASE}/:slug`, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    try {
      const guide = await guides.one(req.params.slug);
      if (!guide) return next('route');
      return res.status(200).type('html').send(layout({
        account: req.account,
        locale,
        path: `${BASE}/${guide.slug}`,
        title: pageTitle(locale, guide.title),
        description: guide.excerpt,
        styles: STYLES,
        body: guideView({ locale, guide, user: writer(req) }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  });

  router.post(`/:locale${BASE}`, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    const body = req.body ?? {};
    try {
      if (!req.session || !csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      const user = writer(req);
      if (!user) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'guides.signIn'));
      }
      // Статья всегда о сериале: без привязки её нечем считать полезной,
      // и схема такую строку не принимает.
      const found = await series.bySlug(String(body.series_slug ?? ''));
      if (!found) {
        return res.status(400).type('text/plain; charset=utf-8')
          .send(t(locale, 'guides.error.series'));
      }
      const seriesId = found.id;
      const result = await guides.submit({
        userId: user.id,
        seriesId,
        title: body.title,
        text: body.text,
        spoiler: body.spoiler === '1' || body.spoiler === 'on',
        dictionary: dictionary ? await dictionary.load() : { block: [], allow: [], available: false },
      });
      if (!result.ok) {
        return res.status(400).type('text/plain; charset=utf-8')
          .send(t(locale, `guides.error.${result.reason}`));
      }
      return res.status(303)
        .set('Location', `/${locale}${BASE}/${result.slug}`)
        .end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
