// Решения редактора по материалам (F-05-04, S-50).
//
// Маршрут — служебный POST: решение принимает человек, а не ссылка. Права
// берутся из сессии (EC-R7), и решение без верного токена не проходит.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { csrfValid } from '../services/auth/session.js';
import { DECISIONS } from '../services/moderation/decision.js';
import { moderationView } from '../view/moderation.js';
import { layout, pageTitle } from '../view/layout.js';
import { errorPage } from './home.js';
import { csrfToken } from '../services/auth/session.js';
import { safeReturnTo } from '../services/auth/login.js';
import { MODERATION } from '../services/settings.js';
import { STYLE_GROUPS } from '../config/styles.js';

/** Таблицы стилей экрана: общая плюс его собственная. */
const STYLES = STYLE_GROUPS.map((group) => group.name).filter((name) => name === 'base' || name === 'moderation');

const BASE = '/mod';

/** Ответ отправляется разобранной строкой: `send()` объекта ушёл бы в JSON. */
const rawHtml = (page) => page.__raw;

/**
 * Маршруты разбора материалов.
 *
 * @param {object} deps
 * @param {object} deps.decisions сервис решений
 * @param {object|null} [deps.audit] журнал действий
 * @param {object|null} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createModerationRoutes({
  decisions, clustersService = null, budget = null, restrictions = null, audit = null, sessionMw = null,
}) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  /** Редактор и выше: решение принимает редактор, администратор видит (DEC-005). */
  const editorOnly = (req, res, next) => {
    const roles = req.session?.user?.roles ?? [];
    if (!roles.includes('editor') && !roles.includes('admin')) return next('router');
    return next();
  };

  router.get(`/:locale${BASE}`, editorOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    try {
      const [queue, clusters, mode] = await Promise.all([
        clustersService.ordered({ limit: 100 }),
        clustersService.groups({
          windowHours: MODERATION.clusterWindowH,
          minSize: MODERATION.clusterMinSize,
        }),
        budget.cautiousState().then(async (state) => ({
          ...state,
          ...(await budget.queuePressure()),
        })),
      ]);

      // Разбираемый материал выбирается адресом: одна карточка за раз
      // (DEC-012), и разбор можно переслать.
      const wanted = Number(req.query.material);
      const material = Number.isInteger(wanted) && wanted > 0
        ? await decisions.one({ materialId: wanted })
        : null;

      return res.status(200).type('html').send(rawHtml(layout({
        account: req.account,
        locale,
        path: BASE,
        title: pageTitle(locale, t(locale, 'mod.title')),
        description: t(locale, 'mod.description'),
        noindex: true,
        styles: STYLES,
        body: moderationView({
          locale,
          queue,
          clusters,
          material,
          csrf: csrfToken(req.session),
          mode,
        }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  // Ограничение автора материала: мьют (редактор) или бан (администратор).
  router.post(`/:locale${BASE}/user/:userId`, editorOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId < 1) {
      return res.status(404).type('text/plain; charset=utf-8')
        .send(t(locale, 'mod.error.missing'));
    }

    const body = req.body ?? {};
    const action = String(body.action ?? '');
    const reason = String(body.reason ?? '').trim();
    const hours = Number(body.hours ?? MODERATION.muteMinHours);
    const hideMaterials = body.hide_materials === '1' || body.hide_materials === 'on';
    const roles = req.session?.user?.roles ?? [];
    const isAdmin = roles.includes('admin');

    try {
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'mod.error.csrf'));
      }
      // Бан — только администратор (F-05-08 §2): редактор ограничивает
      // поток материалов, но не отнимает доступ к сервису.
      if (action === 'ban' && !isAdmin) {
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'mod.error.ban'));
      }

      let result;
      if (action === 'mute') {
        result = await restrictions.mute({ userId, hours, reason, byId: req.session.user.id, isAdmin });
      } else if (action === 'ban') {
        result = await restrictions.ban({ userId, reason, byId: req.session.user.id, hideMaterials });
      } else if (action === 'revoke') {
        result = await restrictions.revoke({ userId, byId: req.session.user.id, reason });
      } else {
        result = { ok: false, reason: 'action' };
      }

      if (!result.ok) {
        const key = {
          reason: 'mod.error.reason',
          hours: 'mod.error.hours',
          privileged: 'mod.error.privileged',
          action: 'mod.error.decision',
        }[result.reason] ?? 'mod.error.decision';
        if (result.reason === 'privileged') {
          // Служебного человека ограничивает администратор — это «недостаточно
          // прав», и об этом говорит страница (S-43), а не строка текста.
          return res.status(403).type('html; charset=utf-8')
            .send(errorPage(locale, 'forbidden').__raw);
        }
        return res.status(400).type('text/plain; charset=utf-8').send(t(locale, key));
      }

      const back = body.back ? safeReturnTo(body.back) : `/${locale}${BASE}`;
      return res.status(303).set('Location', back).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post(`/:locale${BASE}/:id`, editorOnly, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(404).type('text/plain; charset=utf-8')
        .send(t(locale, 'mod.error.missing'));
    }

    const body = req.body ?? {};
    const decision = String(body.decision ?? '');
    const reason = String(body.reason ?? '').trim();
    const matchedWord = body.matched_word ? String(body.matched_word) : null;
    const whitelist = body.whitelist === '1' || body.whitelist === 'on';

    try {
      if (!csrfValid(req.session, body.csrf)) {
        if (audit) {
          await audit.write({
            actorId: req.session.user.id,
            action: 'material.decide',
            objectType: 'material',
            objectId: id,
            result: 'denied',
            reason: 'csrf-missing',
          });
        }
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'mod.error.csrf'));
      }

      const result = await decisions.decide({
        materialId: id,
        decision,
        editorId: req.session.user.id,
        reason,
        matchedWord,
        whitelist,
      });

      if (!result.ok) {
        const key = {
          decision: 'mod.error.decision',
          reason: 'mod.error.reason',
          rate: 'mod.error.rate',
          missing: 'mod.error.missing',
        }[result.reason] ?? 'mod.error.decision';
        return res.status(result.reason === 'missing' ? 404 : 400)
          .type('text/plain; charset=utf-8')
          .send(t(locale, key));
      }

      // Решение и добавление слова в белый список — две записи в аудите
      // (F-05-04 §18: «оба события в аудите»).
      if (audit) {
        await audit.write({
          actorId: req.session.user.id,
          action: 'material.decide',
          objectType: 'material',
          objectId: id,
          // В журнале результат — «ok»/«denied»/«error», а само решение
          // едет в причине: журнал перечисляет допустимые результаты, и
          // «approved» в них не значится.
          result: 'ok',
          reason: `decision=${DECISIONS[decision] ?? decision}; ${reason}`,
        });
        if (whitelist && matchedWord) {
          await audit.write({
            actorId: req.session.user.id,
            action: 'dictionary.allow_word',
            objectType: 'dictionary_word',
            objectId: matchedWord,
            result: 'ok',
            reason: `word=${matchedWord}; ${reason}`,
          });
        }
      }

      if (result.skipped) {
        return res.status(204).end();
      }
      // Возврат — на разбираемый материал, а без адреса — в очередь.
      const back = body.back ? safeReturnTo(body.back) : `/${locale}${BASE}`;
      return res.status(303).set('Location', back).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
