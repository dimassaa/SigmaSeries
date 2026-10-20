// S-22 — восстановление пароля.
//
// Спецификация: docs/01-product/features/M1-identity.md F-01-04.
// Требования: R-SEC-01 (стойкость пароля), R-SEC-06 (ответ на заявку не
// зависит от существования аккаунта), R-SEC-07 (токен одноразовый, 30 минут,
// в базе только хеш), R-SEC-24 (личная страница не кэшируется), R-SEC-31
// (лимиты по классам), R-A11Y-11 (ошибка названа текстом).
// Границы: EC-A3 (просроченная ссылка — форма новой заявки),
// EC-A9 (смена пароля отзывает все сессии).
//
// Один адрес и пять состояний вместо пяти адресов: в реестре экран один
// (S-22), а состояние задаётся тем, что пришло в строке запроса.

import express from 'express';

import { layout } from '../view/layout.js';
import { resetView, headingKey } from '../view/reset.js';
import { isLocale, t } from '../i18n/strings.js';
import { verifyToken } from '../services/auth/register.js';
import { checkPasswordStrength, hashPassword, hashToken } from '../services/auth/password.js';
import { checkEmail, normalizeEmail } from '../services/auth/validate.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import * as limits from '../services/auth/limits.js';
import { ensureBrowserId } from '../services/mail/browser.js';
import { demoMailFor, linkFromBody } from '../services/mail/devbox.js';
// Таблицы стилей этой страницы: общая плюс нужные группам. Список
// берётся из `src/config/styles.js`, порядок подключения — оттуда же.
const STYLES = ['identity'];


/** Путь без локали: адрес S-22 из SCREENS. */
const PATH = '/password/reset';

/**
 * @param {object} deps
 * @param {object} deps.auth доступ к учётным записям
 * @param {Function} deps.sessionMw middleware сессий
 * @param {object} [deps.mailQueue] очередь писем (F-01-12)
 * @param {object} [deps.journal] журнал безопасности (F-01-04 §17)
 * @param {string} [deps.baseUrl] адрес приложения для ссылки в письме
 */
export function createResetRoutes({
  auth, sessionMw, mailQueue, mailMode = null, journal, baseUrl = '',
}) {
  const router = express.Router({ strict: true });
  router.use(`/:locale${PATH}`, sessionMw);

  /** Ссылка из письма: адрес приложения, путь и токен. */
  const link = (path, token) => `${baseUrl}/${path}?token=${encodeURIComponent(token)}`;

  router.get(`/:locale${PATH}`, async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    if (req.query.done === '1') return respond(res, 200, page(req, { state: 'done' }));

    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) return respond(res, 200, page(req, { state: 'request' }));

    try {
      const row = await auth.tokenByHash(hashToken(token));
      if (!resetTokenValid(row, token)) {
        return respond(res, 200, page(req, { state: 'stale' }));
      }
      return respond(res, 200, page(req, { state: 'form', token }));
    } catch (e) {
      return next(e);
    }
  });

  router.post(`/:locale${PATH}`, (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const body = req.body ?? {};
    if (!csrfValid(req.session, body.csrf)) {
      // Токен возвращается в форму: без этого человек, у которого протухла
      // сессия, потерял бы и ссылку, и её содержимое.
      const token = typeof body.token === 'string' ? body.token : '';
      return respond(res, 403, page(req, {
        state: token ? 'form' : 'request',
        token,
        error: t(locale, 'reset.error.csrf'),
      }));
    }

    return typeof body.token === 'string' && body.token
      ? changePassword(req, res, next)
      : requestLink(req, res, next);
  });

  /** Заявка на письмо. Отвечает одинаково для любого пригодного адреса. */
  async function requestLink(req, res, next) {
    const locale = req.params.locale;
    const email = normalizeEmail(req.body.email);
    const ip = clientIp(req);

    const problems = checkEmail(email);
    if (problems.length) {
      return respond(res, 400, page(req, {
        state: 'request', email, error: t(locale, 'reset.error.email'),
      }));
    }

    // Лимит проверяется до записи и считается по заявкам, а не по
    // отправленным письмам: иначе 429 выдавался бы только существующим
    // адресам и по нему они бы перебирались (R-SEC-06).
    const limited = limits.resetRequestLimited(email, ip);
    if (!limited.ok) {
      res.set('Retry-After', String(limited.retryAfter));
      return respond(res, 429, page(req, {
        state: 'request',
        email,
        error: t(locale, 'reset.error.tooMany', { seconds: limited.retryAfter }),
      }));
    }
    limits.recordResetRequest(email, ip);

    try {
      const browserId = ensureBrowserId(req, res);
      await sendLetter(email, locale, browserId);
      // Ответ не зависит от того, что нашлось по адресу: и «письмо ушло»,
      // и «аккаунта нет» читаются одинаково (R-SEC-06).
      return respond(res, 200, page(req, {
        state: 'sent',
        demoLink: await demoLink(req, res, browserId),
      }));
    } catch (e) {
      return next(e);
    }
  }

  /**
   * Выбирает письмо по адресу: ссылку на смену пароля или подтверждение.
   *
   * Для неподтверждённого адреса письмо подтверждения предусмотрено самой
   * фичей (F-01-04 §4): сброс такому аккаунту не выдаётся, но оставить
   * человека без письма нельзя.
   *
   * Активность проверяется до выдачи письма подтверждения, потому что
   * подтверждение адреса переводит аккаунт в активный (`confirmEmail`):
   * письмо забаненному сняло бы блокировку его же подтверждением.
   */
  async function sendLetter(email, locale, browserId = '') {
    const user = await auth.byEmail(email);
    if (!user || user.status !== 'active') return;

    if (user.email_confirmed) {
      const issued = await auth.newResetToken(email);
      if (issued) {
        await mailQueue?.enqueue({
          kind: 'password_reset',
          to: email,
          locale,
          link: link(`${locale}${PATH}`, issued.token),
          browserId,
        });
      }
      return;
    }
    const issued = await auth.newVerificationToken(email);
    if (issued) {
      await mailQueue?.enqueue({
        kind: 'email_verify',
        to: email,
        locale,
        link: link(`${locale}/verify`, issued.token),
        browserId,
      });
    }
  }

  /**
   * Уведомление о смене пароля (F-01-04 §4).
   *
   * Адрес берётся из базы по идентификатору владельца токена: в самом токене
   * адреса нет, а раньше его негде было взять — теперь `email_enc` заполнен
   * (DEC-029). В письме нет ни ссылки, ни приглашения войти: это сообщение о
   * том, что произошло, а не способ войти.
   */
  async function notifyPasswordChanged(userId, locale) {
    const owner = await auth.addressOf(userId);
    if (!owner) return;
    await mailQueue?.enqueue({ kind: 'password_changed', to: owner, locale });
  }

  /** Смена пароля по токену. */
  async function changePassword(req, res, next) {
    const locale = req.params.locale;
    const token = String(req.body.token);
    const password = String(req.body.password ?? '');

    try {
      const row = await auth.tokenByHash(hashToken(token));
      // Токен гасится только при успешной смене (F-01-04 §8), поэтому
      // проверка стоит и здесь, а не полагается на проверку при открытии
      // формы: между GET и POST ссылку мог использовать другой.
      if (!resetTokenValid(row, token)) {
        return respond(res, 200, page(req, { state: 'stale' }));
      }

      const problems = checkPasswordStrength(password);
      if (problems.length) {
        return respond(res, 400, page(req, { state: 'form', token, problems }));
      }

      const passwordHash = await hashPassword(password);
      await auth.resetPassword(row.user_id, passwordHash);
      const revoked = await auth.revokeSessions(row.user_id);

      // Письмо уходит после записи в журнал и не ждёт ответа: человек уже
      // сменил пароль, и задержка отправки уведомления его не касается.
      await notifyPasswordChanged(row.user_id, locale);

      // Журнал безопасности (F-01-04 §17, R-SEC-29): событие, идентификатор
      // запроса и число отозванных сессий. Адреса и секретов здесь быть не
      // может — список полей у журнала закрытый.
      journal.security({
        event: 'password_reset',
        requestId: req.requestId,
        user_id: row.user_id,
        sessions_revoked: revoked,
      });

      res.set('Cache-Control', 'no-store');
      return res.redirect(303, `/${locale}${PATH}?done=1`);
    } catch (e) {
      return next(e);
    }
  }

  /** Собирает документ: разметку состояния плюс оболочку. */
  /**
   * Ссылка демо-помощника (F-01-12 §4, H-51).
   *
   * Только в `devbox` и только для письма, созданного этим браузером.
   */
  async function demoLink(req, res, browserId) {
    if (!mailQueue?.forBrowser || !mailMode || !browserId) return '';
    if (await mailMode.current() !== 'devbox') return '';

    const letter = demoMailFor(await mailQueue.forBrowser(browserId), browserId);
    return letter ? linkFromBody(letter.body) ?? '' : '';
  }

  function page(req, ctx) {
    const locale = req.params.locale;
    const body = resetView({ locale, csrf: csrfToken(req.session), ...ctx });
    return layout({
      styles: STYLES,
      account: req.account,
      locale,
      path: PATH,
      title: `${t(locale, headingKey(ctx.state))} — ${t(locale, 'app.title')}`,
      description: t(locale, 'reset.lead'),
      body,
      noindex: true,
    });
  }

  return router;
}

/**
 * Токен принимается, только если он назначения `password_reset` и ещё годен.
 *
 * Без проверки вида токена ссылка подтверждения адреса меняла бы пароль:
 * и то и другое лежит в одной таблице.
 */
function resetTokenValid(row, token) {
  if (!row || row.kind !== 'password_reset') return false;
  return verifyToken(row, token).ok;
}

function respond(res, status, page) {
  res.set('X-Robots-Tag', 'noindex, follow');
  // R-SEC-24: в адресе смены пароля лежит токен, и кеш на общем компьютере
  // отдал бы его следующему человеку.
  res.set('Cache-Control', 'no-store');
  return res.status(status).type('html').send(page.__raw);
}

/** IP для лимитов: заголовок берётся только если приложение за прокси. */
function clientIp(req) {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
