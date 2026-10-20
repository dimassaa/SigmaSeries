// Решения редактора по материалам (F-05-04, S-50).
//
// Маршрут — служебный POST: решение принимает человек, а не ссылка. Права
// берутся из сессии (EC-R7), и решение без верного токена не проходит.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { csrfValid } from '../services/auth/session.js';
import { buildEntry } from '../services/audit/log.js';
import { DECISIONS } from '../services/moderation/decision.js';

const BASE = '/mod';

/**
 * Маршруты разбора материалов.
 *
 * @param {object} deps
 * @param {object} deps.decisions сервис решений
 * @param {object|null} [deps.audit] журнал действий
 * @param {object|null} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createModerationRoutes({ decisions, audit = null, sessionMw = null }) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  /** Редактор и выше: решение принимает редактор, администратор видит (DEC-005). */
  const editorOnly = (req, res, next) => {
    const roles = req.session?.user?.roles ?? [];
    if (!roles.includes('editor') && !roles.includes('admin')) return next('router');
    return next();
  };

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
          await audit.write(buildEntry({
            actorId: req.session.user.id,
            action: 'material.decide',
            objectType: 'material',
            objectId: id,
            result: 'denied',
            reason: 'csrf-missing',
          }));
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
        await audit.write(buildEntry({
          actorId: req.session.user.id,
          action: 'material.decide',
          objectType: 'material',
          objectId: id,
          result: DECISIONS[decision] ?? decision,
          reason,
        }));
        if (whitelist && matchedWord) {
          await audit.write(buildEntry({
            actorId: req.session.user.id,
            action: 'dictionary.allow_word',
            objectType: 'dictionary_word',
            objectId: matchedWord,
            result: 'added',
            reason,
          }));
        }
      }

      if (result.skipped) {
        return res.status(204).end();
      }
      return res.status(303).set('Location', `/${locale}/mod`).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
