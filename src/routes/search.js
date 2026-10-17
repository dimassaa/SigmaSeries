// Поиск: страница результатов и подсказки (F-02-06, S-17, UI-09).
//
// Маршрут тонкий: разбор адреса, лимит частоты, вызов источника, отдача вида.
// Правила нормализации живут в `src/services/search/query.js`, данные — в
// `service.js`, и обе части проверяются отдельно.

import express from 'express';

import { layout } from '../view/layout.js';
import { panelFor } from './panel.js';
import { searchView } from '../view/search.js';
import { t, isLocale } from '../i18n/strings.js';
import { DEFAULT_RATE_PER_MINUTE } from '../services/search/limits.js';

const rawHtml = (page) => page.__raw;

/**
 * Счётчик запросов поиска по адресу сети.
 *
 * В памяти процесса, как и лимиты входа (`limits.js`): лимит защищает от
 * случайного перебора и от человека, который забыл закрыть страницу, а не от
 * распределённой атаки — для второй нужен общий счётчик, и это отдельное
 * решение (F-02-06 §7, R-SEC-31).
 *
 * @type {Map<string, number[]>}
 */
const hits = new Map();

/** Окно, за которое считаются запросы. */
const WINDOW_MS = 60_000;

/**
 * Превышен ли лимит частоты для адреса.
 *
 * @param {string} ip
 * @param {number} rate сколько запросов допустимо за окно
 * @param {number} [now]
 * @returns {boolean}
 */
export function searchLimited(ip, rate, now = Date.now()) {
  const times = (hits.get(ip) ?? []).filter((time) => now - time < WINDOW_MS);
  if (times.length >= rate) return true;
  times.push(now);
  hits.set(ip, times);
  // Периодическая чистка: без неё карта растёт по числу заходивших адресов и
  // никогда не сжимается.
  if (hits.size > 5000) {
    for (const [key, list] of hits) {
      if (!list.some((time) => now - time < WINDOW_MS)) hits.delete(key);
    }
  }
  return false;
}

export function createSearchRoutes({
  search, ratePerIp = DEFAULT_RATE_PER_MINUTE, sessionMw = null, panel = null,
}) {
  const router = express.Router({ strict: true });
  // Сессия ради меню аккаунта: без неё вошедший видел бы на этой странице
  // вход вместо аватара, и верхняя панель выглядела бы по-разному в
  // зависимости от раздела (UI-02). Гостю она ничего не стоит: у гостя нет
  // cookie сессии, значит и запроса в базу не будет.
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);


  router.get('/:locale/search', async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const query = String(req.query.q ?? '');
    if (searchLimited(req.ip, ratePerIp)) {
      return res.status(429)
        .set('Retry-After', String(Math.ceil(WINDOW_MS / 1000)))
        .type('html')
        .send(rawHtml(layout({
          account: req.account,
          locale,
          path: '/search',
          title: t(locale, 'search.title'),
          description: t(locale, 'search.description'),
          noindex: true,
          panel: await panelFor({ panel, locale, req }),
          body: searchView({ locale, query, result: null, genres: await popularGenres(search) }),
        })));
    }

    try {
      const result = await search.find({ query, offsets: offsetsFrom(req.query.from) });
      return res.status(200).type('html').send(rawHtml(layout({
        account: req.account,
        locale,
        path: '/search',
        title: query ? t(locale, 'search.titleWith', { query }) : t(locale, 'search.title'),
        description: t(locale, 'search.description'),
        // Страница поиска в индексе не нужна: это фильтр каталога, а не
        // самостоятельный адрес (`SCREENS` §9, S-17 — noindex).
        noindex: true,
        panel: await panelFor({ panel, locale, req }),
        body: searchView({
          locale,
          query,
          result,
          genres: result.total === 0 ? await popularGenres(search) : [],
        }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  // Подсказки отдаются данными: их подставляет поле в верхней панели, и HTML
  // здесь был бы лишней разметкой на каждый введённый символ.
  router.get('/:locale/search/suggest', async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    if (searchLimited(req.ip, ratePerIp)) {
      return res.status(429)
        .set('Retry-After', String(Math.ceil(WINDOW_MS / 1000)))
        .type('application/json')
        .send('{"error":"rate_limited"}');
    }

    try {
      const result = await search.suggest({ query: String(req.query.q ?? '') });
      return res.status(200)
        .set('Cache-Control', 'no-store')
        .type('application/json')
        .send(JSON.stringify(result));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/**
 * Смещения групп из адреса.
 *
 * Формат — `from=группа:сколько`, по одному параметру на группу: точка в
 * имени параметра не годится, Express 5 разбирает адрес простым парсером и
 * оставил бы `from.series=24` именем с точкой, а не объектом.
 *
 * Только целые неотрицательные: строка из адреса не должна превращаться в
 * `NaN` и обнулять группу, а отрицательное смещение показывало бы вторую
 * страницу вместо первой.
 *
 * @param {unknown} raw значение параметра `from`
 * @returns {{series: number, people: number, collections: number}}
 */
function offsetsFrom(raw) {
  const groups = { series: 0, people: 0, collections: 0 };
  const values = Array.isArray(raw) ? raw : [raw];

  for (const value of values) {
    const [name, count] = String(value ?? '').split(':');
    if (!(name in groups)) continue;
    const offset = Number(count);
    if (Number.isInteger(offset) && offset >= 0) groups[name] = offset;
  }

  return groups;
}

/**
 * Популярные жанры для пустого состояния.
 *
 * Подсказка «попробуйте жанр» работает только если есть чем попробовать, а
 * список жанров — это уже готовая навигация (S-03).
 *
 * @param {object} search
 * @returns {Promise<{code: string, title: string}[]>}
 */
function popularGenres(search) {
  return search.genres().catch(() => []);
}