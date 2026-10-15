// Отметки серий: приём запроса (F-03-02).
//
// Четыре формы к одной сущности: одна серия, весь сезон, «все до этой» и
// отмена. Все — POST с CSRF и проверкой сессии, потому что отметка пишет в базу
// от имени человека (R-SEC-23, R-SEC-08).
//
// Отказ «серия не вышла» возвращается на страницу с сообщением и датой выхода
// (EC-T2): человек должен понять, что кнопка работает и серия просто ещё не
// вышла, а не гадать, где он ошибся.

import express from 'express';

import { createRateLimiter } from '../services/limits.js';
import { csrfValid } from '../services/auth/session.js';
import { isLocale, t } from '../i18n/strings.js';
import { timezoneOf, todayIn } from '../services/timezone.js';

/** `tracking.marks_rate_per_min` (M3 §0): сто двадцать отметок в минуту. */
const RATE_PER_MINUTE = 120;
const WINDOW_MS = 60_000;

const defaultLimiter = createRateLimiter({ limit: RATE_PER_MINUTE, windowMs: WINDOW_MS });

export function createMarkRoutes({ marks, series, sessionMw, limiter = defaultLimiter }) {
  const router = express.Router({ strict: true });
  router.use('/:locale{/:rest}', sessionMw);

  router.post('/:locale/series/:slug/mark', async (req, res, next) => {
    const { locale, slug } = req.params;
    if (!isLocale(locale)) return next('route');

    const back = `/${locale}/series/${slug}/seasons/${number(req.body?.season)}`;
    if (!req.session?.user) {
      return res.redirect(303, `/${locale}/login?next=${encodeURIComponent(`/${locale}/series/${slug}`)}`);
    }
    if (!csrfValid(req.session, req.body?.csrf)) {
      return res.status(403).type('text/plain; charset=utf-8')
        .send(`${t(locale, 'mark.error.csrf')}\n\n${back}`);
    }
    if (!limiter.allow(String(req.session.user.id))) {
      return res.status(429)
        .set('Retry-After', String(Math.ceil(WINDOW_MS / 1000)))
        .type('text/plain; charset=utf-8')
        .send(t(locale, 'mark.error.rate'));
    }

    const found = await series.bySlug(slug);
    if (!found) return res.status(404).type('text/plain; charset=utf-8').send(t(locale, 'mark.error.missing'));

    const today = todayIn(timezoneOf(req));
    const userId = req.session.user.id;
    const action = String(req.body?.action ?? '');

    try {
      if (action === 'episode') {
        const result = await marks.setMark({
          userId,
          // Идентификатор, а не номер: серия 1 есть в каждом сезоне, а строка
          // в базе одна. Номер нужен только для «все до этой».
          episodeId: number(req.body?.episodeId),
          on: String(req.body?.on) === '1',
          today,
        });
        if (!result.ok && result.reason === 'not-aired') {
          // Отказ с датой: страница показывает «Серия выйдет {дата}».
          return res.redirect(303, `${back}?mark=soon&date=${encodeURIComponent(result.date ?? '')}`);
        }
        if (!result.ok) return res.redirect(303, `${back}?mark=${result.reason}`);
        return res.redirect(303, `${back}?mark=ok`);
      }

      if (action === 'season') {
        const result = await marks.markSeason({ userId, seasonId: number(req.body?.seasonId), today });
        if (!result.ok) return res.redirect(303, `${back}?mark=${result.reason}`);
        return res.redirect(303, `${back}?mark=done&marked=${result.marked}&batch=${result.batchId}`);
      }

      if (action === 'upto') {
        const result = await marks.markUpTo({
          userId,
          seriesId: found.id,
          season: number(req.body?.season),
          episode: number(req.body?.episode),
          today,
        });
        if (!result.ok) return res.redirect(303, `${back}?mark=${result.reason}`);
        return res.redirect(303, `${back}?mark=done&marked=${result.marked}&batch=${result.batchId}`);
      }

      if (action === 'undo') {
        await marks.undo({ userId, batchId: number(req.body?.batch), today });
        return res.redirect(303, `${back}?mark=undone`);
      }

      return res.status(400).type('text/plain; charset=utf-8').send('bad action');
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

function number(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : 0;
}