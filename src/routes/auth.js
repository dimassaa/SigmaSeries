// S-19 — вход. И выход.
//
// Спецификация: docs/01-product/features/M1-identity.md F-01-03.
// Правила: R-SEC-02, R-SEC-05, R-SEC-06, R-SEC-08, R-SEC-31, R-SEC-34,
// R-A11Y-11 (ошибка названа текстом, связана с полем и объявляется).

import express from 'express';

import { layout } from '../view/layout.js';
import { signinView } from '../view/signin.js';
import { authenticate, decideAfterCredentials, safeReturnTo, sessionKind, sessionDurations } from '../services/auth/login.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import * as limits from '../services/auth/limits.js';
import { t } from '../i18n/strings.js';
import { AUTH } from '../config/settings.js';

export function createAuthRoutes({ auth, limitsApi = limits, sessionMw }) {
  const router = express.Router({ strict: true });
  router.use('/:locale{/:rest}', sessionMw);

  router.get('/:locale/login', (req, res) => {
    const locale = req.params.locale;
    return respond(res, 200, renderForm({
      locale,
      csrf: csrfToken(req.session),
      challenge: limitsApi.needsProofOfWork(req.query.email ?? '')
        ? limitsApi.issueChallenge(limitsApi.accountKey(req.query.email ?? ''))
        : null,
      // Клиент обязан считать ту же сложность, что и сервер проверяет.
      // Без этого число подставляется в разметку, а сервер молча отвергает.
      powZeros: limitsApi.powZeros ?? AUTH.powZeros,
      values: {},
      error: null,
      returnTo: safeReturnTo(req.query.next),
    }));
  });

  router.post('/:locale/login', async (req, res, next) => {
    const locale = req.params.locale;
    const body = req.body ?? {};
    const email = String(body.email ?? '').trim();
    const password = String(body.password ?? '');
    const returnTo = safeReturnTo(body.next);

    // CSRF проверяется до всего остального: без этого форма принимает
    // запросы с чужой страницы.
    if (!csrfValid(req.session, body.csrf)) {
      return respond(res, 403, renderForm({
        locale, csrf: csrfToken(req.session), values: { email },
        error: t(locale, 'signin.error.csrf'), returnTo,
      }));
    }

    // R-SEC-31: лимит по IP отвечает 429 с Retry-After.
    const delay = limitsApi.delayFor(email);
    if (delay > 0) {
      const seconds = Math.ceil(delay / 1000);
      res.set('Retry-After', String(seconds));
      return respond(res, 429, renderForm({
        locale, csrf: csrfToken(req.session), values: { email },
        error: t(locale, 'signin.error.tooMany', { seconds }), returnTo,
      }));
    }

    // R-SEC-34: после трёх неудач форма требует невидимое решение задачи.
    if (limitsApi.needsProofOfWork(email) && !limitsApi.verifyChallenge(
      limitsApi.accountKey(email), body.pow,
    )) {
      return respond(res, 400, renderForm({
        locale, csrf: csrfToken(req.session), values: { email },
        challenge: limitsApi.issueChallenge(limitsApi.accountKey(email)),
        powZeros: limitsApi.powZeros ?? AUTH.powZeros,
        error: t(locale, 'signin.error.credentials'), returnTo,
      }));
    }

    const user = await auth.byEmail(email);
    const { ok } = await authenticate(email, password, user);

    if (!ok) {
      limitsApi.recordFailure(email, clientIp(req));
      // R-SEC-06: один ответ на «нет аккаунта» и «неверный пароль».
      return respond(res, 401, renderForm({
        locale, csrf: csrfToken(req.session), values: { email },
        error: t(locale, 'signin.error.credentials'), returnTo,
      }));
    }

    const decision = decideAfterCredentials(user, true);

    if (decision.action === 'blocked') {
      // Бан показывается только сейчас: пароль уже верен.
      limitsApi.recordFailure(email, clientIp(req));
      return respond(res, 403, renderForm({
        locale, csrf: csrfToken(req.session), values: { email },
        error: t(locale, 'signin.error.blocked', { reason: '' }), returnTo,
      }));
    }

    if (decision.action === 'delete_pending') {
      return respond(res, 409, renderForm({
        locale, csrf: csrfToken(req.session), values: { email },
        error: t(locale, 'signin.error.deletePending'), returnTo,
      }));
    }

    // R-SEC-02: идентификатор сессии меняется при входе, иначе он был бы
    // известен до входа и мог быть подделан заранее.
    await regenerate(req);

    const roles = await auth.roles(user.id);
    const kind = sessionKind(roles);
    const durations = sessionDurations(kind === 'staff');
    req.session.user = {
      id: user.id,
      nickname: user.nickname,
      locale: user.locale,
      theme: user.theme,
      roles,
      kind,
    };
    req.session.createdAt = Date.now();
    req.session.cookie.maxAge = durations.absolute;

    // Служебная роль требует второго фактора (DEC-015, R-SEC-04).
    if (kind === 'staff') {
      req.session.pendingStaff = true;
    }

    limitsApi.recordSuccess(email);
    await auth.recordLogin(user.id, new Date());

    const target = decision.action === 'confirm_email'
      ? `/${locale}/verify`
      : localized(locale, returnTo);
    res.redirect(303, target);
  });

  router.post('/:locale/logout', (req, res) => {
    const locale = req.params.locale;
    // Отзыв на сервере плюс очистка cookie: иначе идентификатор продолжит
    // работать, пока не истечёт срок.
    req.session.destroy(() => {
      res.clearCookie('sid', { httpOnly: true, sameSite: 'lax', path: '/' });
      res.redirect(303, `/${locale}/`);
    });
  });

  return router;
}

/**
 * Служебные страницы помечаются заголовком, а не только мета-тегом: поисковик
 * читает заголовок надёжнее, а мета-тег легко потерять при переносе вёрстки.
 */
/**
 * Приводит адрес возврата к виду с локалью ровно один раз.
 *
 * Адрес может прийти уже с префиксом — форма его кладёт из строки запроса,
 * — и простое приписывание давало «/ru/ru/calendar».
 */
function localized(locale, path) {
  const p = path === '/' ? '/' : path;
  if (p === `/${locale}` || p === `/${locale}/`) return p;
  if (p.startsWith(`/${locale}/`)) return p;
  return `/${locale}${p}`;
}

function respond(res, status, page) {
  res.set('X-Robots-Tag', 'noindex, follow');
  // R-SEC-24: личная страница не кэшируется. Иначе на общем компьютере
  // следующий человек увидит из кеша заполненную форму и адрес из неё.
  res.set('Cache-Control', 'no-store');
  return res.status(status).type('html').send(page.__raw);
}

function renderForm(ctx) {
  return layout({
    locale: ctx.locale,
    path: '/login',
    title: `${t(ctx.locale, 'signin.title')} — ${t(ctx.locale, 'app.title')}`,
    description: t(ctx.locale, 'signin.heading'),
    noindex: true,
    body: signinView(ctx),
  });
}

function regenerate(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((e) => (e ? reject(e) : resolve()));
  });
}

/** IP для лимитов: заголовок берётся только если приложение за прокси. */
function clientIp(req) {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

export { express };