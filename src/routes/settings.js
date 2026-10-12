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
import { checkTimezone } from '../services/auth/validate.js';
import { LOCALES, LOCALE_NAMES } from '../i18n/strings.js';

const BASE = '/settings';

/** Разделы, которые эта фича закрывает; остальные — в следующих этапах. */
const SECTIONS = {
  appearance: 'settings.appearance.title',
  privacy: 'settings.privacy.title',
};

/** Темы из `e_user.theme` (CHECK в схеме). */
const THEMES = ['light', 'dark', 'system'];

/**
 * @param {object} deps
 * @param {object} deps.auth хранилище учётных записей
 * @param {Function} deps.sessionMw middleware сессий
 * @param {object} [deps.journal] журнал безопасности
 */
export function createSettingsRoutes({ auth, sessionMw, journal }) {
  const router = express.Router({ strict: true });
  router.use('/:locale{/:rest}', sessionMw);

  router.get(`/:locale${BASE}`, (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');
    // Без раздела открывается первый — иначе адрес `/settings` был бы
    // страницей без содержимого.
    return res.redirect(303, `/${locale}${BASE}/appearance`);
  });

  router.get(`/:locale${BASE}/:section`, (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const section = req.params.section;
    if (!Object.hasOwn(SECTIONS, section)) return next('route');

    const user = req.session.user ?? null;
    return respond(res, 200, render(req, {
      section,
      user,
      error: null,
      saved: req.query.saved === '1',
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

    const user = req.session.user;
    if (section === 'appearance') {
      return applyAppearance(req, res, body);
    }
    return applyPrivacy(req, res, body);
  });

  /**
   * Язык, тема и часовой пояс (F-01-06 §8(а)).
   *
   * Значения применяются по одному, без кнопки: человек выбрал — значит
   * хочет. Форма отправляется целиком, а не одним полем, поэтому приходят
   * все три значения.
   */
  async function applyAppearance(req, res, body) {
    const locale = req.params.locale;
    const user = req.session.user;

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
  async function applyPrivacy(req, res, body) {
    const locale = req.params.locale;
    const user = req.session.user;

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

  function render(req, { section, user, error, saved = false, values = null }) {
    const locale = req.params.locale;
    return layout({
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