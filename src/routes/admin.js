// Ветвь админских операций F-04-08: решение по аномалии оценок.
//
// Экран разбора живёт в M9 (S-70 или S-71), а решение нужно сейчас:
// и без решения заморозка была бы вечной. Поэтому POST есть, страницы нет:
// не-админ получает 404, как и на других служебных адресах.
//
// Роли проверяются по сессии (defer к общим правилам), а не по телу запроса;
// CSRF обязателен; оба решения и оба вида отказа попадают в audit_log.

import express from 'express';

import { isLocale, t } from '../i18n/strings.js';
import { csrfValid } from '../services/auth/session.js';
import { buildEntry } from '../services/audit/log.js';

const BASE = '/admin/anomaly';
// Форма говорит человеческим словом «accept/discard», сервис — состояниями
// строки; словарь держит соответствие у самого маршрута, чтобы никакого
// «как-нибудь» не доехало до обновления строк.
const DECISIONS = { accept: 'accepted', discard: 'discarded' };

/**
 * Маршруты разбора аномалий.
 *
 * @param {object} deps
 * @param {object} deps.anomalies хранилище аномалий (resolve)
 * @param {Function} deps.sessionMw middleware сессий
 * @param {object} deps.audit журнал действий (audit_log.write)
 */
export function createAdminRoutes({ anomalies, sessionMw, audit }) {
  const router = express.Router({ strict: true });
  router.use('/:locale{/:rest}', sessionMw);

  /**
   * Только админ. Гость и не-админ получают одинаковый 404: ответ 403
   * выдавал бы существование маршрута (F-01-12 §18 — тот же вывод).
   *
   * `next('router')` передаёт обработку общему 404 приложения.
   */
  const adminOnly = (req, res, next) => {
    const roles = req.session?.user?.roles ?? [];
    if (!roles.includes('admin')) return next('router');
    return next();
  };

  router.post(`/:locale${BASE}/:id`, adminOnly, async (req, res, next) => {
    try {
      const locale = req.params.locale;
      if (!isLocale(locale)) return next('route');

      const id = Number(req.params.id);
      const decision = DECISIONS[req.body?.decision];
      if (!decision || !Number.isInteger(id) || id <= 0) {
        // Незнакомое слово или мусор в адресе — наша ошибка формы, а службы
        // сервиса не касаемся: логировать тут нечего, кроме неудачи.
        return res.status(400).type('text/plain; charset=utf-8')
          .send(t(locale, 'anomaly.error.decision'));
      }

      if (!csrfValid(req.session, req.body?.csrf)) {
        await audit.write(buildEntry({
          actorId: req.session.user.id,
          action: 'rating_anomaly.resolve',
          objectType: 'rating_anomaly',
          objectId: id,
          result: 'denied',
          reason: 'csrf-missing',
        }));
        return res.status(403).type('text/plain; charset=utf-8')
          .send(t(locale, 'anomaly.error.csrf'));
      }

      const result = await anomalies.resolve({
        id, decision, adminId: req.session.user.id,
      });

      if (result.ok) {
        await audit.write(buildEntry({
          actorId: req.session.user.id,
          action: 'rating_anomaly.resolve',
          objectType: 'rating_anomaly',
          objectId: id,
          result: 'ok',
          reason: `decision=${result.decision}; discarded=${result.discarded}`,
          before: { state: 'open' },
          after: { state: result.decision },
        }));
        // Экран разбора появится в M9; сейчас разумный выход — на главную.
        return res.redirect(303, `/${locale}`);
      }

      await audit.write(buildEntry({
        actorId: req.session.user.id,
        action: 'rating_anomaly.resolve',
        objectType: 'rating_anomaly',
        objectId: id,
        result: 'denied',
        reason: result.reason ?? 'not-open',
      }));
      return res.status(result.reason === 'missing' ? 404 : 409)
        .type('text/plain; charset=utf-8')
        .send(t(locale, `anomaly.error.${result.reason ?? 'not-open'}`));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
