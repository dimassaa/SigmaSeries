// S-19 — вход. И выход.
//
// Спецификация: docs/01-product/features/M1-identity.md F-01-03.
// Правила: R-SEC-02, R-SEC-05, R-SEC-06, R-SEC-08, R-SEC-31, R-SEC-34,
// R-A11Y-11 (ошибка названа текстом, связана с полем и объявляется).

import express from 'express';

import { respond, clientIp } from '../http/helpers.js';

import { layout } from '../view/layout.js';
import { signinView } from '../view/signin.js';
import { authenticate, decideAfterCredentials, safeReturnTo, sessionKind, sessionDurations } from '../services/auth/login.js';
import { csrfToken, csrfValid, noteSession } from '../services/auth/session.js';
import * as limits from '../services/auth/limits.js';
import { t, isLocale } from '../i18n/strings.js';
import { AUTH } from '../config/settings.js';
// Таблицы стилей этой страницы: общая плюс нужные группам. Список
// берётся из `src/config/styles.js`, порядок подключения — оттуда же.
const STYLES = ['identity'];


/**
 * Записать «наполовину доверенную» сессию и увести человека на второй фактор.
 *
 * В сессии лежит только то, что уже проверено паролем, — ровно до подтверждения
 * кода. Служебные разделы под таким флагом закрыты: иначе 2FA была бы вторым
 * полем формы.
 *
 * @param {object} req
 * @param {object} input
 * @param {object} input.user
 * @param {string} input.email
 * @param {string[]} input.roles
 * @param {string} input.kind
 * @param {boolean} input.configured настроена ли проверка
 * @returns {Promise<void>}
 */
async function beginTwoFactor(req, { user, email, roles, kind, configured }) {
  await regenerate(req);
  req.session.pendingTwoFactor = {
    userId: user.id,
    account: email,
    configured,
    user: {
      id: user.id,
      nickname: user.nickname,
      locale: user.locale,
      theme: user.theme,
      roles,
      kind,
      // Та же форма объекта сессии, что при простом входе: граница
      // «Зритель» — подтверждение адреса (M2 §2).
      confirmed: Boolean(user.email_confirmed),
    },
  };
}

export function createAuthRoutes({ auth, limitsApi = limits, sessionMw }) {
  const router = express.Router({ strict: true });
  router.use('/:locale{/:rest}', sessionMw);

  router.get('/:locale/login', (req, res, next) => {
    const locale = req.params.locale;
    // Языка «xx» не существует: адрес обещал бы один язык, а экран показал
    // другой — `t()` на незнакомом языке молча берёт словарь по умолчанию
    // (ADR-003). Для поисковика это два документа с одним содержанием.
    if (!isLocale(locale)) return next('route');
    return respond(res, 200, renderForm({
        account: req.account,
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
    if (!isLocale(locale)) return next('route');
    const body = req.body ?? {};
    const email = String(body.email ?? '').trim();
    const password = String(body.password ?? '');
    const returnTo = safeReturnTo(body.next);

    // CSRF проверяется до всего остального: без этого форма принимает
    // запросы с чужой страницы.
    if (!csrfValid(req.session, body.csrf)) {
      return respond(res, 403, renderForm({
          account: req.account,
        locale, csrf: csrfToken(req.session), values: { email },
        error: t(locale, 'signin.error.csrf'), returnTo,
      }));
    }

    // R-SEC-05, R-SEC-31: лимит по адресу сети. Проверяется до лимита по
    // аккаунту, потому что адрес — внешняя граница, а аккаунт неизвестен и не
    // проверен. Ответ тот же, что у задержки: 429 с Retry-After, без слов о
    // том, сколько аккаунтов перебирается.
    const ipWait = limitsApi.ipRetryAfter?.(clientIp(req)) ?? 0;
    if (ipWait > 0) {
      res.set('Retry-After', String(ipWait));
      return respond(res, 429, renderForm({
          account: req.account,
        locale, csrf: csrfToken(req.session), values: { email },
        error: t(locale, 'signin.error.tooMany', { seconds: ipWait }), returnTo,
      }));
    }

    // R-SEC-31: лимит по аккаунту отвечает 429 с Retry-After.
    const delay = limitsApi.delayFor(email);
    if (delay > 0) {
      const seconds = Math.ceil(delay / 1000);
      res.set('Retry-After', String(seconds));
      return respond(res, 429, renderForm({
          account: req.account,
        locale, csrf: csrfToken(req.session), values: { email },
        error: t(locale, 'signin.error.tooMany', { seconds }), returnTo,
      }));
    }

    // R-SEC-34: после трёх неудач форма требует невидимое решение задачи.
    if (limitsApi.needsProofOfWork(email) && !limitsApi.verifyChallenge(
      limitsApi.accountKey(email), body.pow,
    )) {
      return respond(res, 400, renderForm({
          account: req.account,
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
          account: req.account,
        locale, csrf: csrfToken(req.session), values: { email },
        error: t(locale, 'signin.error.credentials'), returnTo,
      }));
    }

    const decision = decideAfterCredentials(user, true);

    if (decision.action === 'blocked') {
      // Бан показывается только сейчас: пароль уже верен.
      limitsApi.recordFailure(email, clientIp(req));
      return respond(res, 403, renderForm({
          account: req.account,
        locale, csrf: csrfToken(req.session), values: { email },
        error: t(locale, 'signin.error.blocked', { reason: '' }), returnTo,
      }));
    }

    if (decision.action === 'delete_pending') {
      // Пароль уже верен, но полноценной сессии не заводится: экран выбора
      // (§4 «вход отменяет удаление после явного выбора») не должен давать
      // прав зрителя, иначе выбор можно было бы пропустить сторонней вкладкой.
      await regenerate(req);
      req.session.pendingDeletion = { userId: user.id };
      return res.redirect(303, `/${locale}/delete-pending`);
    }

    const roles = await auth.roles(user.id);
    const kind = sessionKind(roles);

    // R-SEC-04, DEC-015: служебная роль требует второго фактора.
    //
    // Сессия заводится, но не доверенная: в неё кладётся только то, что уже
    // проверено паролем, и ровно на этом экране. Служебные разделы под таким
    // флагом закрыты — иначе 2FA была бы вторым полем формы.
    //
    // Отказ здесь (как было до F-01-05) означал, что администратор не может
    // войти вовсе: страница S-72 и модерация для него просто не существуют.
    if (kind === 'staff') {
      const state = await auth.twoFactor(user.id);
      await beginTwoFactor(req, { user, email, roles, kind, configured: Boolean(state) });
      return res.redirect(303, `/${locale}${state ? '/2fa' : '/2fa/setup'}`);
    }

    // F-01-05 §4: код спрашивается у того, кто настроил проверку, — и
    // зритель тоже (решение автора, 21.10). DEC-015 делает проверку
    // обязательной для служебных ролей, но не отменяет её у того, кто выбрал
    // её сам: иначе включённая проверка ничего не значила бы.
    if (decision.action !== 'confirm_email') {
      const state = await auth.twoFactor(user.id);
      if (state) {
        await beginTwoFactor(req, { user, email, roles, kind, configured: true });
        return res.redirect(303, `/${locale}/2fa`);
      }
    }

    // R-SEC-02: идентификатор сессии меняется при входе, иначе он был бы
    // известен до входа и мог быть подделан заранее.
    await regenerate(req);

    // Служебной ветки здесь быть не может — она выше вернула редирект на 2FA.
    const durations = sessionDurations(kind === 'staff');
    req.session.user = {
      id: user.id,
      nickname: user.nickname,
      locale: user.locale,
      theme: user.theme,
      roles,
      kind,
      // Подтверждение адреса — граница «Зритель» (M2 §2): интерфейс решает по
      // нему, показывать ли кнопки зрителя, а право всё равно проверяет сервис.
      confirmed: Boolean(user.email_confirmed),
    };
    req.session.createdAt = Date.now();
    req.session.cookie.maxAge = durations.absolute;

    limitsApi.recordSuccess(email);
    await auth.recordLogin(user.id, new Date());
    // Сессия началась: устройство попадает в список S-32, а лишние сессии
    // аккаунта закрываются (F-01-03 §4, §5). Именно здесь, а не при отзыве:
    // у человека должно быть видно, откуда он вошёл.
    await noteSession(auth, req, user.id);

    const target = decision.action === 'confirm_email'
      ? `/${locale}/verify`
      : localized(locale, returnTo);
    res.redirect(303, target);
  });

  router.post('/:locale/logout', (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');
    // R-SEC-23: выход меняет состояние на сервере, поэтому токен обязателен.
    // Без проверки любую страницу со ссылкой на `/logout` могли бы выбить
    // человека из аккаунта — это тот же отказ в обслуживании, что и раньше,
    // только без блокировки пароля.
    if (!csrfValid(req.session, req.body?.csrf)) {
      return respond(res, 403, renderForm({
          account: req.account,
        locale, csrf: csrfToken(req.session), values: {},
        error: t(locale, 'signin.error.csrf'), returnTo: null,
      }));
    }

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


function renderForm(ctx) {
  return layout({
    styles: STYLES,
    account: ctx.account,
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

export { express };