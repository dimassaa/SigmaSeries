// Статус просмотра: приём запроса (F-03-01, правило (б) — подписка по H-70).
//
// Маршрут один и очень тонкий: проверить CSRF и гостя, применить статус,
// вернуть человека на страницу, откуда он нажал (POST → 303 → GET). Возврат
// именно туда важен: кнопка стоит на карточке сериала и в закладках, и после
// смены статуса человек должен остаться там, где был.

import express from 'express';

import { createRateLimiter } from '../services/limits.js';
import { csrfValid } from '../services/auth/session.js';
import { safeReturnTo } from '../services/auth/login.js';
import { STATUSES } from '../services/tracking/status.js';
import { isLocale, t } from '../i18n/strings.js';

/** `tracking.status_rate_per_min` (M3 §0): шестьдесят смен в минуту на зрителя. */
const RATE_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

/**
 * Счётчик по умолчанию — один на приложение.
 *
 * Подменяется в тестах: общий счётчик накапливал бы запросы от одного
 * прогона к следующему, и проверка лимита зависела бы от порядка тестов.
 */
const defaultLimiter = createRateLimiter({ limit: RATE_PER_MINUTE, windowMs: WINDOW_MS });

/**
 * @param {object} deps
 * @param {object} deps.status источник данных
 * @param {object} deps.series источник карточки: адрес сериала должен существовать
 * @param {Function} deps.sessionMw
 * @param {{allow: (key: string) => boolean, windowMs: number}} [deps.limiter]
 */
export function createStatusRoutes({ status, series, sessionMw, limiter = defaultLimiter, analytics = null }) {
  const router = express.Router({ strict: true });
  router.use('/:locale{/:rest}', sessionMw);

  router.post('/:locale/series/:slug/status', async (req, res, next) => {
    const { locale, slug } = req.params;
    if (!isLocale(locale)) return next('route');

    const back = backTo({ locale, slug, req });

    // Гость идёт на вход и возвращается сюда: R-SEC-08 требует вернуть человека
    // на то же место, а не на главную.
    if (!req.session?.user) return res.redirect(303, `/${locale}/login?next=${encodeURIComponent(back)}`);

    // Сессия без верного токена — это не «человек ошибся», а подделка или
    // протухшая вкладка. Ответ короткий: показывать здесь форму значило бы
    // объяснять человеку то, что он не может исправить.
    if (!csrfValid(req.session, req.body?.csrf)) {
      return res.status(403).type('text/plain; charset=utf-8')
        .send(`${t(locale, 'status.error.csrf')}\n\n${back}`);
    }

    if (!limiter.allow(String(req.session.user.id))) {
      return res.status(429)
        .set('Retry-After', String(Math.ceil(WINDOW_MS / 1000)))
        .type('text/plain; charset=utf-8')
        .send(t(locale, 'status.error.rate'));
    }

    const found = await series.bySlug(slug);
    if (!found) return res.status(404).type('text/plain; charset=utf-8').send(t(locale, 'status.error.missing'));

    const wanted = String(req.body?.status ?? '');
    const userId = req.session.user.id;

    // Пустое значение — это «Убрать из закладок»: отправлять отдельный флаг
    // было бы лишним, ведь в меню это один из пунктов наравне с остальными.
    if (wanted === '') {
      await status.remove({ userId, seriesId: found.id });
      // Статус меняет данные, поэтому событие пишет сервер (R-AN-05).
      await analytics?.write({
        name: 'status_set',
        props: { old: '', new: 'none' },
        userId,
      });
      return res.redirect(303, back);
    }

    // Неизвестное значение — ошибка вызывающего кода, а не человека: белый
    // список уже отсекает мусор из адреса, значит сюда пришло что-то чужое.
    if (!STATUSES.includes(wanted)) return res.status(400).type('text/plain; charset=utf-8').send('bad status');

    const result = await status.set({ userId, seriesId: found.id, status: wanted });
    // Снятый с публикации сериал (EC-T8): страница остаётся, статус прежний —
    // человек убирает его кнопкой «Убрать», а не сменой статуса.
    if (!result.ok) return res.redirect(303, back);

    await analytics?.write({
      name: 'status_set',
      props: { old: String(result.old ?? ''), new: wanted },
      userId,
    });
    return res.redirect(303, back);
  });

  return router;
}

/**
 * Адрес возврата: страница, откуда нажали.
 *
 * `view=library` — значит кнопка была в закладках, и возвращаться надо туда.
 * Значение из тела запроса не доверяется как путь: путь собирается здесь, из
 * локали и адреса сериала.
 */
function backTo({ locale, slug, req }) {
  return req.body?.view === 'library'
    ? `/${locale}/library`
    : `/${locale}/series/${slug}`;
}
