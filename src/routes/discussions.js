// Обсуждения сериала (S-13, S-14) и комментарии к отзыву (S-10).
//
// Подача материала идёт по общему конвейеру модерации: словарь, лимиты
// частоты, «осторожный» режим. Поэтому маршрут только спрашивает источник и
// показывает результат.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { layout, pageTitle } from '../view/layout.js';
import { discussionsListView, discussionTopicView } from '../view/discussions.js';

const BASE = '/discussions';

/** Таблицы стилей: общая плюс каталог и отзывы — там живут постеры и формы. */
const STYLES = ['base', 'series', 'reviews'];

/**
 * Маршруты обсуждений.
 *
 * @param {object} deps
 * @param {any} deps.discussions источник данных обсуждений
 * @param {any} deps.series каталог: сериал по адресу
 * @param {any} [deps.dictionary] словарь проверки
 * @param {any} [deps.limits] бюджет модерации
 * @param {any} [deps.restrictions] ограничения пользователя
 * @param {any} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createDiscussionRoutes({
  discussions, series, dictionary = null, limits = null, restrictions = null, sessionMw = null,
}) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  /**
   * Человек, который может писать: вошедший и не заглушенный.
   *
   * @param {import('express').Request} req
   * @returns {any|null}
   */
  const writer = (req) => req.session?.user ?? null;

  /**
   * Токен формы. Без сессии токена нет, и форма всё равно не примет ответ.
   *
   * @param {import('express').Request} req
   * @returns {string}
   */
  const csrfOf = (req) => (req.session ? csrfToken(req.session) : '');

  router.get('/:locale/series/:slug/discussions', async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    try {
      const found = await series.bySlug(req.params.slug);
      if (!found) return next('route');
      const page = Math.max(1, Number(req.query.page) || 1);
      const topics = await discussions.listForSeries(found.id, { page });
      return res.status(200).type('html').send(layout({
        account: req.account,
        locale,
        path: `/series/${req.params.slug}/discussions`,
        title: pageTitle(locale, t(locale, 'discussions.title')),
        description: t(locale, 'discussions.description'),
        styles: STYLES,
        body: discussionsListView({
          locale,
          series: found,
          topics,
          page,
          user: writer(req),
          csrf: csrfOf(req),
        }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:locale/series/:slug/discussions', async (req, res, next) => {
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
          .send(t(locale, 'discussions.signIn'));
      }
      const found = await series.bySlug(req.params.slug);
      if (!found) return next('route');

      const result = await discussions.createTopic({
        userId: user.id,
        seriesId: found.id,
        title: body.title,
        body: body.body,
        spoiler: body.spoiler === '1' || body.spoiler === 'on',
        dictionary: dictionary ? await dictionary.load() : { block: [], allow: [], available: false },
      });
      if (!result.ok) {
        return res.status(400).type('text/plain; charset=utf-8')
          .send(t(locale, `discussions.error.${result.reason}`));
      }
      return res.status(303)
        .set('Location', `/${locale}${BASE}/${result.id}`)
        .end();
    } catch (error) {
      return next(error);
    }
  });

  router.get(`/:locale${BASE}/:id`, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return next('route');

    try {
      const found = await discussions.topic(id, { userId: req.session?.user?.id ?? null });
      if (!found) return next('route');
      return res.status(200).type('html').send(layout({
        account: req.account,
        locale,
        path: `${BASE}/${id}`,
        title: pageTitle(locale, found.title || t(locale, 'discussions.topicTitle')),
        description: t(locale, 'discussions.description'),
        styles: STYLES,
        body: discussionTopicView({
          locale,
          topic: found,
          user: writer(req),
          csrf: csrfOf(req),
        }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  });

  router.post(`/:locale${BASE}/:id/reply`, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const id = Number(req.params.id);
    const body = req.body ?? {};
    try {
      if (!req.session || !csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      const user = writer(req);
      if (!user) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'discussions.signIn'));
      }
      const result = await discussions.reply({
        userId: user.id,
        topicId: id,
        body: body.body,
        spoiler: body.spoiler === '1' || body.spoiler === 'on',
        dictionary: dictionary ? await dictionary.load() : { block: [], allow: [], available: false },
      });
      if (!result.ok) {
        return res.status(400).type('text/plain; charset=utf-8')
          .send(t(locale, `discussions.error.${result.reason}`));
      }
      return res.status(303).set('Location', `/${locale}${BASE}/${id}`).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post(`/:locale${BASE}/:id/pin`, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const id = Number(req.params.id);
    const body = req.body ?? {};
    try {
      if (!req.session || !csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      // Закрепляет только редактор: правило без исключений (F-05-07 §8б).
      const roles = req.session?.user?.roles ?? [];
      if (!roles.includes('admin') && !roles.includes('moderator')) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'discussions.error.forbidden'));
      }
      await discussions.pin({ materialId: Number(body.post_id), byId: req.session.user.id });
      return res.status(303).set('Location', `/${locale}${BASE}/${id}`).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
