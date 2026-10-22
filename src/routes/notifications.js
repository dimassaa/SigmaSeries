// Страница уведомлений и действия над ними (F-03-09, S-31).
//
// Маршрут тонкий: сессия, CSRF, действие, возврат на ту же страницу ленты —
// с номером страницы и фильтром, иначе «прочитать» на третьей странице
// выкидывало бы человека на первую.

import express from 'express';

import { layout } from '../view/layout.js';
import { notificationsView } from '../view/notification.js';
import { csrfValid, csrfToken } from '../services/auth/session.js';
import { isLocale, t } from '../i18n/strings.js';
import { todayIn } from '../services/timezone.js';
// Таблицы стилей этой страницы: общая плюс нужные группам. Список
// берётся из `src/config/styles.js`, порядок подключения — оттуда же.
const STYLES = ['notifications'];


/** Категории, которые можно выбрать фильтром. */
const CATEGORIES = ['release', 'moderation', 'reply', 'service'];

const rawHtml = (page) => page.__raw;

/**
 * @param {object} deps
 * @param {any} deps.feed источник данных ленты
 * @param {import('express').RequestHandler[]} deps.sessionMw
 */
export function createNotificationRoutes({ feed, sessionMw }) {
  const router = express.Router({ strict: true });
  router.use('/:locale{/:rest}', sessionMw);

  router.get('/:locale/notifications', async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    // Госто лента недоступна: она целиком про чьи-то личные записи, и
    // приглашение войти честнее пустого списка (R-SEC-08).
    if (!req.session?.user) {
      return res.redirect(303, `/${locale}/login?next=${encodeURIComponent(`/${locale}/notifications`)}`);
    }

    try {
      const wanted = String(req.query.category ?? '');
      const category = CATEGORIES.includes(wanted) ? wanted : null;
      const page = Number(req.query.page) || 1;

      const data = await feed.feed({
        userId: req.session.user.id,
        page,
        category,
        today: todayIn(req.session.user.timezone),
      });
      const unread = await feed.unreadCount(req.session.user.id);

      return res.status(200).type('html').send(rawHtml(layout({
        styles: STYLES,
        account: req.account,
        locale,
        path: '/notifications',
        title: t(locale, 'notifications.title'),
        description: t(locale, 'notifications.description'),
        noindex: true,
        body: notificationsView({
          locale,
          feed: data,
          csrf: csrfToken(req.session),
          unread,
        }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  /**
   * Счётчик непрочитанных для опроса (F-03-09 §8а).
   *
   * Отдельный адрес нужен, потому что обновлять красную точку, не перезагружая
   * страницу, иначе нечем. Ответ маленький, помечается `no-store`: счётчик,
   * закэшированный браузером, показывал бы прочитанное как непрочитанное.
   */
  router.get('/:locale/notifications/count', async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');
    if (!req.session?.user) return next('router');

    try {
      const unread = await feed.unreadCount(req.session.user.id);
      res.set('Cache-Control', 'no-store');
      return res.status(200).type('application/json').send(JSON.stringify({ unread }));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:locale/notifications', async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    if (!req.session?.user) {
      return res.redirect(303, `/${locale}/login?next=${encodeURIComponent(`/${locale}/notifications`)}`);
    }
    if (!csrfValid(req.session, req.body?.csrf)) {
      return res.status(403).type('text/plain; charset=utf-8')
        .send(`${t(locale, 'notifications.error.csrf')}\n`);
    }

    const back = backTo({ locale, req });
    const userId = req.session.user.id;
    const id = Number(req.body?.id);

    try {
      switch (String(req.body?.action ?? '')) {
        case 'read-all':
          await feed.readAll(userId);
          break;
        case 'read':
          await feed.setRead({ userId, id, read: true });
          break;
        case 'unread':
          await feed.setRead({ userId, id, read: false });
          break;
        case 'remove':
          await feed.remove({ userId, id });
          break;
        default:
          // Неизвестное действие — ошибка вызывающего кода, а не человека:
          // форма всегда присылает одно из четырёх.
          return res.status(400).type('text/plain; charset=utf-8')
            .send(`${t(locale, 'notifications.error.action')}\n`);
      }
      return res.redirect(303, back);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/** Адрес возврата: та же страница ленты, тот же фильтр, та же страница. */
function backTo({ locale, req }) {
  const params = new URLSearchParams();
  const page = Number(req.body?.page) || 1;
  if (page > 1) params.set('page', String(page));
  if (req.body?.category) params.set('category', String(req.body.category));

  const query = params.toString();
  return `/${locale}/notifications${query ? `?${query}` : ''}`;
}
