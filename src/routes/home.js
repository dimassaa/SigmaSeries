// Главная страница и служебные ответы.
//
// Маршрут тонкий: разбор, выбор локали, вызов источника, отдача шаблона.
// Бизнес-логики здесь нет и не должно быть (ARCHITECTURE §1) — иначе её
// невозможно покрыть тестом без HTTP-сервера.

import express from 'express';

import { layout } from '../view/layout.js';
import { homeView } from '../view/home.js';
import { collectHomeData } from '../services/home/data.js';
import { t, isLocale, DEFAULT_LOCALE } from '../i18n/strings.js';
import { html, raw } from '../view/render.js';

/** Страницы, которые не попадают в индекс (R-SEO-06). */
const NOINDEX_PATHS = ['/search', '/signin', '/signup', '/settings', '/notifications'];

export function createHomeRoutes({ data }) {
  // strict: без него Express считает /ru и /ru/ одним адресом, и маршрут
  // «локо��ь без слеша» перехватывал бы /ru/, редиректя его на себя же.
  const router = express.Router({ strict: true });

  // Локаль всегда в пути (ADR-003, R-SEO-01). Без префикса — 301 на русский.
  router.get('/:locale', (req, res, next) => {
    if (!isLocale(req.params.locale)) return next('route');
    return res.redirect(301, `/${req.params.locale}/`);
  });

  router.get('/:locale/', async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    try {
      const homeData = await collectHomeData(data, locale);
      const page = layout({
        locale,
        path: '/',
        title: t(locale, 'home.title'),
        description: t(locale, 'home.banners.empty'),
        body: homeView({ locale, data: homeData }),
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

  // Служебные адреса отвечают заголовком, а не страницей: поисковику
  // достаточно сигнала, а человеку — пустой экран не нужен.
  router.get('/:locale{/:rest}', (req, res) => {
    const locale = isLocale(req.params.locale) ? req.params.locale : DEFAULT_LOCALE;
    const path = `/${req.params.rest ?? ''}`;
    if (NOINDEX_PATHS.some((p) => path.startsWith(p))) {
      res.set('X-Robots-Tag', 'noindex, follow');
      return res.status(200).type('text/plain').send(t(locale, 'error.generic.title'));
    }
    res.set('X-Robots-Tag', 'noindex, follow');
    res.status(404).type('html').send(notFound(locale).__raw);
  });

  return router;
}

function notFound(locale) {
  return layout({
    locale,
    path: '/404',
    title: `${t(locale, 'error.notFound.title')} — ${t(locale, 'app.title')}`,
    description: t(locale, 'error.notFound.text'),
    noindex: true,
    body: html`<section class="block block--message">
      <h1 class="message__title">${t(locale, 'error.notFound.title')}</h1>
      <p class="message__text">${t(locale, 'error.notFound.text')}</p>
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
    res.status(500).type('html').send(layout({
      locale: loc,
      path: '/500',
      title: `${t(loc, 'error.generic.title')} — ${t(loc, 'app.title')}`,
      description: t(loc, 'error.generic.text'),
      noindex: true,
      body: html`<section class="block block--message">
        <h1 class="message__title">${t(loc, 'error.generic.title')}</h1>
        <p class="message__text">${t(loc, 'error.generic.text')}</p>
      </section>`,
    }).__raw);
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