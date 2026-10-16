// Закладки (F-03-04, S-30).
//
// Маршрут тонкий: разбор адреса, сессия, отдача вида. Гость уходит на вход с
// возвратом (R-SEC-08), вошедший видит свой список — и только свой (R-SEC-10).
//
// Страница личная, поэтому `noindex` всегда: список закладок в выдаче поисковика
// не нужен, а по ссылке он открывается целиком.
//
// Пагинация: страница за концом списка — последняя страница, а не пустая
// (EC-K6), иначе ссылка «дальше» вела бы в никуда.

import express from 'express';

import { layout } from '../view/layout.js';
import { libraryView } from '../view/library.js';
import { t, isLocale } from '../i18n/strings.js';
import { csrfToken } from '../services/auth/session.js';
import { LIBRARY_PAGE_SIZE } from '../services/tracking/library.js';
import { timezoneOf, todayIn } from '../services/timezone.js';

const rawHtml = (page) => page.__raw;

/**
 * @param {object} deps
 * @param {object} deps.library источник данных
 * @param {Function} deps.sessionMw
 * @param {object|null} [deps.progress] прогресс из кэша; без него у карточек нули
 * @param {object|null} [deps.subscriptions] состояние колокольчиков на карточках
 */
export function createLibraryRoutes({ library, sessionMw, progress = null, subscriptions = null }) {
  const router = express.Router({ strict: true });
  router.use('/:locale{/:rest}', sessionMw);

  router.get('/:locale/library', async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const user = req.session?.user ?? null;
    // Гость идёт на вход и возвращается обратно: закладки без входа показать
    // нечем, а пустая страница выглядит как «у вас ничего нет».
    if (!user) {
      return res.redirect(303, `/${locale}/login?next=${encodeURIComponent(`/${locale}/library`)}`);
    }

    try {
      const timezone = timezoneOf(req);
      const raw = String(req.query.page ?? '');
      const page = /^\d+$/.test(raw) ? Number(raw) : 1;

      const data = await library.list({
        userId: user.id,
        status: String(req.query.status ?? ''),
        sort: String(req.query.sort ?? ''),
        query: String(req.query.q ?? ''),
        page,
        limit: LIBRARY_PAGE_SIZE,
        today: todayIn(timezone),
        // Прогресс и «продолжить» приходят из кэша одним запросом на страницу,
        // а не считаются на каждую карточку (F-03-03 §9).
        progressOf: progress
          ? (seriesIds) => progress.forSeries({ userId: user.id, seriesIds, today: todayIn(timezone) })
          : null,
      });

      // Колокольчики карточек — одним запросом на страницу (F-03-07 §3).
      const subs = subscriptions
        ? await subscriptions.listOf(user.id, data.items.map((item) => item.seriesId))
        : null;

      return res.status(200).type('html').send(rawHtml(layout({
        locale,
        path: '/library',
        title: t(locale, 'library.title'),
        description: t(locale, 'library.description'),
        noindex: true,
        body: libraryView({ locale, library: data, csrf: csrfToken(req.session), subs }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
