// S-34 — адрес страницы «Для вас».
//
// Маршрут тонкий: разбор, выбор локали, вызов источника, отдача шаблона
// (ARCHITECTURE §1). Правила того, кто получит персональную строку, живут в
// источнике данных: он один и тот же, что и у главной, поэтому выключенный
// переключатель `recs_enabled`, порог истории (EC-M1) и пустой каталог
// трактуются одинаково на обоих адресах.
//
// Страница не нужна в индексе: строка персональная, в поиске ей делать
// нечего (R-SEO-06). Правой панели здесь нет: экран — один ряд постеров,
// колонка только сжимала бы сетку.

import express from 'express';

import { layout } from '../view/layout.js';
import { csrfToken } from '../services/auth/session.js';
import { forYouView } from '../view/forYou.js';
import { menuGenres } from './menuGenres.js';
import { t, isLocale } from '../i18n/strings.js';
// Таблицы стилей этой страницы: общая, без собственных групп — та же сетка
// постеров, что на главной (DEC-067), список берётся из `src/config/styles.js`.
const STYLES = [];

export function createForYouRoutes({ data, genres = null, sessionMw = null }) {
  // strict: без него Express считает /ru и /ru/ одним адресом.
  const router = express.Router({ strict: true });
  // Сессия ради меню аккаунта и адреса, по которому кнопка вернёт человека.
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  router.get('/:locale/for-you', async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    try {
      const row = await data.forYou(req.session?.user?.id ?? null);
      // Заголовок «<title>» повторяет состояние строки: на «популярной»
      // странице персональное обещание в заголовке обманывало бы.
      const title = t(locale, row.personalized ? 'foryou.title' : 'home.foryou.popular');
      const page = layout({
        styles: STYLES,
        account: req.account,
        locale,
        path: '/for-you',
        title: `${title} — ${t(locale, 'app.title')}`,
        description: t(locale, 'foryou.description'),
        noindex: true,
        body: forYouView({ locale, data: row, csrf: req.session ? csrfToken(req.session) : '' }),
        genres: await menuGenres(genres, locale),
      });
      res.type('html').send(page.__raw);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
