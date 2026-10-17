// S-32 — настройки: язык и вид, приватность.
//
// Спецификация: docs/01-product/features/M1-identity.md F-01-06.
// Правила: §8(а) тема и язык применяются сразу; §8(б) переключатели
// сохраняются сразу; §8(г) приватность по умолчанию закрытая; R-SEC-10
// (разделы только свои); §9 (часовой пояс из списка IANA).
// Остальные разделы — профиль, уведомления, безопасность, данные —
// отдельными этапами.
//
// Формы разделов различаются по способу сохранения, и это не прихоть:
// переключатель применяется в момент щелчка (проверить надо сразу), а форма
// подтверждается кнопкой (иначе половина полей применилась бы при первом же
// изменении).

import express from 'express';

import { layout } from '../view/layout.js';
import { settingsView } from '../view/settings.js';
import { isLocale, t } from '../i18n/strings.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { sessionHash } from '../services/auth/device.js';
import { checkTimezone, checkNickname, checkEmail, normalizeEmail } from '../services/auth/validate.js';
import { checkPasswordStrength, hashPassword, hashToken, makeToken } from '../services/auth/password.js';
import { generateBackupCodes, hashBackupCode } from '../services/auth/totp.js';
import { emailChangeView } from '../view/email-change.js';
import { deletedView } from '../view/deleted.js';
import { deleteConfirm as deleteConfirmView } from '../view/settings.js';
import { LOCALES, LOCALE_NAMES } from '../i18n/strings.js';
import { AUTH, STAFF_ROLES, DAY } from '../config/settings.js';

const BASE = '/settings';

/**
 * Подтверждение смены адреса — отдельный адрес от `email_verify`.
 *
 * Разные адреса, а не одна страница с двумя состояниями: письмо о смене и
 * письмо о регистрации открываются по разным ссылкам, и совмещать их значило
 * бы различать их по содержимому токена на глазах.
 */
const EMAIL_CHANGE_PATH = '/settings/email-change';

/**
 * Экраны удаления аккаунта (F-01-10).
 *
 * `DELETE_DONE_PATH` — подтверждение, что запрос принят: показывается после
 * разлогина, когда настроек уже не видно. `DELETE_PENDING_PATH` — вход в
 * период ожидания (EC-A11): экран с выбором, а не сообщение на форме входа.
 */
const DELETE_DONE_PATH = '/settings/data/deleted';
const DELETE_PENDING_PATH = '/delete-pending';

/**
 * Разделы экрана (F-01-06 §4, F-01-10 §3).
 *
 * «Безопасность» — один раздел с тремя формами, а не три вкладки: смена
 * пароля, 2FA и устройства относятся к одному списку дел. «Данные» — две
 * карточки-действия (F-01-10 §19): экспорт и удаление.
 */
const SECTIONS = {
  profile: 'settings.profile.title',
  appearance: 'settings.appearance.title',
  notifications: 'settings.notifications.title',
  privacy: 'settings.privacy.title',
  security: 'settings.security.title',
  data: 'settings.data.title',
};

/** Темы из `e_user.theme` (CHECK в схеме). */
const THEMES = ['light', 'dark', 'system'];

/**
 * @param {object} deps
 * @param {object} deps.auth хранилище учётных записей
 * @param {Function} deps.sessionMw middleware сессий
 * @param {object} [deps.journal] журнал безопасности
 */
export function createSettingsRoutes({
  auth, sessionMw, journal, mailQueue, preferences = null, now = () => Date.now(), baseUrl = '',
}) {
  const router = express.Router({ strict: true });
  router.use('/:locale{/:rest}', sessionMw);

  router.get(`/:locale${BASE}`, (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');
    // Без раздела открывается первый — иначе адрес `/settings` был бы
    // страницей без содержимого.
    return res.redirect(303, `/${locale}${BASE}/appearance`);
  });

  router.get(`/:locale${BASE}/:section`, async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const section = req.params.section;
    if (!Object.hasOwn(SECTIONS, section)) return next('route');

    const user = req.session.user ?? null;

    // Раздел «Безопасность» показывает своё состояние: включена ли 2FA,
    // сколько резервных кодов осталось и какие устройства залогинены. Без
    // этого человек видит кнопки, но не видит, что именно он сейчас отключает.
    const extra = {};
    if (section === 'security' && user) {
      const twoFactor = await auth.twoFactor(user.id);
      extra.twoFactor = twoFactor;
      extra.backupLeft = twoFactor ? twoFactor.backup.length : 0;
      extra.devices = await auth.devices(user.id, sessionHash(req.sessionID));
    }
    if (section === 'profile' && user) {
      extra.history = await auth.nicknameHistory(user.id);
      extra.changedAt = await auth.nicknameChangedAt(user.id);
    }
    // Карточка выгрузки показывает состояние последнего заказа: без него
    // человек видит кнопку и не понимает, готовится файл или уже лежит.
    if (section === 'data' && user) {
      extra.exportJob = await auth.lastExport(user.id);
    }

    // Коды показываются один раз: прямо в адресе после перегенерации, дальше
    // они в базе не остаются.
    const backup = typeof req.query.backup === 'string' && req.query.backup
      ? req.query.backup.split(',')
      : null;

    return respond(res, 200, await render(req, {
      section,
      user,
      error: null,
      saved: req.query.saved === '1',
      values: null,
      backupCodes: backup,
      ...extra,
      // Настройки читаются при отрисовке, а не при входе: переключатель мог
      // поменяться в другой вкладке, и матрица обязана показать актуальное.
      ...(section === 'notifications' ? { matrix: await matrixOf(user) } : {}),
    }));
  });

  router.post(`/:locale${BASE}/:section`, async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const section = req.params.section;
    if (!Object.hasOwn(SECTIONS, section)) return next('route');

    const body = req.body ?? {};
    if (!csrfValid(req.session, body.csrf)) {
      return respond(res, 403, render(req, {
        section, user: req.session.user ?? null, error: t(locale, 'settings.error.csrf'),
      }));
    }

    // Гость правит только своё (тему и язык в браузере) — профиль, пароль,
    // приватность и 2FA без входа не меняются.
    const user = req.session.user;
    const ctx = { section, user, locale };

    if (section === 'profile') return applyProfile(req, res, body, ctx);
    if (section === 'notifications') return applyNotifications(req, res, body, ctx);
    if (section === 'security') return applySecurity(req, res, body, ctx);
    if (section === 'data') return applyData(req, res, body, ctx);
    if (section === 'appearance') return applyAppearance(req, res, body, ctx);
    return applyPrivacy(req, res, body, ctx);
  });

  /**
   * Ник и аватар (F-01-06 §4).
   *
   * Аватар — инициалы на плашке: загрузка изображений в P0 не входит (H-52),
   * а человек без аватара в списке отметок выглядит битым элементом.
   */
  async function applyProfile(req, res, body, ctx) {
    const { locale, user } = ctx;
    const nickname = String(body.nickname ?? '').trim();

    const problems = await checkNickname(nickname, {
      // Имена в базе и словарь модерации — разные проверки, и словарь уже
      // встроен в `checkNickname` (F-01-06 §8(д)). Свой ник не считается
      // занятым: смена на то же имя — это «сохранено», а не «занято».
      available: (value) => auth.nicknameFree(value, user.id),
    });
    if (problems.length) {
      return respond(res, 400, await render(req, {
        ...ctx, error: t(locale, `settings.profile.error.${problems[0]}`),
        values: { nickname },
      }));
    }

    // §9: смена не чаще раза в `auth.nickname_change_days`. Проверяется до
    // записи: ники заняты проверяются первыми, и человек узнал бы о сроке
    // только после попытки занять чужое имя.
    if (nickname !== user.nickname) {
      const changedAt = await auth.nicknameChangedAt(user.id);
      if (changedAt !== null && now() - changedAt < AUTH.nicknameChangeDays * DAY) {
        const days = Math.ceil((AUTH.nicknameChangeDays * DAY - (now() - changedAt)) / DAY);
        return respond(res, 429, await render(req, {
          ...ctx, error: t(locale, 'settings.profile.error.rate', { days }),
          values: { nickname },
        }));
      }
      await auth.changeNickname(user.id, nickname);
    }
    return res.redirect(303, `/${locale}${BASE}/profile?saved=1`);
  }

  /**
   * Уведомления (F-01-06 §4).
   *
   * Здесь контейнер и сохранение, а состав категорий определяет M3. Пока
   * категории не названы, хранится тихий режим и общий выключатель: без них
   * человек не может даже прекратить писать ему письма.
   */
  /**
   * Раздел уведомлений (F-03-10): переключатель категории или тихие часы.
   *
   * Одной кнопки «Сохранить» для матрицы нет намеренно: переключатель
   * отправляет свою форму целиком, и человек не должен искать кнопку под
   * таблицей. Тихие часы — обычная форма с кнопкой: там два значения, которые
   * применяются вместе.
   */
  async function applyNotifications(req, res, body, ctx) {
    const { locale, user } = ctx;

    if (body.category !== undefined) {
      if (!preferences) throw new Error('настройки уведомлений не подключены');
      const result = await preferences.set({
        userId: user.id,
        category: String(body.category ?? ''),
        channel: String(body.channel ?? ''),
        enabled: String(body.enabled ?? '') === 'on',
      });

      if (result.ok) return res.redirect(303, `/${locale}${BASE}/notifications?saved=1`);

      // Отказ с пояснением, а не пустая страница: человек должен понять, что
      // именно нельзя, иначе он будет ждать результата проверки вечно (R-SEC-24).
      const message = result.reason === 'mandatory'
        ? t(locale, 'settings.notifications.error.mandatory')
        : t(locale, 'settings.notifications.error.unknown');
      return respond(res, result.reason === 'mandatory' ? 403 : 400, await render(req, {
        section: 'notifications', user, error: message, matrix: await matrixOf(user),
      }));
    }

    if (user) {
      await auth.updateNotifications(user.id, {
        quietHours: body.quiet_hours === 'on',
        quietFrom: String(body.quiet_from ?? ''),
        quietTo: String(body.quiet_to ?? ''),
      });
    }
    return res.redirect(303, `/${locale}${BASE}/notifications?saved=1`);
  }

  /** Матрица настроек для вида; без источника — пустая, и всё включено. */
  async function matrixOf(user) {
    if (!preferences || !user) return null;
    return preferences.matrix(user.id);
  }

  /**
   * Язык, тема и часовой пояс (F-01-06 §8(а)).
   *
   * Значения применяются по одному, без кнопки: человек выбрал — значит
   * хочет. Форма отправляется целиком, а не одним полем, поэтому приходят
   * все три значения.
   */
  /**
   * Безопасность (F-01-06 §4): пароль, 2FA, устройства.
   *
   * Один раздел с тремя формами, а не три вкладки — дела одного рода. Раз
   * отличается полем `action`: по одной форме на каждое дело нельзя, все три
   * живут на одной странице.
   */
  async function applySecurity(req, res, body, ctx) {
    const { locale, user } = ctx;
    const action = String(body.action ?? '');
    const csrf = { locale };

    if (action === 'password') return changePassword(req, res, body, ctx);
    if (action === 'two_factor') return changeTwoFactor(req, res, body, ctx);
    if (action === 'email') return changeEmail(req, res, body, ctx);
    // Отзыв устройства различается по самому запросу, а не по `action`:
    // в одной форме живут и кнопка устройства (`session`), и «выйти на
    // остальных» (`action`), и скрытое поле с одним значением отправлялось бы
    // вместе с нажатой кнопкой — браузер послал бы два `action` сразу.
    if (body.session !== undefined) return revokeDevice(req, res, body, ctx);
    if (action === 'revoke_others') return revokeOtherDevices(req, res, ctx);

    return respond(res, 400, await render(req, { ...ctx, error: t(locale, 'settings.security.error.action') }));
  }

  /**
   * Смена пароля (F-01-06 §8(в), §18).
   *
   * Требуется текущий пароль: без него ссылка из письма меняла бы пароль
   * человеку, оставив его без входа. Отзываются **все** сессии, включая
   * текущую (M1 §8(д), F-01-06 §17): пароль на одном устройстве не должен
   * оставлять вход ни на этом, ни на остальных, поэтому после смены человек
   * входит заново.
   */
  async function changePassword(req, res, body, ctx) {
    const { locale, user } = ctx;
    const current = String(body.current ?? '');
    const next = String(body.password ?? '');

    // Ошибки собираются все сразу: человек за один раз узнаёт и про старый
    // пароль, и про слабый новый, а не исправляет по одному (R-A11Y-11).
    const problems = [];
    if (!(await auth.verifyCurrent(user.id, current))) problems.push('current');
    problems.push(...checkPasswordStrength(next));
    if (problems.length) {
      return respond(res, 400, await render(req, {
        ...ctx,
        error: t(locale, `settings.security.error.${problems[0]}`),
      }));
    }

    await auth.resetPassword(user.id, await hashPassword(next));
    const revoked = await auth.revokeSessions(user.id);

    journal?.security({
      event: 'password_changed',
      requestId: req.requestId,
      user_id: user.id,
      sessions_revoked: revoked,
    });
    await notify(user.id, locale, 'password_changed');

    return res.redirect(303, `/${locale}${BASE}/security?saved=1`);
  }

  /**
   * Двухфакторная проверка (F-01-05 §8, F-01-06 §4).
   *
   * Служебной роли отключить нельзя — это проверяется здесь, на сервере.
   * Скрытая кнопка обходится прямым запросом, и правило, объявленное только
   * в интерфейсе, правилом не является.
   */
  async function changeTwoFactor(req, res, body, ctx) {
    const { locale, user } = ctx;
    const roles = user.roles ?? [];
    const staff = roles.some((r) => STAFF_ROLES.includes(r));

    if (staff && body.op === 'disable') {
      return respond(res, 403, await render(req, {
        ...ctx, error: t(locale, 'settings.security.error.required'),
      }));
    }

    // Отключение и перегенерация требуют пароля: и то и другое ослабляет
    // аккаунт, а одно лишь знание сессии не должно этого позволять.
    if (!(await auth.verifyCurrent(user.id, String(body.password ?? '')))) {
      return respond(res, 400, await render(req, {
        ...ctx, error: t(locale, 'settings.security.error.current'),
      }));
    }

    if (body.op === 'disable') {
      await auth.disableTwoFactor(user.id);
      journal?.security({
        event: 'two_factor_disabled', requestId: req.requestId, user_id: user.id,
      });
      await notify(user.id, locale, 'two_factor_disabled');
      return res.redirect(303, `/${locale}${BASE}/security?saved=1`);
    }

    if (body.op === 'regenerate') {
      const state = await auth.twoFactor(user.id);
      if (!state) {
        return respond(res, 400, await render(req, {
          ...ctx, error: t(locale, 'settings.security.error.notEnabled'),
        }));
      }
      const codes = generateBackupCodes();
      // Старые коды перестают действовать вместе с записью (F-01-05 §8).
      await auth.enableTwoFactor(user.id, state.secret, codes.map((c) => hashBackupCode(c)));
      journal?.security({
        event: 'two_factor_codes_regenerated', requestId: req.requestId, user_id: user.id,
      });
      // Коды показываются один раз — в базе только хеши.
      return res.redirect(303, `/${locale}${BASE}/security?backup=${codes.join(',')}`);
    }

    return respond(res, 400, await render(req, {
      ...ctx, error: t(locale, 'settings.security.error.op'),
    }));
  }

  /**
   * Отзыв устройства (F-01-03, S-32).
   *
   * Отзывается только то, что принадлежит владельцу: идентификатор из тела
   * запроса проверяется хранилищем (R-SEC-10).
   */
  async function revokeDevice(req, res, body, ctx) {
    const { locale, user } = ctx;
    const sessionId = String(body.session ?? '');

    if (!(await auth.revokeDevice(user.id, sessionId))) {
      return respond(res, 400, await render(req, {
        ...ctx, error: t(locale, 'settings.security.error.device'),
      }));
    }
    return res.redirect(303, `/${locale}${BASE}/security?saved=1`);
  }

  /**
   * Выход на всех остальных устройствах (F-01-03 §4).
   *
   * Текущая сессия остаётся: человек нажал «на остальных», а не «выйти», и
   * выкидывать его из аккаунта на устройстве, с которого он нажал, было бы
   * ровно тем самым неудобством, ради которого кнопка и нужна.
   */
  async function revokeOtherDevices(req, res, ctx) {
    const { locale, user } = ctx;
    await auth.pruneSessions(user.id, req.sessionID, 1);
    return res.redirect(303, `/${locale}${BASE}/security?saved=1`);
  }

  /**
   * Смена адреса (F-01-06 §4, §5, EC-A15).
   *
   * Ответ одинаков и на занятый адрес, и на свободный: по нему иначе
   * перебираются существующие аккаунты (R-SEC-06). Письмо со ссылкой на
   * занятый адрес не уходит — уходит уведомление его владельцу.
   *
   * Адрес не применяется сразу: пока человек не доказал владение новым,
   * аккаунт остаётся на старом. Иначе подтверждение чужого адреса отнимало бы
   * вход у того, кто его открыл.
   */
  async function changeEmail(req, res, body, ctx) {
    const { locale, user } = ctx;

    if (!(await auth.verifyCurrent(user.id, String(body.password ?? '')))) {
      return respond(res, 400, await render(req, {
        ...ctx, error: t(locale, 'settings.security.error.current'),
      }));
    }

    // Адрес нормализуется до отправки и до записи: иначе «Anna@» и «anna@»
    // считались бы разными, а слепой индекс один.
    const email = normalizeEmail(String(body.email ?? ''));
    if (checkEmail(email).length) {
      return respond(res, 400, await render(req, {
        ...ctx, error: t(locale, 'settings.security.error.email'), values: { email },
      }));
    }

    // `made.token` уходит в ссылку, `made.hash` — в базу: открытый токен
    // нигде не хранится, и по ссылке его не восстановить.
    const made = makeToken();
    const issued = await auth.requestEmailChange(
      user.id, email, made.hash, new Date(now() + AUTH.tokenTtlMin * 60_000),
    );

    // Занятый адрес: ответ тот же, письмо со ссылкой не уходит, уведомление
    // получает владелец. Различить по ответу нельзя (EC-A15).
    if (!issued) {
      await mailQueue?.enqueue({ kind: 'email_taken', to: email, locale });
      return res.redirect(303, `/${locale}${BASE}/security?saved=1`);
    }

    await mailQueue?.enqueue({
      kind: 'email_change',
      to: email,
      locale,
      link: `${baseUrl}/${locale}${EMAIL_CHANGE_PATH}?token=${encodeURIComponent(made.token)}`,
    });
    // На старый адрес — уведомление о том, что адрес меняют. Иначе человек
    // узнает об этом, только потеряв вход, а потеря входа выглядит как взлом.
    await notify(user.id, locale, 'email_change_requested');

    return res.redirect(303, `/${locale}${BASE}/security?saved=1`);
  }

  /**
   * Подтверждение смены адреса по ссылке из письма.
   *
   * Токен не гасится запросом: почтовые сканеры открывают ссылки сами, и
   * применение адреса по GET сожгло бы заявку раньше времени (EC-A4).
   */
  router.get(`/:locale${EMAIL_CHANGE_PATH}`, (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const token = typeof req.query.token === 'string' ? req.query.token : '';
    return respond(res, 200, layout({
      account: req.account,
      locale,
      path: EMAIL_CHANGE_PATH,
      title: `${t(locale, 'settings.email.title')} — ${t(locale, 'app.title')}`,
      description: t(locale, 'settings.email.lead'),
      noindex: true,
      body: emailChangeView({
        locale,
        csrf: csrfToken(req.session),
        token,
        state: token ? 'await' : 'stale',
        error: null,
      }),
    }));
  });

  router.post(`/:locale${EMAIL_CHANGE_PATH}`, async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const body = req.body ?? {};
    if (!csrfValid(req.session, body.csrf)) {
      return respond(res, 403, layout({
        account: req.account,
        locale, path: EMAIL_CHANGE_PATH, title: t(locale, 'settings.email.title'),
        description: t(locale, 'settings.email.lead'), noindex: true,
        body: emailChangeView({
          locale, csrf: csrfToken(req.session), token: '', state: 'stale',
          error: t(locale, 'twoFactor.error.csrf'),
        }),
      }));
    }

    const token = String(body.token ?? '');
    const stale = () => respond(res, 200, layout({
      account: req.account,
      locale, path: EMAIL_CHANGE_PATH, title: t(locale, 'settings.email.title'),
      description: t(locale, 'settings.email.lead'), noindex: true,
      body: emailChangeView({
        locale, csrf: csrfToken(req.session), token, state: 'stale',
        error: t(locale, 'settings.email.error.stale'),
      }),
    }));

    if (!token) return stale();

    let change;
    try {
      change = await auth.emailChangeByToken(hashToken(token));
    } catch (e) {
      return next(e);
    }
    // Один ответ на «нет заявки», «просрочена» и «не та»: по формулировке
    // иначе перебираются токены (F-01-02 §5).
    if (!change || new Date(change.expiresAt).getTime() < now()) return stale();

    // Старый адрес читается **до** применения: после он уже не находится
    // по этому пользователю, и письмо ушло бы новому владельцу адреса.
    const previous = await auth.addressOf(change.user_id);

    await auth.applyEmailChange(change.id, change.user_id, change.email);

    // Уведомление на старый адрес: при смене старый перестаёт работать, и
    // без письма человек узнает об этом, только потеряв вход.
    if (previous) {
      await mailQueue?.enqueue({ kind: 'email_changed', to: previous, locale });
    }
    journal?.security({
      event: 'email_changed', requestId: req.requestId, user_id: change.user_id,
    });

    return res.redirect(303, `/${locale}${BASE}/security?saved=1`);
  });

  /** Уведомление; адрес берётся из базы (F-01-06 §17). */
  /**
   * Служебное письмо (F-01-10 §17).
   *
   * Адрес берётся из базы, а не из сессии: в сессии его нет, а в теле
   * запроса ему нельзя доверять (R-SEC-10).
   *
   * @param {object} [params] подстановки в текст письма, например дата
   */
  async function notify(userId, locale, kind, params = {}) {
    const to = await auth.addressOf(userId);
    if (!to) return;
    await mailQueue?.enqueue({ kind, to, locale, ...params });
  }


  async function applyAppearance(req, res, body, ctx) {
    const locale = req.params.locale;
    const user = ctx.user;

    const theme = String(body.theme ?? '');
    const nextLocale = String(body.locale ?? '');
    const timezone = String(body.timezone ?? '');

    const problems = [];
    if (!THEMES.includes(theme)) problems.push('theme');
    if (!LOCALES.includes(nextLocale)) problems.push('locale');
    // §9: часовой пояс из списка IANA. Произвольная строка попала бы в базу,
    // и по ней потом нельзя было бы показать время.
    if (checkTimezone(timezone).length) problems.push('timezone');

    if (problems.length) {
      return respond(res, 400, render(req, {
        section: 'appearance',
        user,
        error: t(locale, `settings.error.${problems[0]}`),
        values: { theme, locale: nextLocale, timezone },
      }));
    }

    if (user) {
      await auth.updatePreferences(user.id, {
        theme, locale: nextLocale, timezone,
      });
    }
    // Гостю значения живут на его стороне: скрипт темы читает localStorage,
    // а язык задаётся адресом. Подменять их сервером нечем и незачем.
    return res.redirect(303, `/${locale}${BASE}/appearance?saved=1`);
  }

  /**
   * Переключатели приватности (F-01-06 §8(б)).
   *
   * Чекбокс отсутствует, когда его нет в теле запроса, — поэтому значение
   * читается как «передан», а не как «истина». Иначе снятый переключатель
   * всегда оставался бы включённым.
   */
  async function applyPrivacy(req, res, body, ctx) {
    const locale = req.params.locale;
    const user = ctx.user;

    // R-SEC-10: разделы только свои. Идентификатор из тела запроса игнорируется
    // целиком — он не нужен и был бы обходом.
    const wanted = {
      stats_public: body.stats_public === 'on',
      profile_public: body.profile_public === 'on',
      recs_enabled: body.recs_enabled === 'on',
    };

    if (user) {
      await auth.updatePreferences(user.id, wanted);
    }
    return res.redirect(303, `/${locale}${BASE}/privacy?saved=1`);
  }

  /**
   * Раздел «Данные» (F-01-10 §4, §5).
   *
   * Дела разведены по полю `action`, как в «Безопасности»: экспорт и удаление —
   * разные опасности с разными последствиями, и одна форма на обе дала бы
   * человеку одно поле на два решения.
   */
  async function applyData(req, res, body, ctx) {
    const { locale, user } = ctx;
    // R-SEC-10: удаление и экспорт — только своим. Гость правит своё (тему и
    // язык), но чужие данные не выгружает и не удаляет.
    if (!user) {
      return respond(res, 403, await render(req, {
        ...ctx, error: t(locale, 'settings.data.error.guest'),
      }));
    }

    if (body.action === 'delete') return requestDeletion(req, res, body, ctx);
    if (body.action === 'export') return orderExport(req, res, body, ctx);
    return respond(res, 400, await render(req, {
      ...ctx, error: t(locale, 'settings.data.error.action'),
    }));
  }

  /**
   * Заказ выгрузки (F-01-10 §4, EC-A21).
   *
   * Повторный пароль: в файле всё, что человек накопил, и отдавать его тому,
   * кто знает только пароль из утечки, нельзя (R-SEC-12).
   *
   * Сборка уходит в фон: файл бывает большим, и держать открытый ответ, пока
   * он собирается, — значит держать соединение.
   */
  async function orderExport(req, res, body, ctx) {
    const { locale, user } = ctx;

    if (!(await auth.verifyCurrent(user.id, String(body.password ?? '')))) {
      return respond(res, 400, await render(req, {
        ...ctx, section: 'data', error: t(locale, 'settings.data.error.password'),
      }));
    }

    const verdict = await auth.requestExport(user.id, user.locale ?? locale, new Date(now()));
    // EC-A21: отказ со временем следующей попытки, а не «попробуйте позже».
    if (!verdict.ok) {
      const hours = Math.max(1, Math.ceil((new Date(verdict.retryAt) - now()) / 3_600_000));
      return respond(res, 429, await render(req, {
        ...ctx,
        section: 'data',
        error: t(locale, 'settings.data.export.cooldown', { time: `${hours} ч` }),
      }));
    }

    journal?.security({
      event: 'export_requested', requestId: req.requestId, user_id: user.id,
    });
    return res.redirect(303, `/${locale}${BASE}/data?saved=1`);
  }

  /**
   * Скачивание файла по ссылке из письма.
   *
   * Сессии здесь нет и не нужно: всё право ссылки — токен и срок. Отдаётся
   * вложением и без кеширования, иначе файл остался бы в кеше браузера
   * (R-SEC-24).
   */
  router.get(`/:locale${BASE}/data/export`, async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) return res.redirect(303, `/${locale}${BASE}/data`);

    let file;
    try {
      file = await auth.exportByToken(token, new Date(now()));
    } catch (e) {
      return next(e);
    }
    if (!file) return res.redirect(303, `/${locale}${BASE}/data`);

    res.set('Cache-Control', 'no-store');
    return res.status(200)
      .type('application/json')
      .set('Content-Disposition', 'attachment; filename="sigmaseries-data.json"')
      .send(file.payload);
  });

  /**
   * Экран удаления целиком: тело вида плюс оболочка страницы.
   *
   * Данные меню аккаунта приходят аргументом, а не из замыкания: функция
   * живёт вне обработчика, где `req` нет.
   */
  function deletedPage(locale, session, view, account = null) {
    const title = view.pending
      ? t(locale, 'settings.deletePending.title')
      : t(locale, 'settings.deleted.title');
    return layout({
      account,
      locale,
      path: view.pending ? DELETE_PENDING_PATH : DELETE_DONE_PATH,
      title: `${title} — ${t(locale, 'app.title')}`,
      description: t(locale, view.pending ? 'settings.deletePending.lead' : 'settings.deleted.lead'),
      noindex: true,
      body: deletedView({ locale, csrf: csrfToken(session), error: null, ...view }),
    });
  }

/** Экран подтверждения удаления с перечнем последствий (R-SEC-12). */
  async function renderDeleteConfirm(req, { locale, user, error, values }) {
    return layout({
      account: req.account,
      locale,
      path: `${BASE}/data/delete`,
      title: `${t(locale, 'settings.delete.title')} — ${t(locale, 'app.title')}`,
      description: t(locale, 'settings.delete.lead'),
      noindex: true,
      theme: user?.theme,
      body: deleteConfirmView({ locale, csrf: csrfToken(req.session), error, values }),
    });
  }

  /**
   * Запрос удаления аккаунта (F-01-10 §4, R-SEC-12).
   *
   * Опасное действие: повторный пароль, перечень последствий на отдельной
   * странице и запись в журнал. Без пароля один разобранный пароль из утечки
   * удалял бы аккаунт.
   *
   * Служебная роль удалить себя не может (H-63): сначала роль снимает
   * администратор. Проверка на сервере, а не скрытием кнопки — прямым запросом
   * правило проверяется.
   *
   * Забаненный сюда не доходит: вход ему закрыт (F-01-03), и удаление
   * запустить нечем. Отдельной проверки здесь поэтому нет — была бы
   * недостижимой строкой.
   */
  async function requestDeletion(req, res, body, ctx) {
    const { locale, user } = ctx;
    const roles = user.roles ?? [];
    if (roles.some((r) => STAFF_ROLES.includes(r))) {
      return respond(res, 403, await render(req, {
        ...ctx, section: 'data', error: t(locale, 'settings.data.error.staff'),
      }));
    }

    if (!(await auth.verifyCurrent(user.id, String(body.password ?? '')))) {
      return respond(res, 400, await renderDeleteConfirm(req, {
        locale, user, error: t(locale, 'settings.security.error.current'),
        values: { deleteMaterials: body.delete_materials === 'on' },
      }));
    }

    const requestedAt = new Date(now());
    const accepted = await auth.requestDeletion(user.id, {
      deleteMaterials: body.delete_materials === 'on',
      requestedAt,
      anonymizeAfter: new Date(now() + AUTH.deleteGraceDays * DAY),
    });
    if (!accepted) {
      return respond(res, 409, await render(req, {
        ...ctx, section: 'data', error: t(locale, 'settings.data.error.pending'),
      }));
    }

    journal?.security({
      event: 'deletion_requested', requestId: req.requestId, user_id: user.id,
    });
    // Письмо уходит последним: адрес станет недоступен сразу после выхода, и
    // человек должен знать дату и способ отмены, не заходя на сайт.
    await notify(user.id, locale, 'deletion_requested', {
      date: new Date(now() + AUTH.deleteGraceDays * DAY).toISOString().slice(0, 10),
    });

    // Все устройства разлогиниваются: удаление нельзя отменить из сессии,
    // оставшейся на том же устройстве, где человек его и запросил.
    await auth.revokeSessions(user.id);
    await req.session.destroy(() => {});
    res.set('Clear-Site-Data', '"cache"');
    return res.redirect(303, `/${locale}${DELETE_DONE_PATH}`);
  }

  /**
 * Экран удаления (F-01-10 §19, R-SEC-12).
 *
 * Отдельный адрес от раздела «Данные»: перечень последствий должен быть виден
 * целиком перед вводом пароля, а не быть кнопкой в списке.
 */
router.get(`/:locale${BASE}/data/delete`, (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const user = req.session.user ?? null;
    if (!user) return res.redirect(303, `/${locale}/login`);

    return respond(res, 200, layout({
      account: req.account,
      locale,
      path: `${BASE}/data/delete`,
      title: `${t(locale, 'settings.delete.title')} — ${t(locale, 'app.title')}`,
      description: t(locale, 'settings.delete.lead'),
      noindex: true,
      theme: user.theme,
      body: deleteConfirmView({
        locale,
        csrf: csrfToken(req.session),
        error: null,
        values: { deleteMaterials: false },
      }),
    }));
  });

  router.post(`/:locale${BASE}/data/delete`, async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const user = req.session.user ?? null;
    if (!user) return res.redirect(303, `/${locale}/login`);

    const body = req.body ?? {};
    if (!csrfValid(req.session, body.csrf)) {
      return respond(res, 403, await renderDeleteConfirm(req, {
        locale, user, error: t(locale, 'settings.error.csrf'),
        values: { deleteMaterials: body.delete_materials === 'on' },
      }));
    }
    return requestDeletion(req, res, body, { locale, user });
  });

  /**
 * Экран «удаление запрошено» (F-01-10 §4).
   *
   * Отдельный адрес, а не главная с флажком: сообщение должно пережить выход
   * из аккаунта — иначе человек, закрывший вкладку, не узнает, что его выгнали
   * с сайта и когда аккаунт исчезнет.
   */
  router.get(`/:locale${DELETE_DONE_PATH}`, (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');
    return respond(res, 200, deletedPage(locale, req.session, {}));
  });

  /**
   * Вход в период удаления (EC-A11).
   *
   * Человек приходит по обычному адресу входа и упирается в выбор: отменить
   * удаление или оставить его в силе. Отмена только здесь и только явно — по
   * F-01-10 §4 вход сам по себе отменой не считается, иначе случайное открытие
   * письма со ссылкой на старый сайт вернуло бы аккаунт из удалённого.
   *
   * «Продолжить удаление» ничего не ускоряет: срок идёт дальше, а сессия
   * закрывается, чтобы выбор нельзя было повторить тем же входом.
   */
  router.get(`/:locale${DELETE_PENDING_PATH}`, (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');
    if (!req.session.pendingDeletion) return res.redirect(303, `/${locale}/login`);

    return respond(res, 200, deletedPage(locale, req.session, { pending: true }));
  });

  router.post(`/:locale${DELETE_PENDING_PATH}`, async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const pending = req.session.pendingDeletion;
    const body = req.body ?? {};
    if (!pending) return res.redirect(303, `/${locale}/login`);
    if (!csrfValid(req.session, body.csrf)) {
      return respond(res, 403, deletedPage(locale, req.session, {
        pending: true, error: t(locale, 'twoFactor.error.csrf'),
      }, req.account));
    }

    if (body.action === 'cancel') {
      await auth.cancelDeletion(pending.userId);
      journal?.security({
        event: 'deletion_cancelled', requestId: req.requestId, user_id: pending.userId,
      });
      await auth.revokeSessions(pending.userId);
      await req.session.destroy(() => {});
      return res.redirect(303, `/${locale}/login`);
    }

    // Продолжение: срок не меняется, сессия закрывается.
    await auth.revokeSessions(pending.userId);
    await req.session.destroy(() => {});
    return res.redirect(303, `/${locale}${DELETE_DONE_PATH}`);
  });

  async function render(req, { section, user, error, saved = false, values = null, ...rest }) {
    const locale = req.params.locale;
    return layout({
      account: req.account,
      locale,
      path: `${BASE}/${section}`,
      title: `${t(locale, SECTIONS[section])} — ${t(locale, 'app.title')}`,
      description: t(locale, 'settings.lead'),
      noindex: true,
      // Тема пользователя известна до отрисовки: без неё первый кадр был бы
      // в чужой теме.
      theme: user?.theme,
      body: settingsView({
        locale,
        csrf: csrfToken(req.session),
        section,
        sections: SECTIONS,
        user,
        error,
        saved,
        values,
        themes: THEMES,
        locales: LOCALES,
        localeNames: LOCALE_NAMES,
        timezones: timezones(),
        staff: (user?.roles ?? []).some((r) => STAFF_ROLES.includes(r)),
        ...rest,
      }),
    });
  }

  return router;
}

/**
 * Часовые пояса IANA (F-01-06 §9).
 *
 * Берутся у `Intl`: свой список устарел бы и разошёлся с тем, что понимает
 * среда выполнения. Фильтр оставляет только названия зон (без «UTC+3» и
 * подобных псевдонимов) — их `Intl` не принимает.
 */
function timezones() {
  return Intl.supportedValuesOf('timeZone');
}

function respond(res, status, page) {
  res.set('X-Robots-Tag', 'noindex, follow');
  // R-SEC-24: личная страница не кэшируется.
  res.set('Cache-Control', 'no-store');
  return res.status(status).type('html').send(page.__raw);
}