// S-23 — двухфакторная проверка: ввод кода и настройка.
//
// Спецификация: docs/01-product/features/M1-identity.md F-01-05.
// Требования: R-SEC-04 (2FA обязательна для служебных ролей, секрет
// зашифрован, код не принимается повторно), R-SEC-24 (страница не
// кэшируется), R-A11Y-11 (ошибка названа текстом и связана с полем),
// R-A11Y-10 (поле кода с `autocomplete="one-time-code"`).
// Границы: EC-A7 (часы устройства сбиты — допуск ±1 шаг и подсказка),
// EC-A8 (устройство потеряно — резервные коды), EC-A19 (роль выдана без
// 2FA — служебные разделы закрыты, но вход состоялся).
//
// Два адреса на один экран реестра: `/2fa` — проверка кода, `/2fa/setup` —
// первичная настройка с QR.

import express from 'express';

import { respond } from '../http/helpers.js';

import { layout } from '../view/layout.js';
import { twoFactorView } from '../view/twofactor.js';
import { setupView } from '../view/twofactor-setup.js';
import { backupCodesView } from '../view/twofactor-backup.js';
import { isLocale, t } from '../i18n/strings.js';
import { csrfToken, csrfValid, noteSession } from '../services/auth/session.js';
import {
  generateSecret,
  generateBackupCodes,
  hashBackupCode,
  verifyWithStep,
  otpAuthUri,
} from '../services/auth/totp.js';
import { qrSvg } from '../services/auth/qr.js';
import * as limits from '../services/auth/limits.js';
// Таблицы стилей этой страницы: общая плюс нужные группам. Список
// берётся из `src/config/styles.js`, порядок подключения — оттуда же.
const STYLES = ['identity'];


const CODE_PATH = '/2fa';
const SETUP_PATH = '/2fa/setup';
const ISSUER = 'sigmaseries';

/**
 * @param {object} deps
 * @param {any} deps.auth хранилище учётных записей
 * @param {import('express').RequestHandler[]} deps.sessionMw middleware сессий
 * @param {any} [deps.journal] журнал безопасности
 * @param {any} [deps.mailQueue] очередь писем
 * @param {any} [deps.limitsApi] подмена счётчиков в тестах
 * @param {Function} [deps.now] текущее время, для тестов
 */
export function createTwoFactorRoutes({ auth, sessionMw, journal, mailQueue, limitsApi = limits, now = () => Date.now() }) {
  const router = express.Router({ strict: true });
  router.use('/:locale{/:rest}', sessionMw);

  // ─── Ввод кода ─────────────────────────────────────────────────────────────

  router.get(`/:locale${CODE_PATH}`, async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const pending = req.session.pendingTwoFactor;
    if (!pending) {
      // Без начатого входа экран бессмыслен: код проверяет того, кто уже
      // доказал знание пароля. Отправляем на вход, а не показываем пустую
      // форму — иначе человек подумает, что вход сломан.
      return res.redirect(303, `/${locale}/login`);
    }
    // Настройка идёт другим адресом: показывать поле кода там, где код ещё
    // не задан, значит отослать человека на страницу с отказом.
    if (!pending.configured) return res.redirect(303, `/${locale}${SETUP_PATH}`);

    const state = await auth.twoFactor(pending.userId);
    if (!state) {
      // 2FA выключили, пока человек входил: показывать поле кода бессмысленно.
      return res.redirect(303, `/${locale}${SETUP_PATH}`);
    }

    // Сколько резервных кодов осталось: при ≤ 3 человек предупреждается
    // (F-01-05 §5). Без числа он узнает об этом, только когда коды кончатся.
    return respond(res, 200, renderCode(req, {
      error: null, backupUsed: false, codesLeft: state.backup.length,
    }));
  });

  router.post(`/:locale${CODE_PATH}`, async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const pending = req.session.pendingTwoFactor;
    if (!pending || !pending.configured) {
      return res.redirect(303, `/${locale}/login`);
    }

    const body = req.body ?? {};
    if (!csrfValid(req.session, body.csrf)) {
      return respond(res, 403, renderCode(req, {
        error: t(locale, 'twoFactor.error.csrf'), backupUsed: Boolean(body.backup_code),
      }));
    }

    const state = await auth.twoFactor(pending.userId);
    if (!state) {
      // 2FA выключили, пока человек вводил код: продолжать нечего.
      return respond(res, 200, renderCode(req, {
        error: t(locale, 'twoFactor.error.code'), backupUsed: false, codesLeft: null,
      }));
    }

    const limited = limitsApi.twoFactorLimited(pending.userId, now());
    if (!limited.ok) {
      res.set('Retry-After', String(limited.retryAfter));
      return respond(res, 429, renderCode(req, {
        error: t(locale, 'twoFactor.error.tooMany', { seconds: limited.retryAfter }),
        backupUsed: Boolean(body.backup_code),
        codesLeft: state.backup.length,
      }));
    }

    const backup = String(body.backup_code ?? '').trim();
    if (backup) return checkBackup(req, res, pending, state, backup);

    const check = verifyWithStep(state.secret, String(body.code ?? ''), {
      unixSeconds: Math.floor(now() / 1000),
      lastStep: state.lastStep,
    });

    if (!check.ok) {
      limitsApi.recordTwoFactorFailure(pending.userId, now());
      journal?.security({
        event: 'two_factor_failed',
        requestId: req.requestId,
        user_id: pending.userId,
      });
      return respond(res, 200, renderCode(req, {
        error: check.reason === 'replayed'
          ? t(locale, 'twoFactor.error.replayed')
          : t(locale, 'twoFactor.error.code'),
        backupUsed: false,
        codesLeft: state.backup.length,
      }));
    }

    await auth.acceptStep(pending.userId, check.step);
    limitsApi.clearTwoFactorFailures(pending.userId);
    journal?.security({
      event: 'two_factor_verified',
      requestId: req.requestId,
      user_id: pending.userId,
    });
    return finish(req, res, locale, pending);
  });

  // ─── Настройка ─────────────────────────────────────────────────────────────

  router.get(`/:locale${SETUP_PATH}`, async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const pending = req.session.pendingTwoFactor;
    if (!pending) return res.redirect(303, `/${locale}/login`);
    // Настроенная 2FA проверяется кодом, а не настройкой повторно.
    if (pending.configured) return res.redirect(303, `/${locale}${CODE_PATH}`);

    // Секрет живёт в сессии, пока человек сканирует QR. Он не создаётся заново
    // на каждый GET: иначе перезагрузка страницы отменяла бы настройку.
    const setup = pending.setup ?? await beginSetup(req, pending, locale);

    return respond(res, 200, renderSetup(req, { setup, error: null }));
  });

  router.post(`/:locale${SETUP_PATH}`, async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const pending = req.session.pendingTwoFactor;
    if (!pending || pending.configured) return res.redirect(303, `/${locale}/login`);

    const body = req.body ?? {};
    if (!csrfValid(req.session, body.csrf)) {
      return respond(res, 403, renderSetup(req, {
        setup: pending.setup, error: t(locale, 'twoFactor.error.csrf'),
      }));
    }

    const setup = pending.setup ?? await beginSetup(req, pending, locale);
    if (!setup) return res.redirect(303, `/${locale}/login`);

    const check = verifyWithStep(setup.secret, String(body.code ?? ''), {
      unixSeconds: Math.floor(now() / 1000),
    });
    if (!check.ok) {
      return respond(res, 400, renderSetup(req, {
        setup, error: t(locale, 'twoFactor.error.setup'),
      }));
    }

    await auth.enableTwoFactor(pending.userId, setup.secret, setup.backupHashes);
    // Коды кладутся в сессию ровно на один переход: в базе только хеши, и
    // второй раз показать их неоткуда (F-01-05 §4). После просмотра они
    // забываются вместе с сессией.
    req.session.backupCodes = setup.codes;
    journal?.security({
      event: 'two_factor_enabled',
      requestId: req.requestId,
      user_id: pending.userId,
    });
    await notifyEnabled(pending, locale);

    // Коды показываются один раз (F-01-05 §4): в базе только хеши, второй раз
    // показать их неоткуда.
    return res.redirect(303, `/${locale}${CODE_PATH}/backup`);
  });

  /** Резервные коды — единственный раз, когда они видны. */
  router.get(`/:locale${CODE_PATH}/backup`, (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const pending = req.session.pendingTwoFactor;
    if (!pending?.configured || !req.session.backupCodes?.length) {
      // Коды не хранятся в базе, только хеши: второй раз показать их нечем.
      return res.redirect(303, `/${locale}/login`);
    }

    const page = layout({
      styles: STYLES,
      account: req.account,
      locale,
      path: CODE_PATH,
      title: `${t(locale, 'twoFactor.backup.title')} — ${t(locale, 'app.title')}`,
      description: t(locale, 'twoFactor.backup.lead'),
      noindex: true,
      body: backupCodesView({ locale, codes: pending.backupCodes }),
    });
    return respond(res, 200, page);
  });

  /** Вход в сервис после успешной проверки. */
  async function finish(req, res, locale, pending) {
    // Идентификатор сессии меняется на этом шаге: до проверки кода сессия
    // была «наполовину доверенной», и её идентификатор уже был известен
    // человеку с того момента, как он ввёл пароль (R-SEC-02).
    await regenerate(req);
    req.session.user = pending.user;
    req.session.twoFactorPassed = true;
    req.session.createdAt = Date.now();
    delete req.session.pendingTwoFactor;

    // Полноценная сессия — устройство пишется в список (F-01-03 §4).
    await noteSession(auth, req, pending.user.id);

    return res.redirect(303, `/${locale}/`);
  }

  /** Проверка резервного кода: он одноразовый. */
  async function checkBackup(req, res, pending, state, code) {
    const locale = req.params.locale;
    const hash = hashBackupCode(code);
    const matches = state.backup.some((h) => h.equals(hash));

    if (!matches || !(await auth.consumeBackupCode(pending.userId, hash))) {
      limitsApi.recordTwoFactorFailure(pending.userId, now());
      journal?.security({
        event: 'two_factor_backup_failed',
        requestId: req.requestId,
        user_id: pending.userId,
      });
      return respond(res, 200, renderCode(req, {
        error: t(locale, 'twoFactor.error.backup'),
        backupUsed: true,
        codesLeft: state.backup.length,
      }));
    }

    limitsApi.clearTwoFactorFailures(pending.userId);
    journal?.security({
      event: 'two_factor_backup_used',
      requestId: req.requestId,
      user_id: pending.userId,
    });
    return finish(req, res, locale, pending);
  }

  /** Новый секрет и десять резервных кодов для настройки. */
  async function beginSetup(req, pending, locale) {
    const secret = generateSecret();
    const codes = generateBackupCodes();
    const setup = {
      secret,
      codes,
      backupHashes: codes.map((c) => hashBackupCode(c)),
      // Аккаунт в подписи: человек видит, чей это код, когда у него их два.
      uri: otpAuthUri({
        secret,
        account: pending.account ?? `user-${pending.userId}`,
        issuer: ISSUER,
      }),
      locale,
    };
    req.session.pendingTwoFactor = { ...pending, setup };
    return setup;
  }

  /** Письмо о включении 2FA (F-01-05 §17). */
  async function notifyEnabled(pending, locale) {
    const to = await auth.addressOf(pending.userId);
    if (!to) return;
    await mailQueue?.enqueue({ kind: 'two_factor_enabled', to, locale });
  }

  function renderCode(req, { error, backupUsed = false, codesLeft = null }) {
    const locale = req.params.locale;
    return layout({
      styles: STYLES,
      account: req.account,
      locale,
      path: CODE_PATH,
      title: `${t(locale, 'twoFactor.title')} — ${t(locale, 'app.title')}`,
      description: t(locale, 'twoFactor.lead'),
      noindex: true,
      body: twoFactorView({
        locale,
        csrf: csrfToken(req.session),
        state: backupUsed ? 'backup' : 'code',
        error,
        codesLeft,
      }),
    });
  }

  function renderSetup(req, { setup, error }) {
    const locale = req.params.locale;
    return layout({
      styles: STYLES,
      account: req.account,
      locale,
      path: SETUP_PATH,
      title: `${t(locale, 'twoFactor.setup.title')} — ${t(locale, 'app.title')}`,
      description: t(locale, 'twoFactor.setup.lead'),
      noindex: true,
      body: setupView({
        locale,
        csrf: csrfToken(req.session),
        setup,
        error,
        qr: qrSvg(setup.uri),
      }),
    });
  }

  return router;
}

/**
 * Ответ страницы.
 *
 * R-SEC-24: на странице настройки лежит секрет 2FA, и кеш на общем
 * компьютере отдал бы его следующему человеку.
 */

function regenerate(req) {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    req.session.regenerate((e) => (e ? reject(e) : resolve()));
  }));
}