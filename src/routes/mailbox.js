// S-84 — «Почтовый ящик разработчика» (F-01-12).
//
// Страница нужна не для красоты: без неё режим `devbox` включить нечем, а
// без него на защите без интернета нечего показать. Адрес — админский, и
// не-админ получает 404, а не 403: существование страницы выдавать нельзя
// (F-01-12 §18).
//
// Бейдж «Письма не отправляются» — требование EC-A23 для режима, включённого
// по ошибке: человек должен увидеть это здесь и на старте сервера.

import express from 'express';

import { respond } from '../http/helpers.js';

import { layout } from '../view/layout.js';
import { mailboxView } from '../view/mailbox.js';
import { isLocale, t } from '../i18n/strings.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { devboxBadge, linkFromBody } from '../services/mail/devbox.js';
import { switchMode } from '../services/mail/mode.js';
// Таблицы стилей этой страницы: общая плюс нужные группам. Список
// берётся из `src/config/styles.js`, порядок подключения — оттуда же.
const STYLES = ['identity'];


const BASE = '/admin/mailbox';

/**
 * @param {object} deps
 * @param {object} deps.auth хранилище учётных записей
 * @param {Function} deps.sessionMw middleware сессий
 * @param {object} deps.mailQueue очередь писем (список и очистка)
 * @param {object} deps.mailMode текущий режим и переключение
 * @param {object} [deps.journal] журнал безопасности
 */
export function createMailboxRoutes({ auth, sessionMw, mailQueue, mailMode, journal }) {
  const router = express.Router({ strict: true });
  router.use('/:locale{/:rest}', sessionMw);

  /**
   * Только админ.
   *
   * Гость и не-админ получают 404 — один и тот же ответ на обоих. Ответ 403
   * подтверждал бы, что страница есть, и различал бы роли там, где различать
   * их нечего (F-01-12 §18).
   *
   * `next('router')` выходит из маршрутизатора в приложение, где ниже стоит
   * общий обработчик 404: страницу отрисовывает он, а не этот маршрут.
   */
  const adminOnly = (req, res, next) => {
    const roles = req.session.user?.roles ?? [];
    if (!roles.includes('admin')) return next('router');
    return next();
  };

  router.get(`/:locale${BASE}`, adminOnly, async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const [letters, mode] = await Promise.all([
      mailQueue.listing(),
      mailMode.current(),
    ]);

    // Письмо открывается по токену из его тела: отдельного идентификатора в
    // ссылке нет, и заводить его только ради страницы незачем.
    const wanted = typeof req.query.token === 'string' ? req.query.token : '';
    const opened = wanted
      ? (letters.find((row) => linkFromBody(row.body)?.includes(wanted)) ?? null)
      : null;

    return respond(res, 200, layout({
      styles: STYLES,
      account: req.account,
      locale,
      path: BASE,
      title: `${t(locale, 'mailbox.title')} — ${t(locale, 'app.title')}`,
      description: t(locale, 'mailbox.lead'),
      noindex: true,
      theme: req.session.user?.theme,
      body: mailboxView({
        locale,
        csrf: csrfToken(req.session),
        letters,
        mode,
        badge: devboxBadge(mode),
        opened: opened ? { ...opened, link: linkFromBody(opened.body) } : null,
        error: null,
      }),
    }));
  });

  /**
   * Переключение режима (F-01-12 §8(в), R-SEC-12).
   *
   * Повторный пароль обязателен: режим решает, уходят ли письма наружу, и
   * переключение без пароля лишило бы человека подтверждения адреса.
   */
  router.post(`/:locale${BASE}`, adminOnly, async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const user = req.session.user;
    const body = req.body ?? {};
    if (!csrfValid(req.session, body.csrf)) {
      return respond(res, 403, await page(req, locale, t(locale, 'settings.error.csrf')));
    }

    const verdict = await switchMode({
      current: () => mailMode.current(),
      change: (value, changedBy) => mailMode.change(value, user.id ?? changedBy),
      verify: () => auth.verifyCurrent(user.id, String(body.password ?? '')),
      next: body.next === 'smtp' ? 'smtp' : 'devbox',
    });

    if (!verdict.ok) {
      const error = verdict.reason === 'same'
        ? t(locale, 'mailbox.mode.same')
        : t(locale, 'mailbox.mode.password');
      return respond(res, 400, await page(req, locale, error));
    }

    journal?.security({
      event: 'mail_mode_changed',
      requestId: req.requestId,
      user_id: user.id,
    });
    return res.redirect(303, `/${locale}${BASE}`);
  });

  /** Страница с сообщением об ошибке. */
  async function page(req, locale, error) {
    const [letters, mode] = await Promise.all([
      mailQueue.listing(),
      mailMode.current(),
    ]);
    return layout({
      styles: STYLES,
      account: req.account,
      locale,
      path: BASE,
      title: `${t(locale, 'mailbox.title')} — ${t(locale, 'app.title')}`,
      description: t(locale, 'mailbox.lead'),
      noindex: true,
      theme: req.session.user?.theme,
      body: mailboxView({
        locale,
        csrf: csrfToken(req.session),
        letters,
        mode,
        badge: devboxBadge(mode),
        opened: null,
        error,
      }),
    });
  }

  return router;
}
