// Оболочка страницы: <head>, шапка, переключатели, подвал.
//
// Здесь то, что обязано быть на каждом экране и что легко забыть:
// единственный h1, ссылка «перейти к содержимому», видимый фокус,
// canonical и взаимные hreflang (R-SEO-02, R-SEO-03, R-A11Y-04).

import { html, raw, attr, esc } from './render.js';
import { t, LOCALES, LOCALE_NAMES, DEFAULT_LOCALE } from '../i18n/strings.js';

/**
 * Собирает полный документ.
 *
 * @param {object} page
 * @param {string} page.locale
 * @param {string} page.title готовый заголовок страницы
 * @param {string} page.description
 * @param {string} page.path путь без локали, например «/»
 * @param {object} [page.body] фрагмент содержимого
 * @param {boolean} [page.noindex] служебная страница
 * @param {string} [page.theme] системная тема пользователя, известная заранее
 */
export function layout(page) {
  const { locale, title, description, path, body = '', noindex = false, jsonLd = null } = page;
  const other = LOCALES.find((l) => l !== locale);
  const canonical = `/${locale}${path === '/' ? '/' : path}`;

  const head = html`<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
${noindex ? html`<meta name="robots" content="noindex, follow">` : ''}
<link rel="canonical" href="${canonical}">
${LOCALES.map((l) => html`<link rel="alternate" hreflang="${l}" href="/${l}${path === '/' ? '/' : path}">`)}
<link rel="alternate" hreflang="x-default" href="/${DEFAULT_ROUTE(path)}">
${jsonLd ? html`<script type="application/ld+json">${raw(JSON.stringify(jsonLd))}</script>` : ''}
<link rel="stylesheet" href="/app.css">
<script>
  // Тема ставится до первой отрисовки, иначе на тёмной теме виден белый
  // кадр. Ранний скрипт — единственное место, где JS в <head> оправдан.
  (function () {
    try {
      var t = localStorage.getItem('theme');
      if (!t || t === 'system') {
        t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      }
      document.documentElement.dataset.theme = t;
    } catch (e) { document.documentElement.dataset.theme = 'dark'; }
  })();
</script>`;

  const localeLinks = LOCALES.map((l) => html`<a class="topbar__lang" href="/${l}${path === '/' ? '/' : path}"
    hreflang="${l}" lang="${l}"
    ${l === locale ? raw('aria-current="true"') : ''}
    aria-label="${t(locale, 'app.locale.switchTo', { language: LOCALE_NAMES[l] })}">${LOCALE_NAMES[l]}</a>`);

  const bodyHtml = html`<body class="page">
<a class="skip-link" href="#main">${t(locale, 'app.skipToContent')}</a>

<header class="topbar">
  <a class="topbar__brand" href="/${locale}/">${t(locale, 'app.title')}</a>
  <nav class="topbar__nav" aria-label="${t(locale, 'nav.catalog')}">
    <a href="/${locale}/series">${t(locale, 'nav.catalog')}</a>
    <a href="/${locale}/calendar">${t(locale, 'nav.calendar')}</a>
  </nav>
  <div class="topbar__controls">
    <button type="button" class="topbar__theme" data-theme-toggle
            aria-label="${t(locale, 'app.theme.toggle')}">◐</button>
    <div class="topbar__locales">${localeLinks}</div>
    <a class="topbar__signin" href="/${locale}/login">${t(locale, 'nav.signIn')}</a>
  </div>
</header>

<main id="main" class="content">${raw(body)}</main>
</body>`;

  return html`<!DOCTYPE html>
<html lang="${locale}" data-theme="${page.theme ?? 'dark'}">
<head>
${head}
</head>
${bodyHtml}</html>`;
}

/**
 * Адрес для x-default.
 *
 * Указывает на русскую версию: проект русскоязычный, и автоопределение по
 * браузеру уводило бы англоязычного посетителя в английский интерфейс с
 * русскими описаниями (ADR-003). Префикс локали тут обязателен — иначе
 * адрес получается относительным и ведёт в никуда.
 */
function DEFAULT_ROUTE(path) {
  return `/${DEFAULT_LOCALE}${path}`;
}

export { esc };