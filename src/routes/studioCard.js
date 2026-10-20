// Карточка сериала в студии (S-75, F-10-03) и жизненный цикл (F-10-06).
//
// Экран один, вкладки — это якоря на сервере: админ переключает вкладку
// ссылкой, и адрес можно переслать. Клиентский скрипт тут не нужен.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { layout, pageTitle } from '../view/layout.js';
import { studioCardView } from '../view/studioCard.js';

const BASE = '/admin/catalog';

/** Таблицы стилей экрана: общая плюс админская. */
const STYLES = ['base', 'admin'];

/**
 * Разбор тела multipart средствами Node.
 *
 * Сторонняя библиотека для этого не нужна: `Request.formData()` разбирает
 * `multipart/form-data` сам, а предел тела задан разборщиком тела Express.
 *
 * @param {object} req
 * @returns {Promise<FormData>}
 */
async function readMultipart(req) {
  const type = req.headers['content-type'] ?? '';
  const request = new Request('http://localhost/upload', {
    method: 'POST',
    headers: { 'content-type': type },
    body: req.body,
  });
  return request.formData();
}

/**
 * Маршруты карточки сериала.
 *
 * @param {object} deps
 * @param {object} deps.card источник данных карточки
 * @param {object|null} [deps.audit] журнал действий
 * @param {object|null} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createStudioCardRoutes({
  card, schedule = null, images = null, audit = null, sessionMw = null,
}) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  const adminOnly = (req, res, next) => {
    const roles = req.session?.user?.roles ?? [];
    if (!roles.includes('admin')) return next('router');
    return next();
  };

  router.get(`/:locale${BASE}/:id`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return next('route');

    try {
      const data = await card.read(id);
      if (!data) return next('route');
      const [history, genres, seasons, pictures] = await Promise.all([
        card.history(id),
        card.genres(),
        schedule ? schedule.forSeries(id) : Promise.resolve([]),
        card.images(id),
      ]);
      return res.status(200).type('html').send(layout({
        account: req.account,
        locale,
        path: `${BASE}/${id}`,
        title: pageTitle(locale, t(locale, 'studio.card.title')),
        description: t(locale, 'studio.card.description'),
        noindex: true,
        styles: STYLES,
        body: studioCardView({
          locale,
          card: data,
          history,
          genres,
          schedule: seasons,
          images: pictures,
          tab: String(req.query.tab ?? 'primary'),
          csrf: csrfToken(req.session),
        }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  });

  router.post(`/:locale${BASE}/:id`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const id = Number(req.params.id);
    const body = req.body ?? {};
    try {
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      const fields = {};
      for (const key of Object.keys(body)) {
        if (key.startsWith('f_')) fields[key.slice(2)] = body[key];
      }
      // Галочки приходят по одной на код; пустой список — значит «жанров нет».
      const genres = body.genres !== undefined
        ? [].concat(body.genres).map((code) => String(code).trim()).filter(Boolean)
        : null;

      const result = await card.save(id, {
        fields,
        genres,
        version: body.version === undefined ? null : Number(body.version),
        byId: req.session.user.id,
      });

      if (!result.ok) {
        if (result.reason === 'conflict') {
          return res.status(409).type('text/plain; charset=utf-8')
            .send(t(locale, 'studio.card.conflict'));
        }
        return res.status(400).type('text/plain; charset=utf-8')
          .send(t(locale, 'studio.card.invalid'));
      }
      if (audit) {
        await audit.write({
          actorId: req.session.user.id,
          action: 'series.update',
          objectType: 'series',
          objectId: id,
          result: 'ok',
          reason: (result.changed ?? []).join(', '),
          after: result.after ?? null,
        });
      }
      return res.status(303).set('Location', `/${locale}${BASE}/${id}`).end();
    } catch (error) {
      return next(error);
    }
  });

  // Постановка даты выхода (F-10-05): ручная дата закрывается от импорта.
  if (schedule) {
    router.post(`/:locale${BASE}/:id/schedule`, adminOnly, async (req, res, next) => {
      const { locale } = req.params;
      if (!isLocale(locale)) return next('route');
      const id = Number(req.params.id);
      const body = req.body ?? {};
      try {
        if (!csrfValid(req.session, body.csrf)) {
          return res.status(403).type('text/plain; charset=utf-8')
            .send(t(locale, 'admin.users.csrf'));
        }
        const result = await schedule.setDate({
          seriesId: id,
          seasonId: Number(body.season_id),
          episodeId: body.episode_id === undefined || body.episode_id === ''
            ? null
            : Number(body.episode_id),
          date: body.date,
          time: body.time || null,
          state: body.state || 'scheduled',
          byId: req.session.user.id,
        });
        if (!result.ok) {
          return res.status(400).type('text/plain; charset=utf-8')
            .send(t(locale, `studio.card.scheduleError.${result.reason}`));
        }
        if (audit) {
          await audit.write({
            actorId: req.session.user.id,
            action: 'series.schedule',
            objectType: 'series',
            objectId: id,
            result: 'ok',
            reason: `episode=${body.episode_id ?? ''}; date=${body.date ?? ''}`,
          });
        }
        return res.status(303)
          .set('Location', `/${locale}${BASE}/${id}?tab=schedule`)
          .end();
      } catch (error) {
        return next(error);
      }
    });
  }

  // Загрузка изображения (F-10-04). Тело multipart разбирает сам Node:
  // Request.formData() читает форму без сторонней библиотеки, а тип файла
  // всё равно определяется по содержимому (R-SEC-17), а не по заголовку.
  if (images) {
    router.post(`/:locale${BASE}/:id/images`, adminOnly,
      express.raw({ type: 'multipart/form-data', limit: '16mb' }),
      async (req, res, next) => {
        const { locale } = req.params;
        if (!isLocale(locale)) return next('route');
        const id = Number(req.params.id);
        try {
          const form = await readMultipart(req);
          const token = form.get('csrf');
          if (!req.session || !csrfValid(req.session, token)) {
            return res.status(403).type('text/plain; charset=utf-8')
              .send(t(locale, 'admin.users.csrf'));
          }
          const file = form.get('file');
          if (!file || typeof file.arrayBuffer !== 'function') {
            return res.status(400).type('text/plain; charset=utf-8')
              .send(t(locale, 'studio.card.uploadError.file'));
          }
          const buffer = Buffer.from(await file.arrayBuffer());
          const result = await images.upload({
            seriesId: id,
            role: String(form.get('role') ?? ''),
            buffer,
            hasText: form.get('has_text') === '1',
            byId: req.session.user.id,
          });
          if (!result.ok) {
            return res.status(400).type('text/plain; charset=utf-8')
              .send(t(locale, `studio.card.uploadError.${result.reason}`));
          }
          if (audit) {
            await audit.write({
              actorId: req.session.user.id,
              action: 'series.image_upload',
              objectType: 'series',
              objectId: id,
              result: 'ok',
              reason: String(form.get('role') ?? ''),
              after: { image_id: result.imageId, cropped: result.cropped },
            });
          }
          return res.status(303)
            .set('Location', `/${locale}${BASE}/${id}?tab=images`)
            .end();
        } catch (error) {
          return next(error);
        }
      });
  }

  // Фокальная точка изображения (F-10-04): как кадрировать кадр.
  router.post(`/:locale${BASE}/:id/images/focal`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    const id = Number(req.params.id);
    const body = req.body ?? {};
    try {
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      const result = await card.setFocal({
        seriesId: id,
        role: String(body.role ?? ''),
        focalX: body.focal_x,
        focalY: body.focal_y,
      });
      if (!result.ok) {
        return res.status(400).type('text/plain; charset=utf-8')
          .send(t(locale, `studio.card.focalError.${result.reason}`));
      }
      return res.status(303)
        .set('Location', `/${locale}${BASE}/${id}?tab=images`)
        .end();
    } catch (error) {
      return next(error);
    }
  });

  // Сброс точки к значению по умолчанию (2/3, 1/3) — H-33.
  router.post(`/:locale${BASE}/:id/images/focal/reset`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    const id = Number(req.params.id);
    const body = req.body ?? {};
    try {
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      await card.setFocal({
        seriesId: id,
        role: String(body.role ?? ''),
        focalX: 67,
        focalY: 33,
      });
      return res.status(303)
        .set('Location', `/${locale}${BASE}/${id}?tab=images`)
        .end();
    } catch (error) {
      return next(error);
    }
  });

  router.post(`/:locale${BASE}/:id/publish`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    const id = Number(req.params.id);
    const body = req.body ?? {};
    try {
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      const result = await card.publish(id, { byId: req.session.user.id });
      if (!result.ok && result.reason === 'blocked') {
        return res.status(409).type('text/plain; charset=utf-8')
          .send(t(locale, 'studio.card.publishBlocked', { reasons: result.blockers.join(', ') }));
      }
      if (audit) {
        await audit.write({
          actorId: req.session.user.id,
          action: 'series.publish',
          objectType: 'series',
          objectId: id,
          result: 'ok',
          reason: '',
        });
      }
      return res.status(303).set('Location', `/${locale}${BASE}/${id}`).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post(`/:locale${BASE}/:id/archive`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    const id = Number(req.params.id);
    const body = req.body ?? {};
    try {
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      const reason = String(body.reason ?? '').trim();
      if (!reason) {
        return res.status(400).type('text/plain; charset=utf-8')
          .send(t(locale, 'studio.card.reasonRequired'));
      }
      const result = await card.archive(id, { byId: req.session.user.id, reason });
      if (audit) {
        await audit.write({
          actorId: req.session.user.id,
          action: 'series.archive',
          objectType: 'series',
          objectId: id,
          result: 'ok',
          reason,
          after: result.dependencies ?? null,
        });
      }
      return res.status(303).set('Location', `/${locale}${BASE}/${id}`).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post(`/:locale${BASE}/:id/restore`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    const id = Number(req.params.id);
    const body = req.body ?? {};
    try {
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      const result = await card.restore(id, { byId: req.session.user.id });
      if (audit) {
        await audit.write({
          actorId: req.session.user.id,
          action: 'series.restore',
          objectType: 'series',
          objectId: id,
          result: 'ok',
          reason: result.state ?? '',
        });
      }
      return res.status(303).set('Location', `/${locale}${BASE}/${id}`).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post(`/:locale${BASE}/:id/reset-field`, adminOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    const id = Number(req.params.id);
    const body = req.body ?? {};
    try {
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'admin.users.csrf'));
      }
      const field = String(body.field ?? '');
      const done = await card.resetField(id, field, req.session.user.id);
      if (!done) {
        return res.status(400).type('text/plain; charset=utf-8')
          .send(t(locale, 'studio.card.noImportValue'));
      }
      if (audit) {
        await audit.write({
          actorId: req.session.user.id,
          action: 'series.reset_field',
          objectType: 'series',
          objectId: id,
          result: 'ok',
          reason: field,
        });
      }
      return res.status(303).set('Location', `/${locale}${BASE}/${id}`).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
