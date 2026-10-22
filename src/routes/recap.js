// Персональные итоги (M7, S-33).
//
// Свои итоги — на `/recap`, чужие — на `/u/{nick}/recap` и только при
// открытой публичности (M7 §15). Страница всегда `noindex`: персональные
// числа не индексируются, даже если человек их открыл.
//
// Картинка для шеринга собирается на сервере (F-07-03 §8г) и отдаётся
// отдельным POST: сборка тяжёлая, а по ссылке её дёргать нельзя.

import express from 'express';

import { layout, pageTitle } from '../view/layout.js';
import { recapView } from '../view/recap.js';
import { notFound } from './home.js';
import { t, isLocale } from '../i18n/strings.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { safeReturnTo } from '../services/auth/login.js';
import { buildShareImage } from '../services/insights/shareImage.js';
import { PERIODS } from '../services/insights/recap.js';
import { WRAPPED } from '../config/settings.js';

// Таблицы стилей этой страницы: общая плюс нужные группы. Список
// берётся из `src/config/styles.js`, порядок подключения — оттуда же.
const STYLES = ['recap'];

/**
 * Маршруты персональных итогов.
 *
 * @param {object} deps
 * @param {{slides: (args: {userId: number, period: string}) => Promise<object>, markInviteRead: (userId: number, year: number) => Promise<void>}} deps.recap
 * @param {{byNickname: (nickname: string) => Promise<object|null>, byId: (userId: number) => Promise<object|null>}} deps.profile
 * @param {{forYou: (userId: number|null) => Promise<{items: object[], personalized: boolean}>}} deps.data
 * @param {object|null} [deps.sessionMw]
 * @returns {import('express').Router}
 */
export function createRecapRoutes({ recap, profile, data, sessionMw = null }) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  /**
   * Страница итогов.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {{id: number, profilePublic: boolean}} user
   * @param {boolean} own свои или чужие
   * @param {import('express').NextFunction} next
   */
  async function render(req, res, user, own, next) {
    const locale = req.params.locale;
    const period = PERIODS.includes(req.query.period) ? req.query.period : WRAPPED.defaultPeriod;
    try {
      const data_ = await recap.slides({ userId: user.id, period });
      if (!data_) {
        return res.status(404).type('html').send(notFound(locale, req.account).__raw);
      }
      // Приглашение, ради которого человек сюда пришёл, прочитано.
      if (own) await recap.markInviteRead(user.id, data_.year);
      const popular = data_.enough ? [] : (await data.forYou(user.id)).items;
      return res.status(200).type('html').send(layout({
        account: req.account,
        locale,
        path: '/recap',
        title: pageTitle(locale, t(locale, 'recap.title.year', { year: data_.year })),
        description: t(locale, 'recap.little.text', { marks: data_.marks ?? 0 }),
        noindex: true,
        styles: STYLES,
        body: recapView({
          locale,
          recap: data_,
          period,
          popular,
          own,
          public: user.profilePublic === true,
          csrf: csrfToken(req.session),
        }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  }

  router.get('/:locale/recap', async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.redirect(303, `/${locale}/login?next=${encodeURIComponent(safeReturnTo(req.originalUrl))}`);
    }
    const user = await profile.byId(userId);
    if (!user) return res.status(404).type('html').send(notFound(locale, req.account).__raw);
    return render(req, res, user, true, next);
  });

  router.get('/:locale/u/:nick/recap', async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');
    try {
      const user = await profile.byNickname(req.params.nick);
      // Чужи итоги открыты только при включённой публичности; иначе — как
      // будто человека нет (F-07-01 §5).
      if (!user || !user.profilePublic) {
        return res.status(404).type('html').send(notFound(locale, req.account).__raw);
      }
      return render(req, res, user, false, next);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:locale/recap/share', async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).type('text/plain; charset=utf-8').send(t(locale, 'recap.share.error'));

    const body = req.body ?? {};
    try {
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8').send(t(locale, 'mark.error.csrf'));
      }
      const period = PERIODS.includes(body.period) ? body.period : WRAPPED.defaultPeriod;
      const data_ = await recap.slides({ userId, period });
      if (!data_ || !data_.enough) {
        return res.status(404).type('text/plain; charset=utf-8').send(t(locale, 'recap.little.title'));
      }

      const numbers = data_.slides.slice(0, 4).map((slide) => ({
        value: String(slide.value),
        label: t(locale, `recap.slide.${slide.key}.title`),
      }));
      const favourite = data_.slides.find((slide) => slide.key === 'favourite') ?? null;
      const periodLabel = t(locale, 'recap.title.year', { year: data_.year });
      const png = await buildShareImage({
        periodLabel,
        numbers,
        favourite: favourite ? { title: favourite.link?.title ?? '' } : null,
      });

      return res.status(200)
        .set('Content-Type', 'image/png')
        .set('Content-Disposition', 'attachment; filename="recap.png"')
        .set('Cache-Control', 'no-store')
        .send(png);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
