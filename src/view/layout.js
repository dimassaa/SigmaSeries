// Оболочка страницы: <head>, шапка, переключатели, подвал.
//
// Здесь то, что обязано быть на каждом экране и что легко забыть:
// единственный h1, ссылка «перейти к содержимому», видимый фокус,
// canonical и взаимные hreflang (R-SEO-02, R-SEO-03, R-A11Y-04).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { html, raw, attr, esc, when } from './render.js';
import { t, LOCALES, LOCALE_NAMES, DEFAULT_LOCALE } from '../i18n/strings.js';
import { SEARCH_SETTINGS } from '../config/settings.js';
import { styleGroups } from '../config/styles.js';

/**
 * Версия файлов статики.
 *
 * Ссылка на стиль и скрипт несёт версию: после сборки она меняется, и
 * браузер перезапрашивает файл вместо того, чтобы доиспользовать старый до
 * истечения кэша. Без этого правка стилей доезжала до людей через час, а
 * иногда и через год.
 */
const ASSET_VERSION = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    return readFileSync(path.resolve(here, '../../public/asset-version.txt'), 'utf8').trim();
  } catch {
    return '';
  }
})();

/**
 * `<title>` контентной страницы по таблице шаблонов (SEO §2).
 *
 * Служебные страницы собирают суффикс сами и через «—» — их стиль сложился
 * на регистрации и в настройках; у индексируемых контентных страниц суффикс
 * ровно из таблицы: «… · {Бренд}». Единая точка сборки нужна затем, что
 * бренд — одно слово для всего сайта, и разъехаться он может только через
 * независимые конкатенации в маршрутах.
 *
 * @param {string} locale
 * @param {string} middle середина заголовка из таблицы шаблонов
 * @returns {string}
 */
/**
 * Текст JSON-LD для вставки в `<script>`.
 *
 * `<` заменяется на `\u003c`: иначе данные с `</script>` закрывают тег раньше
 * времени, и дальше идёт уже не разметка, а код (R-SEC-15).
 *
 * @param {any} data
 * @returns {string}
 */
function jsonLdText(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

export function pageTitle(locale, middle) {
  return `${middle} · ${t(locale, 'app.title')}`;
}

/**
 * Собирает полный документ.
 *
 * @param {object} page
 * @param {string} page.locale
 * @param {string} page.title готовый заголовок страницы
 * @param {string} page.description
 * @param {string} page.path путь без локали, например «/»
 * @param {any} [page.body] фрагмент содержимого
 * @param {boolean} [page.noindex] служебная страница
 * @param {string} [page.theme] тема страницы: выбор человека из профиля
 *   (в `page.account.theme`), «system» — если выбора нет
 * @param {string[]} [page.styles] группы таблиц стилей, нужные странице;
 *   без списка подключаются все (см. `src/config/styles.js`)
 * @param {string} [page.panel] готовая разметка правой панели; без неё панели нет
 * @param {{nickname: string, unread: number, pollSeconds?: number}|null} [page.account]
 *   меню аккаунта; `null` — гость, и вместо меню показывается вход
 */
/**
 * Подвал: ссылки на служебные страницы.
 *
 * Ссылки «О данных» и «Приватность» есть на всех страницах, включая
 * страницы ошибок (F-00-05 §8в).
 *
 * @param {object} args
 * @param {string} args.locale
 * @returns {any}
 */
function footer({ locale }) {
  return html`
<footer class="page__footer">
  <nav class="page__footer-links" aria-label="${t(locale, 'footer.label')}">
    <a href="/${locale}/about">${t(locale, 'page.about.title')}</a>
    <a href="/${locale}/rules">${t(locale, 'page.rules.title')}</a>
    <a href="/${locale}/privacy">${t(locale, 'page.privacy.title')}</a>
  </nav>
</footer>`;
}

export function layout(page) {
  const {
    locale, title, description, path, body = '', noindex = false, jsonLd = null, styles = null,
  } = page;
  const other = LOCALES.find((l) => l !== locale);
  const canonical = `/${locale}${path === '/' ? '/' : path}`;

  // Таблицы стилей — по экранам: общая плюс те, что нужны странице. Порядок
  // задан списком групп, иначе правила перебивали бы друг друга иначе, чем
  // в одной общей таблице.
  const styleLinks = styleGroups(styles)
    .map((name) => `<link rel="stylesheet" href="/css/${name}.css${ASSET_VERSION ? `?v=${ASSET_VERSION}` : ''}">`)
    .join('\n');

  const head = html`<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
${noindex ? html`<meta name="robots" content="noindex, follow">` : ''}
<link rel="canonical" href="${canonical}">
${LOCALES.map((l) => html`<link rel="alternate" hreflang="${l}" href="/${l}${path === '/' ? '/' : path}">`)}
<link rel="alternate" hreflang="x-default" href="/${DEFAULT_ROUTE(path)}">
${jsonLd ? html`<script type="application/ld+json">${raw(jsonLdText(jsonLd))}</script>` : ''}
${raw(styleLinks)}
<!-- Клиентский скрипт — на каждой странице: без него не работают переключатель
     темы, «Полезно» без перезагрузки, диалог жалобы, показ пароля и
     сохранение прокрутки при смене языка. Атрибут defer не блокирует
     отрисовку, а ранняя подстановка темы остаётся инлайном ниже. -->
<script src="/app.js${ASSET_VERSION ? `?v=${ASSET_VERSION}` : ''}" defer></script>
<script>
  // Тема ставится до первой отрисовки, иначе на тёмной теме виден белый
  // кадр. Ранний скрипт — единственное место, где JS в <head> оправдан.
  //
  // Сервер — источник правды: в разметке уже стоит тема человека (из
  // профиля). Перезаписывать её своим значением нельзя, иначе выбор из
  // профиля не действует ни на одной странице. Разрешается только «системная»
  // тема: её браузер знает лучше сервера.
  (function () {
    try {
      var t = document.documentElement.dataset.theme;
      if (!t || t === 'system') {
        t = localStorage.getItem('theme');
        if (!t || t === 'system') {
          t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        }
      }
      document.documentElement.dataset.theme = t;
    } catch (e) { document.documentElement.dataset.theme = 'dark'; }
  })();
</script>`;

  const localeLinks = LOCALES.map((l) => html`<a class="topbar__lang" href="/${l}${path === '/' ? '/' : path}"
    hreflang="${l}" lang="${l}"
    ${l === locale ? raw('aria-current="true"') : ''}
    aria-label="${t(locale, 'app.locale.switchTo', { language: LOCALE_NAMES[l] })}"><span
    class="topbar__lang-full">${LOCALE_NAMES[l]}</span><span
    class="topbar__lang-short" aria-hidden="true">${l.toUpperCase()}</span></a>`);

  const bodyHtml = html`<body class="page" data-page-type="${page.pageType ?? 'other'}">
<a class="skip-link" href="#main">${t(locale, 'app.skipToContent')}</a>

<header class="topbar">
  <a class="topbar__brand" href="/${locale}/">${t(locale, 'app.title')}</a>
  <nav class="topbar__nav" aria-label="${t(locale, 'nav.catalog')}">
    <a href="/${locale}/series">${t(locale, 'nav.catalog')}</a>
    <a href="/${locale}/calendar">${t(locale, 'nav.calendar')}</a>
  </nav>
  <form class="topbar__search" method="get" action="/${locale}/search" role="search"
        data-search data-debounce="${SEARCH_SETTINGS.suggestDebounceMs}">
    <label class="visually-hidden" for="topbar-q">${t(locale, 'search.field')}</label>
    <input class="topbar__search-input" id="topbar-q" type="search" name="q"
           placeholder="${t(locale, 'search.placeholder')}" autocomplete="off"
           role="combobox" aria-expanded="false" aria-controls="search-suggestions"
           aria-autocomplete="list" data-search-input>
    <span class="visually-hidden" role="status" data-search-status></span>
  </form>
  <div class="topbar__controls">
    <button type="button" class="topbar__theme" data-theme-toggle
            data-theme-csrf="${page.account?.csrf ?? ''}"
            aria-label="${t(locale, 'app.theme.toggle')}">◐</button>
    <div class="topbar__locales">${localeLinks}</div>
    ${when(page.account, () => accountMenu({ locale, account: page.account, poll: page.account.pollSeconds ?? 0 }),
      () => html`<a class="topbar__signin" href="/${locale}/login">${t(locale, 'nav.signIn')}</a>`)}
  </div>
</header>

<div class="page__body${page.panel ? ' page__body--panel' : ''}">
  <main id="main" class="content">${raw(body)}</main>
  ${page.panel ? raw(page.panel) : ''}
</div>

${footer({ locale })}
</body>`;

  return html`<!DOCTYPE html>
<html lang="${locale}" data-theme="${page.theme ?? page.account?.theme ?? 'system'}"
      data-consent-title="${t(locale, 'analytics.consent.title')}"
      data-consent-text="${t(locale, 'analytics.consent.text')}"
      data-consent-allow="${t(locale, 'analytics.consent.allow')}"
      data-consent-decline="${t(locale, 'analytics.consent.decline')}"
      data-offline-text="${t(locale, 'error.offline.title')}"
      data-offline-retry="${t(locale, 'error.offline.retry')}">
<head>
${head}
</head>
${bodyHtml}</html>`;
}

/**
 * Меню аккаунта: аватар, красная точка и ссылки (UI-02, UI-11).
 *
 * Без скрипта: раскрытие на `<details>`, поэтому меню работает и при выключенном
 * JavaScript. Красная точка — не единственный признак непрочитанных: в меню
 * стоит число, а точка помечает аватар (R-A11Y-19).
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {{nickname: string, unread: number, csrf: string}} args.account
 * @param {string} args.poll период опроса в секундах; `0` — не опрашивать
 * @returns {any}
 */
function accountMenu({ locale, account, poll }) {
  const letter = (account.nickname ?? '?').trim().charAt(0).toUpperCase();
  const counter = account.unread > 99 ? '99+' : String(account.unread);

  return html`
<details class="account" data-account-menu${poll ? raw(` data-notify-poll="${poll}"`) : ''}>
  <summary class="account__avatar" aria-label="${t(locale, 'account.menu')}">
    <span class="account__letter" aria-hidden="true">${letter}</span>
    ${when(account.unread > 0, () => html`
    <span class="account__dot" data-unread-dot aria-hidden="true"></span>`)}
  </summary>
  <div class="account__menu">
    <a class="account__link" href="/${locale}/notifications">
      ${t(locale, 'account.notifications')}${account.unread > 0 ? ` · ${counter}` : ''}
      ${when(account.unread > 0, () => html`<span class="visually-hidden" data-unread-count>${counter}</span>`)}
    </a>
    <a class="account__link" href="/${locale}/settings">${t(locale, 'account.settings')}</a>
    <!-- Форма, а не ссылка: выход отзывает сессию на сервере, то есть меняет
         состояние, и R-SEC-23 требует токен на всех изменяющих запросах.
         Ссылка на выход выбила бы человека из аккаунта с чужой страницы. -->
    <form class="account__form" method="post" action="/${locale}/logout">
      <input type="hidden" name="csrf" value="${account.csrf}">
      <button class="account__link account__link--signout" type="submit"
        >${t(locale, 'signout.submit')}</button>
    </form>
  </div>
</details>`;
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