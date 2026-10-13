// Регистрация (S-20) и подтверждение email (S-21).
//
// Спецификация: docs/01-product/features/M1-identity.md F-01-01, F-01-02.
// Требования: R-DES-34 (длинная форма разбита на шаги с прогрессом),
// R-SEC-06 (одинаковый ответ для занятого и свободного адреса),
// R-SEC-07 (токен одноразовый, в базе только хеш), R-SEC-13 (валидация по
// схеме на сервере), R-SEC-31 (лимиты по адресу сети).
// Edge cases: EC-A1 (гонка на уникальном индексе), EC-A2 (подтверждение на
// другом устройстве — отсюда опрос страницы), EC-A4 (токен не гасится GET —
// почтовые сканеры открывают ссылки сами), EC-A5 (ник занят одновременно),
// EC-A16 (растущая сложность невидимой проверки).

import express from 'express';

import { layout } from '../view/layout.js';
import { registerView, verifyView } from '../view/register.js';
import {
  decideRegistration,
  verifyToken,
  resendAllowed,
} from '../services/auth/register.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { hashToken } from '../services/auth/password.js';
import * as limits from '../services/auth/limits.js';
import { t } from '../i18n/strings.js';
import { ensureBrowserId } from '../services/mail/browser.js';
import { demoMailFor, linkFromBody } from '../services/mail/devbox.js';

/**
 * @param {object} deps
 * @param {object} deps.auth хранилище учётных записей
 * @param {Function} deps.sessionMw middleware сессий
 * @param {{enqueue:Function}} [deps.mailQueue] очередь писем (F-01-12)
 * @param {object} [deps.limitsApi] подмена счётчиков в тестах
 * @param {string} [deps.baseUrl] адрес приложения для ссылки в письме
 */
export function createRegisterRoutes({
  auth, sessionMw, mailQueue, mailMode = null, limitsApi = limits, baseUrl = '',
}) {
  const router = express.Router({ strict: true });
  router.use('/:locale{/:rest}', sessionMw);

  /** Ссылка из письма: адрес приложения, путь и токен. */
  const link = (path, token) => `${baseUrl}/${path}?token=${encodeURIComponent(token)}`;

  /**
   * Шаг 1 с задачей невидимой проверки.
   *
   * Определён здесь, а не рядом с остальной разметкой, потому что счётчики
   * берутся из `limitsApi`: с подменёнными счётчиками в тестах страница
   * иначе показывала бы сложность одного модуля, а проверялась бы по
   * другому.
   */
  const renderStep1 = (req, opts = {}) => {
    const locale = req.params.locale;
    const ip = clientIp(req);
    // Решение о задаче берётся то же, что и при проверке, если оно уже
    // принято. Пересчёт после записи попытки поднял бы сложность против
    // той, с которой задача выдана, и браузер считал бы не ту задачу.
    const pow = opts.pow ?? limitsApi.registrationChallenge(ip);
    // `opts.challenge` — готовая строка задачи из ветки отказа. Без неё
    // задача выдаётся сейчас; без задачи вообще остаётся null.
    const issued = opts.challenge
      ?? (pow.required ? limitsApi.issueChallenge(limitsApi.registrationKey(ip), pow.zeros) : null);

    return layout({
      locale,
      path: '/register',
      title: `${t(locale, 'register.title')} — ${t(locale, 'app.title')}`,
      description: t(locale, 'register.heading'),
      noindex: true,
      body: registerView({
        locale,
        step: 1,
        steps: 3,
        csrf: csrfToken(req.session),
        challenge: issued,
        zeros: pow.zeros,
        values: opts.values ?? {},
        problems: opts.problems ?? {},
        error: opts.error ?? null,
      }),
    });
  };

  // ─── Шаг 1: данные ─────────────────────────────────────────────────────────

  router.get('/:locale/register', (req, res) => {
    return respond(res, 200, renderStep1(req));
  });

  /**
   * Проверка занятости ника на лету (F-01-01 §9).
   *
   * Отдельный адрес, а не поле в ответе регистрации: иначе каждое нажатие
   * «создать аккаунт» с занятым ником стоило бы полной регистрации.
   */
  router.get('/:locale/register/nick', async (req, res, next) => {
    const locale = req.params.locale;
    if (limitsApi.nicknameCheckLimited(clientIp(req))) {
      res.set('Retry-After', '60');
      return res.status(429).json({ error: 'rate_limited' });
    }
    limitsApi.recordNicknameCheck(clientIp(req));
    try {
      const free = await auth.nicknameFree(req.query.nick ?? '');
      return res.json({ free });
    } catch (e) {
      return next(e);
    }
  });

  router.post('/:locale/register', async (req, res, next) => {
    const locale = req.params.locale;
    const body = req.body ?? {};
    const ip = clientIp(req);

    if (!csrfValid(req.session, body.csrf)) {
      return respond(res, 403, renderStep1(req, {
        error: t(locale, 'register.error.csrf'), values: pick(body),
      }));
    }

    // R-SEC-31: не больше пяти успешных регистраций с адреса в час.
    // Стена стоит по успехам, а не по попыткам: иначе пять неудачных
    // регистраций закрыли бы человеку регистрацию на час.
    if (limitsApi.registrationLimited(ip)) {
      res.set('Retry-After', '3600');
      return respond(res, 429, renderStep1(req, {
        error: t(locale, 'register.error.tooMany'), values: pick(body),
      }));
    }

    // Попытка считается до всех проверок: иначе по сложности задачи и по
    // времени ответа определяется, какие адреса уже заняты (R-SEC-06).
    const attempts = limitsApi.registrationAttempts(ip);
    limitsApi.recordRegistrationAttempt(ip);

    // EC-A16: после трёх успешных регистраций с адреса включается
    // невидимая проверка, и сложность растёт с каждой следующей.
    const pow = limitsApi.registrationChallenge(ip, Date.now(), attempts);

    let decision;
    try {
      decision = await decideRegistration(
        {
          email: body.email,
          nickname: body.nickname,
          password: body.password,
          consent: body.consent === 'on' || body.consent === 'true',
          locale,
          theme: req.session.theme ?? 'dark',
          timezone: body.timezone,
        },
        {
          nicknameFree: (n) => auth.nicknameFree(n),
          emailFree: (e) => auth.emailFree(e),
        },
      );
    } catch (e) {
      return next(e);
    }

    if (!decision.ok) {
      const error = decision.code === 'consent_required'
        ? t(locale, 'register.error.consent')
        : t(locale, 'register.error.fields');
      return respond(res, 422, renderStep1(req, {
        error, values: pick(body), problems: decision.problems, pow,
      }));
    }

    if (pow.required && !limitsApi.verifyChallenge(
      limitsApi.registrationKey(ip), body.pow,
    )) {
      // Задача выдаётся заново: решение для прошлой задачи не подходит,
      // и без новой задачи форма осталась бы непроходимой.
      return respond(res, 400, renderStep1(req, {
        error: t(locale, 'register.error.fields'),
        values: pick(body),
        challenge: limitsApi.issueChallenge(limitsApi.registrationKey(ip), pow.zeros),
        pow,
      }));
    }

    try {
      if (decision.emailTaken) {
        // Ответ страницы тот же, но письмо другое: владельцу занятого
        // адреса предлагают восстановить пароль, а не «регистрация
        // удалась» (R-SEC-06). Успехом это не считается — человек
        // ничего не создал, и стена за это наказывать не должна.
        await mailQueue?.enqueue({
          kind: 'email_taken',
          to: decision.fields.email,
          locale,
          browserId: ensureBrowserId(req, res),
        });
      } else {
        await auth.createUser(decision.fields);
        limitsApi.recordRegistration(ip);
        await mailQueue?.enqueue({
          kind: 'email_verify',
          to: decision.fields.email,
          locale,
          link: link(`${locale}/verify`, decision.token),
          browserId: ensureBrowserId(req, res),
        });
      }
    } catch (e) {
      // Гонка по уникальном�� индексу (EC-A1, EC-A5) приходит сюда как
      // ошибка базы. Наружу уходит тот же нейтральный шаг 2, что и всегда:
      // по коду ответа иначе определяется, что адрес уже занят.
      if (!isDuplicate(e)) throw e;
    }

    await regenerate(req);
    req.session.pendingUser = {
      email: decision.fields.email,
      nick: decision.fields.nickname,
    };
    return res.redirect(303, `/${locale}/register/confirm`);
  });

  // ─── Шаг 2: проверьте почту ────────────────────────────────────────────────

  router.get('/:locale/register/confirm', async (req, res) => {
    const locale = req.params.locale;
    const pending = req.session.pendingUser;
    if (!pending) {
      // Человек закрыл вкладку и вернулся позже: показываем начало
      // регистрации, а не шаг с пустым адресом. Пустой адрес читается как
      // «письмо ушло неизвестно куда», и человек зря ждёт.
      return res.redirect(303, `/${locale}/register`);
    }
    return respond(res, 200, renderConfirm(req, pending, {
      demoLink: await demoLink(req, res, mailQueue, mailMode),
    }));
  });

  /**
   * Опрос состояния (EC-A2).
   *
   * Ссылка открыта на другом устройстве — исходная страница должна узнать
   * об этом сама. Ответ касается только адреса из своей сессии, чужих он
   * не раскрывает.
   */
  router.get('/:locale/register/status', async (req, res, next) => {
    const pending = req.session.pendingUser;
    if (!pending) return res.json({ confirmed: false });
    try {
      const user = await auth.byEmail(pending.email);
      return res.json({ confirmed: Boolean(user?.email_confirmed) });
    } catch (e) {
      return next(e);
    }
  });

  router.post('/:locale/register/resend', async (req, res, next) => {
    const locale = req.params.locale;
    const pending = req.session.pendingUser;
    if (!csrfValid(req.session, req.body?.csrf)) {
      return respond(res, 403, renderConfirm(req, pending ?? {}, {
        error: t(locale, 'register.error.csrf'),
        demoLink: await demoLink(req, res, mailQueue, mailMode),
      }));
    }
    if (!pending) return res.redirect(303, `/${locale}/register`);

    // Пауза считается от последней отправки этому же адресу: смена адреса
    // сбрасывает её, потому что это другой адресат.
    const last = req.session.lastSentAt?.[pending.email];
    const cooldown = resendAllowed(last);
    // Счётчик по адресу, а не по сессии: новую сессию заводит кто угодно
    // и «не больше пяти писем в час» иначе обходится перезапуском браузера
    // (F-01-01 §9, F-01-02 §9).
    const hourly = limitsApi.resendHourly(pending.email);
    if (!cooldown.ok || !hourly.ok) {
      const retryAfter = Math.max(cooldown.retryAfter, hourly.retryAfter);
      res.set('Retry-After', String(retryAfter));
      return respond(res, 429, renderConfirm(req, pending, {
        error: t(locale, 'register.error.cooldown', { seconds: retryAfter }),
        demoLink: await demoLink(req, res, mailQueue, mailMode),
      }));
    }

    try {
      const fresh = await auth.newVerificationToken(pending.email);
      if (fresh) {
        await mailQueue?.enqueue({
          kind: 'email_verify',
          to: pending.email,
          locale,
          link: link(`${locale}/verify`, fresh.token),
          browserId: ensureBrowserId(req, res),
        });
        limitsApi.recordResend(pending.email);
      }
      req.session.lastSentAt = { ...(req.session.lastSentAt ?? {}), [pending.email]: Date.now() };
    } catch (e) {
      return next(e);
    }

    // Ответ тот же, есть аккаунт или нет: по нему иначе перебираются адреса.
    return respond(res, 200, renderConfirm(req, pending, {
      sent: true,
      demoLink: await demoLink(req, res, mailQueue, mailMode),
    }));
  });

  // ─── Подтверждение (S-21) ───────────────────────────────────────────────────

  /**
   * GET только показывает страницу.
   *
   * Токен не гасится запросом: почтовые сканеры и мессенджеры открывают
   * ссылки автоматически, и подтверждение по GET сожгло бы токен раньше
   * времени (EC-A4, F-01-02 правило (а)). Действие — только POST.
   */
  router.get('/:locale/verify', (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    // Без токена кнопки нет: нажатие всё равно кончилось бы «ссылка
    // устарела», а кнопка, которая не может сработать, вводит в заблуждение.
    // Ссылка без параметра — это ссылка обрезанная или устаревшая (EC-A3).
    return respond(res, 200, renderVerify(req, { token, state: token ? 'await' : 'stale' }));
  });

  router.post('/:locale/verify', async (req, res, next) => {
    const locale = req.params.locale;
    const body = req.body ?? {};

    if (!csrfValid(req.session, body.csrf)) {
      return respond(res, 403, renderVerify(req, { state: 'error' }));
    }

    let row;
    try {
      row = await auth.tokenByHash(safeHash(body.token));
    } catch (e) {
      return next(e);
    }

    const verdict = verifyToken(row, body.token);

    if (verdict.alreadyConfirmed) {
      // Отдельное состояние, а не «устарело»: человеку нужен вход, а не
      // новое письмо, которого он не просил (F-01-02 §5).
      return respond(res, 200, renderVerify(req, { state: 'already' }));
    }
    if (!verdict.ok) {
      // Наружу один ответ на «просрочен» и «неверен»: по формулировке
      // ответа иначе подбирается токен (F-01-02 §5).
      return respond(res, 400, renderVerify(req, { state: 'stale' }));
    }

    const userId = row.user_id ?? row.userId;
    try {
      await auth.confirmEmail(userId);
    } catch (e) {
      return next(e);
    }

    // Адрес из сессии сохраняется до смены идентификатора: восстановить его
    // из базы нельзя — он хранится шифром и слепым индексом. Без этого
    // страница шага 2 в другой вкладке того же браузера не узнала бы о
    // подтверждении (EC-A2).
    const pending = req.session.pendingUser;

    // R-SEC-02: идентификатор сессии меняется при входе.
    await regenerate(req);
    req.session.user = {
      id: userId,
      nickname: row.nickname,
      locale: row.locale ?? locale,
      theme: row.theme,
      roles: [],
      // Ролей у свежего аккаунта нет по построению: регистрация их не
      // создаёт (проверяется тестом), поэтому вид сессии всегда зрительский.
      // Поле заполняется здесь, чтобы у объекта сессии была одна форма на
      // оба входа — вход и регистрацию. Ровно его отсутствия не хватило,
      // чтобы вовремя заметить дыру со служебной ролью.
      kind: 'viewer',
    };
    req.session.createdAt = Date.now();
    if (pending) req.session.pendingUser = pending;

    return res.redirect(303, `/${locale}/`);
  });

  return router;
}

// ─── Разметка страниц ────────────────────────────────────────────────────────

/**
 * Ссылка демо-помощника (F-01-12 §4, H-51).
 *
 * Показывается только в режиме `devbox` и только для письма, созданного этим
 * же браузером: подсказка, открывающая чужие письма, была бы дырой рядом с
 * формой входа.
 */
async function demoLink(req, res, mailQueue, mailMode) {
  if (!mailQueue?.forBrowser || !mailMode) return '';
  if (await mailMode.current() !== 'devbox') return '';

  const browserId = ensureBrowserId(req, res);
  const letter = demoMailFor(await mailQueue.forBrowser(browserId), browserId);
  return letter ? linkFromBody(letter.body) ?? '' : '';
}

function renderConfirm(req, pending, opts = {}) {
  const locale = req.params.locale;
  return layout({
    locale,
    path: '/register',
    description: t(locale, 'register.step2.title'),
    title: `${t(locale, 'register.step2.title')} — ${t(locale, 'app.title')}`,
    noindex: true,
    body: registerView({
      locale,
      step: 2,
      steps: 3,
      csrf: csrfToken(req.session),
      pending,
      sent: opts.sent ?? false,
      error: opts.error ?? null,
      statusUrl: `/${locale}/register/status`,
      nextUrl: `/${locale}/`,
      demoLink: opts.demoLink ?? '',
    }),
  });
}

function renderVerify(req, state) {
  const locale = req.params.locale;
  const titles = {
    await: 'verify.title',
    stale: 'verify.stale.title',
    already: 'verify.already.title',
    error: 'error.generic.title',
  };
  return layout({
    locale,
    path: '/verify',
    title: `${t(locale, titles[state.state] ?? 'verify.title')} — ${t(locale, 'app.title')}`,
    description: t(locale, 'verify.text'),
    noindex: true,
    body: verifyView({
      locale, csrf: csrfToken(req.session), ...state,
    }),
  });
}

// ─── Служебное ───────────────────────────────────────────────────────────────

function respond(res, status, page) {
  res.set('X-Robots-Tag', 'noindex, follow');
  // R-SEC-24: личная страница не кэшируется. Иначе на общем компьютере
  // следующий человек увидит из кеша заполненную форму и адрес из неё.
  res.set('Cache-Control', 'no-store');
  return res.status(status).type('html').send(page.__raw);
}

/** Значения, которые возвращаются в форму. Пароля среди них нет. */
function pick(body) {
  return {
    email: body.email ?? '',
    nickname: body.nickname ?? '',
    timezone: body.timezone ?? '',
  };
}

/** IP для лимитов: заголовок берётся только если приложение за прокси. */
function clientIp(req) {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

function regenerate(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((e) => (e ? reject(e) : resolve()));
  });
}

/** Хеш токена; при мусоре на входе — null, без исключения. */
function safeHash(token) {
  if (typeof token !== 'string' || !token) return null;
  return hashToken(token);
}

/** Нарушение уникального индекса: код 23505 в PostgreSQL. */
function isDuplicate(e) {
  return e?.code === '23505';
}
