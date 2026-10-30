// Каталог сериалов (F-02-03, S-02).
//
// Состояние фильтров целиком в адресе: страницу можно отправить ссылкой, а
// человек с отключёнными скриптами получает ту же выдачу обычными ссылками и
// формой GET. Сервер состояния здесь не нужен и не заводится.

import express from 'express';

import { layout, pageTitle } from '../view/layout.js';
import { panelFor } from './panel.js';
import { menuGenres } from './menuGenres.js';
import { catalogueView, href } from '../view/catalogue.js';
import { genreView } from '../view/genre.js';
import { notFound } from './home.js';
import { t, isLocale } from '../i18n/strings.js';
import { tPlural } from '../i18n/plural.js';
// Таблицы стилей этой страницы: общая плюс нужные группам. Список
// берётся из `src/config/styles.js`, порядок подключения — оттуда же.
const STYLES = ['catalogue'];

const rawHtml = (page) => page.__raw;

/** Сортировки, о которых знает страница; порядок — как в фильтре. */
const SORT_KEYS = ['popular', 'rating', 'new', 'title'];

/**
 * Порог noindex страницы жанра: меньше шести сериалов — тонкий контент, в
 * поисковый индекс страница не отдаётся (F-02-04 §3).
 */
const NOINDEX_MIN_SERIES = 6;

const STATES = ['airing', 'waiting', 'announced', 'ended', 'cancelled'];

export function createCatalogueRoutes({ catalogue, genres = null, sessionMw = null, panel = null }) {
  const router = express.Router({ strict: true });
  // Сессия ради меню аккаунта: без неё вошедший видел бы на этой странице
  // вход вместо аватара, и верхняя панель выглядела бы по-разному в
  // зависимости от раздела (UI-02). Гостю она ничего не стоит: у гостя нет
  // cookie сессии, значит и запроса в базу не будет.
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);


  router.get('/:locale/series', async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    const filters = parseQuery(req.query);

    try {
      const page = await catalogue.list(filters);
      // EC-K6: страница за концом списка — не пустая страница, а последняя
      // страница. Постоянное перенаправление: адрес с `page=99999` таким и
      // останется мусором, а человек получит то, что просил.
      if (filters.page > page.pages) {
        return res.redirect(301, href(locale, { ...filters, page: page.pages }));
      }

      const bounds = await catalogue.filters({ networkSearch: filters.networkSearch });

      // R-SEO-02: фильтры, сортировка и страница канонизируются на базовый
      // адрес; пустая выдача не индексируется — иначе в индекс попадают
      // тысячи почти одинаковых пустых страниц.
      const noindex = page.items.length === 0;

      return res.status(200).type('html').send(rawHtml(layout({
        styles: STYLES,
        account: req.account,
        locale,
        path: '/series',
        title: pageTitle(locale, t(locale, 'catalog.title')),
        description: t(locale, 'catalog.description'),
        noindex,
        panel: await panelFor({ panel, locale, req }),
        genres: await menuGenres(genres, locale),
        body: catalogueView({ locale, page, bounds, filters, sorts: SORT_KEYS, states: STATES }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  // Жанр (S-03): страница — тот же движок каталога, но фильтр жанра задаёт
  // сервер, а не человек. Поэтому жанр берётся из адреса, и параметры запроса
  // ему изменить не могут; сортировки и страницы — из белого списка каталога.
  // жанр из запроса (`?genre=`) игнорируется молча: это не ошибка адреса, а
  // чужой параметр, который страница не воспринимает.
  router.get('/:locale/genres/:code', async (req, res, next) => {
    const { locale, code } = req.params;
    if (!isLocale(locale)) return next('route');

    try {
      const genre = genres ? await genres.one(code) : null;
      if (!genre) {
        // Неизвестный, сырой, выключенный и скрытый для меню жанр — 404
        // (F-02-04): у адреса нет ни замены, ни редиректа.
        return res.status(404).type('html').send(notFound(locale, req.account).__raw);
      }

      const filters = parseQuery(req.query);
      const page = await catalogue.list({ genres: [genre.code], sort: filters.sort, page: filters.page });
      // Эк-К6, как в каталоге: страница за концом — 301 на последнюю.
      if (filters.page > page.pages) {
        return res.redirect(301, genreHrefOf(locale, genre.code, filters.sort, page.pages));
      }

      return res.status(200).type('html').send(rawHtml(layout({
        styles: STYLES,
        account: req.account,
        locale,
        path: `/genres/${genre.code}`,
        title: pageTitle(locale, locale === 'en' ? genre.nameEn : genre.nameRu),
        // Описание — из справочника; там пусто — автотемплейт из числа
        // сериалов (F-10-10 §4): мета никогда не остаётся обманчивой.
        description: genreMetaDescription(locale, genre, page.total),
        // Тонкий контент не индексируется: порог из фичи, а не из вкуса.
        noindex: page.total < NOINDEX_MIN_SERIES,
        panel: await panelFor({ panel, locale, req }),
        genres: await menuGenres(genres, locale),
        body: genreView({ locale, genre, page, sorts: SORT_KEYS }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/**
 * Адрес страницы жанра с сортировкой и постраничностью для 301.
 *
 * Стандартные значения в адрес не пишем: народный адрес — без параметров.
 *
 * @param {string} locale
 * @param {string} code
 * @param {string} sort ключ из белого списка
 * @param {number} page
 */
function genreHrefOf(locale, code, sort, page) {
  const params = new URLSearchParams();
  if (sort && sort !== 'popular') params.set('sort', sort);
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return `/${locale}/genres/${code}${query ? `?${query}` : ''}`;
}

/**
 * Текст meta description: описание справочника, а без него — автотемплейт
 * с числом сериалов (F-10-10 §4).
 *
 * Обрезать — как в подборке (S-05): в поисковую выдачу смысл вышли вытянут
 * сами, а обманчивой полноты не обещаем.
 *
 * @param {string} locale
 * @param {{nameRu: string, nameEn: string, descriptionRu: string|null,
 *   descriptionEn: string|null}} genre
 * @param {number} count число видимых сериалов жанра
 */
function genreMetaDescription(locale, genre, count) {
  const name = locale === 'en' ? genre.nameEn : genre.nameRu;
  const own = ((locale === 'en' ? genre.descriptionEn : genre.descriptionRu) ?? '').trim();
  const other = ((locale === 'en' ? genre.descriptionRu : genre.descriptionEn) ?? '').trim();
  const text = own || other;
  return (text || tPlural(locale, 'genre.meta', count, { name })).slice(0, 160);
}

/**
 * Разбор адреса в фильтры.
 *
 * Недопустимое значение не превращается в ошибку, а отбрасывается: адрес
 * собирают руками, и «`?year=abc`» должен показать базовый список, а не 400
 * (F-02-03 §4).
 *
 * @param {Record<string, unknown>} query
 * @returns {{genres: string[], yearFrom: number|null, yearTo: number|null,
 *   ratingFrom: number|null, states: string[], countries: string[],
 *   networks: string[], networkSearch: string, sort: string, page: number}}
 */
export function parseQuery(query) {
  const list = (value) => (Array.isArray(value) ? value : [value])
    .filter((item) => typeof item === 'string')
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean);

  const years = /^\s*(\d{4})\s*(?:[–-]\s*(\d{4})\s*)?$/.exec(String(query.year ?? ''));
  const from = years ? Number(years[1]) : null;
  const to = years ? Number(years[2] ?? years[1]) : null;
  const rating = Number(query.rating);

  return {
    genres: list(query.genre),
    // Перепутанные границы не молча меняются местами, а отбрасываются: молчаливая
    // подмена превращала бы «2010-2020» в «2020-2010» и показывала бы не то,
    // что человек написал.
    yearFrom: from && (!to || from <= to) ? from : null,
    yearTo: to && (!from || from <= to) ? to : null,
    ratingFrom: Number.isFinite(rating) && query.rating !== undefined && query.rating !== '' && rating <= 10
      ? rating
      : null,
    states: list(query.state).filter((state) => STATES.includes(state)),
    countries: list(query.country),
    networks: list(query.network),
    // Поиск по справочнику не часть фильтра: он сужает список вариантов и
    // остаётся в форме, чтобы его можно было уточнить, не теряя выбор.
    networkSearch: typeof query.network_q === 'string' ? query.network_q.slice(0, 60) : '',
    sort: SORT_KEYS.includes(String(query.sort)) ? String(query.sort) : 'popular',
    page: Number.isInteger(Number(query.page)) && Number(query.page) >= 1 ? Number(query.page) : 1,
  };
}
