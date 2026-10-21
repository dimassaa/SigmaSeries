// Главная страница и служебные ответы.
//
// Маршрут тонкий: разбор, выбор локали, вызов источника, отдача шаблона.
// Бизнес-логики здесь нет и не должно быть (ARCHITECTURE §1) — иначе её
// невозможно покрыть тестом без HTTP-сервера.

import express from 'express';

import { layout } from '../view/layout.js';
import { panelFor } from './panel.js';
import { homeView } from '../view/home.js';
import { collectHomeData } from '../services/home/data.js';
import { t, isLocale, DEFAULT_LOCALE } from '../i18n/strings.js';
import { html, raw } from '../view/render.js';
// Таблицы стилей этой страницы: общая плюс нужные группам. Список
// берётся из `src/config/styles.js`, порядок подключения — оттуда же.
const STYLES = [];


/** Страницы, которые не попадают в индекс (R-SEO-06). */
const NOINDEX_PATHS = ['/search', '/signin', '/signup', '/settings', '/notifications'];

export function createHomeRoutes({ data, sessionMw = null, panel = null }) {
  // strict: без него Express считает /ru и /ru/ одним адресом, и маршрут
  // «локо��ь без слеша» перехватывал бы /ru/, редиректя его на себя же.
  const router = express.Router({ strict: true });
  // Сессия ради меню аккаунта: без неё вошедший видел бы на этой странице
  // вход вместо аватара, и верхняя панель выглядела бы по-разному в
  // зависимости от раздела (UI-02). Гостю она ничего не стоит: у гостя нет
  // cookie сессии, значит и запроса в базу не будет.
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);


  // Локаль всегда в пути (ADR-003, R-SEO-01). Без префикса — 301 на русский.
  router.get('/:locale', (req, res, next) => {
    if (!isLocale(req.params.locale)) return next('route');
    return res.redirect(301, `/${req.params.locale}/`);
  });

  router.get('/:locale/', async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    try {
      const homeData = await collectHomeData(data, locale, req.session?.user?.id ?? null);
      const page = layout({
        styles: STYLES,
        account: req.account,
        locale,
        path: '/',
        title: t(locale, 'home.title'),
        description: t(locale, 'home.banners.empty'),
        body: homeView({ locale, data: homeData }),
        panel: await panelFor({ panel, locale, req }),
        noindex: NOINDEX_PATHS.includes('/'),
      });
      res.type('html').send(page.__raw);
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export function createNotFoundRoutes() {
  const router = express.Router({ strict: true });

  // Любой метод, а не только GET: служебные страницы (S-84) отвечают 404 и на
  // POST — прямым запросом. Иначе на такой запрос уходил бы стандартный
  // ответ Express на английском, и служебная страница выдавала бы себя.
  router.use('/:locale{/:rest}', (req, res) => {
    const locale = isLocale(req.params.locale) ? req.params.locale : DEFAULT_LOCALE;
    const path = `/${req.params.rest ?? ''}`;
    if (NOINDEX_PATHS.some((p) => path.startsWith(p))) {
      res.set('X-Robots-Tag', 'noindex, follow');
      return res.status(200).type('text/plain').send(t(locale, 'error.generic.title'));
    }
    res.set('X-Robots-Tag', 'noindex, follow');
    res.status(404).type('html').send(notFound(locale, req.account).__raw);
  });

  return router;
}

export function notFound(locale, account = null) {
  return layout({
    styles: STYLES,
    account,
    locale,
    path: '/404',
    title: `${t(locale, 'error.notFound.title')} — ${t(locale, 'app.title')}`,
    description: t(locale, 'error.notFound.text'),
    noindex: true,
    body: html`<section class="block block--message">
      <h1 class="message__title">${t(locale, 'error.notFound.title')}</h1>
      <p class="message__text">${t(locale, 'error.notFound.text')}</p>
      <ul class="message__links" role="list">
        <li><a href="/${locale}/series">${t(locale, 'error.notFound.catalogue')}</a></li>
        <li><a href="/${locale}/">${t(locale, 'error.notFound.home')}</a></li>
        <li><a href="/${locale}/search">${t(locale, 'error.notFound.search')}</a></li>
      </ul>
    </section>`,
  });
}

/**
 * Страницы ошибок (F-00-05, S-43).
 *
 * Каждая отвечает своим кодом и не содержит внутренних деталей: ни стека, ни
 * имён таблиц (R-SEC-33). Человеку — текст и следующий шаг.
 *
 * @param {string} locale
 * @param {'forbidden'|'tooMany'|'generic'} kind
 * @param {object} [extra] `minutes` — сколько ждать при 429
 * @returns {object}
 */
export function errorPage(locale, kind, extra = {}) {
  const keys = {
    forbidden: { title: 'error.forbidden.title', text: 'error.forbidden.text' },
    tooMany: { title: 'error.tooMany.title', text: 'error.tooMany.text' },
    generic: { title: 'error.generic.title', text: 'error.generic.text' },
  }[kind];
  return layout({
    styles: STYLES,
    locale,
    path: `/${kind}`,
    title: `${t(locale, keys.title)} — ${t(locale, 'app.title')}`,
    description: t(locale, keys.text),
    noindex: true,
    body: html`<section class="block block--message">
      <h1 class="message__title">${t(locale, keys.title)}</h1>
      <p class="message__text">${kind === 'tooMany'
    ? t(locale, keys.text, { minutes: extra.minutes ?? 1 })
    : t(locale, keys.text)}</p>
      <p><a class="button" href="/${locale}/">${t(locale, 'error.notFound.home')}</a></p>
    </section>`,
  });
}

/**
 * Страница непредвиденной ошибки.
 *
 * Наружу не попадает ничего: ни текста исключения, ни стека, ни адреса
 * соединения (R-SEC-33). Детали пишутся в журнал, но не посетителю.
 */
export function errorHandler(locale) {
  return (err, req, res, next) => {
    // Если ответ уже начат, второй раз отправить нельзя: Express бросит
    // ERR_HTTP_HEADERS_SENT, и настоящая ошибка потеряется за шумом.
    if (res.headersSent) return next(err);
    console.error('[error]', err?.stack ?? err);
    const loc = isLocale(req.params?.locale) ? req.params.locale : locale;
    res.status(500).type('html').send(errorPage(loc, 'generic').__raw);
  };
}

export const robots = () => `# Служебные разделы закрыты от индексации (R-SEO-06).
Disallow: /*/admin
Disallow: /*/mod
Disallow: /*/analytics
Disallow: /*/api

Sitemap: /sitemap.xml
`;

export { raw };