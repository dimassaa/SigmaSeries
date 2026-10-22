// Подборки вручную (S-77) и справочники (S-80) — раздел студии.
//
// Раздел административный: чужим адреса отвечают 404, а не 403 (R-SEC-35).

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { layout, pageTitle } from '../view/layout.js';
import { studioCollectionsView, studioCollectionView } from '../view/studioCollections.js';
import { studioDictionariesView } from '../view/studioDictionaries.js';

/** Таблицы стилей экрана: общая плюс админская. */
const STYLES = ['base', 'admin'];

/**
 * Маршруты подборок и справочников.
 *
 * @param {object} deps
 * @param {any} deps.collections источник данных подборок
 * @param {any} deps.dictionaries источник данных справочников
 * @param {any} deps.series каталог: поиск сериала для подборки
 * @param {any} [deps.audit] журнал действий
 * @param {any} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createStudioLibraryRoutes({
  collections, dictionaries, series, audit = null, sessionMw = null,
}) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  const adminOnly = (req, res, next) => {
    const roles = req.session?.user?.roles ?? [];
    if (!roles.includes('admin')) return next('router');
    return next();
  };

  router.get('/:locale/admin/collections', adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    try {
      const list = await collections.list();
      return res.status(200).type('html').send(layout({
        account: req.account,
        locale,
        path: '/admin/collections',
        title: pageTitle(locale, t(locale, 'studio.collections.title')),
        description: t(locale, 'studio.collections.description'),
        noindex: true,
        styles: STYLES,
        body: studioCollectionsView({ locale, list }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:locale/admin/collections/:slug', adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    try {
      const collection = await collections.one(req.params.slug);
      if (!collection) return next('route');
      return res.status(200).type('html').send(layout({
        account: req.account,
        locale,
        path: `/admin/collections/${collection.slug}`,
        title: pageTitle(locale, collection.title),
        description: t(locale, 'studio.collections.description'),
        noindex: true,
        styles: STYLES,
        body: studioCollectionView({
          locale,
          collection,
          csrf: req.session ? csrfToken(req.session) : '',
        }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:locale/admin/collections/:slug', adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    const body = req.body ?? {};
    try {
      if (!req.session || !csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      // Список сериалов приходит строкой через запятую: в одной форме
      // несколько полей с одним именем не нужны.
      const seriesIds = body.series_ids === undefined
        ? null
        : String(body.series_ids).split(',').map((value) => Number(value.trim()))
          .filter(Number.isInteger);
      const result = await collections.save({
        slug: req.params.slug,
        title: body.title_ru,
        titleEn: body.title_en,
        description: body.description_ru,
        descriptionEn: body.description_en,
        weight: body.weight,
        active: body.active === '1' || body.active === 'on' || body.active === 'true',
        seriesIds,
      });
      if (!result.ok) {
        return res.status(400).type('text/plain; charset=utf-8')
          .send(t(locale, `studio.collections.error.${result.reason}`));
      }
      if (audit) {
        await audit.write({
          actorId: req.session.user.id,
          action: 'collection.update',
          objectType: 'collection',
          objectId: null,
          result: 'ok',
          reason: result.slug,
          after: { slug: result.slug },
        });
      }
      return res.status(303)
        .set('Location', `/${locale}/admin/collections/${result.slug}`)
        .end();
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:locale/admin/collections/:slug/order', adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    const body = req.body ?? {};
    try {
      if (!req.session || !csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      const collection = await collections.one(req.params.slug);
      if (!collection) return next('route');
      const where = ['up', 'down', 'first', 'last'].includes(body.where)
        ? body.where
        : 'up';
      await collections.reorder({
        collectionId: collection.id,
        seriesId: Number(body.series_id),
        where,
      });
      return res.status(303)
        .set('Location', `/${locale}/admin/collections/${collection.slug}`)
        .end();
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:locale/admin/dictionaries', adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    try {
      const [genres, platforms, countries] = await Promise.all([
        dictionaries.genres(),
        dictionaries.platforms(),
        dictionaries.countries(locale),
      ]);
      return res.status(200).type('html').send(layout({
        account: req.account,
        locale,
        path: '/admin/dictionaries',
        title: pageTitle(locale, t(locale, 'studio.dictionaries.title')),
        description: t(locale, 'studio.dictionaries.description'),
        noindex: true,
        styles: STYLES,
        body: studioDictionariesView({
          locale,
          genres,
          platforms,
          countries,
          csrf: req.session ? csrfToken(req.session) : '',
        }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:locale/admin/dictionaries', adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    const body = req.body ?? {};
    try {
      if (!req.session || !csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      let result;
      if (body.kind === 'genre') {
        result = await dictionaries.saveGenre({
          code: String(body.code ?? '').trim().toLowerCase(),
          nameRu: body.name_ru,
          nameEn: body.name_en,
          active: body.active === '1' || body.active === 'on',
        });
      } else {
        result = await dictionaries.savePlatform({
          code: String(body.code ?? '').trim().toLowerCase(),
          name: body.name,
          scaleMax: body.scale_max,
          priority: body.priority,
          active: body.active === '1' || body.active === 'on',
        });
      }
      if (!result.ok) {
        return res.status(400).type('text/plain; charset=utf-8')
          .send(t(locale, `studio.dictionaries.error.${result.reason}`));
      }
      if (audit) {
        await audit.write({
          actorId: req.session.user.id,
          action: 'dictionary.update',
          objectType: 'dictionary',
          objectId: null,
          result: 'ok',
          reason: `${body.kind}:${body.code}`,
          after: { code: body.code },
        });
      }
      return res.status(303).set('Location', `/${locale}/admin/dictionaries`).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
