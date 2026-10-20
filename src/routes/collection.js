// Подборка (F-02-05, S-05) и персона (F-02-09, S-15).
//
// Оба адреса строятся потому, что их предлагают поиск и карточка сериала, а
// они вели в 404. Маршруты тонкие: разбор адреса, вызов источника, отдача вида.
// Тонкость адреса живёт в источнике — «подборки из пяти сериалов не существует»
// это не 404 в маршруте, а решение источника.

import express from 'express';

import { layout, pageTitle } from '../view/layout.js';
import { panelFor } from './panel.js';
import { collectionView } from '../view/collection.js';
import { personView } from '../view/person.js';
import { notFound } from './home.js';
import { t, isLocale } from '../i18n/strings.js';
// Таблицы стилей этой страницы: общая плюс нужные группам. Список
// берётся из `src/config/styles.js`, порядок подключения — оттуда же.
const STYLES = ['collection'];


const rawHtml = (page) => page.__raw;

export function createCollectionRoutes({ collections, person, sessionMw = null, panel = null }) {
  const router = express.Router({ strict: true });
  // Сессия ради меню аккаунта: без неё вошедший видел бы на этой странице
  // вход вместо аватара, и верхняя панель выглядела бы по-разному в
  // зависимости от раздела (UI-02). Гостю она ничего не стоит: у гостя нет
  // cookie сессии, значит и запроса в базу не будет.
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);


  router.get('/:locale/collections/:slug', async (req, res, next) => {
    const { locale, slug } = req.params;
    if (!isLocale(locale)) return next('route');

    try {
      const found = await collections.collection(slug);
      if (!found) return res.status(404).type('html').send(notFound(locale, req.account).__raw);

      return res.status(200).type('html').send(rawHtml(layout({
        styles: STYLES,
        account: req.account,
        locale,
        path: `/collections/${slug}`,
        title: pageTitle(locale, found.title),
        description: found.description.slice(0, 160),
        // Описание подборки — текст редакции, перевода на английский у него
        // нет, поэтому английский адрес остаётся открытым, но не индексируется
        // (R-SEO-04).
        noindex: locale === 'en',
        jsonLd: collectionJsonLd({ locale, collection: found }),
        panel: await panelFor({ panel, locale, req }),
        body: collectionView({ locale, collection: found }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:locale/people/:slug', async (req, res, next) => {
    const { locale, slug } = req.params;
    if (!isLocale(locale)) return next('route');

    // Страница сетки: не число — первая. Иначе `?page=abc` показал бы вторую
    // страницу вместо сообщения об ошибке.
    const raw = String(req.query.page ?? '1');
    const page = /^\d+$/.test(raw) ? Number(raw) : 1;

    try {
      const found = await person.person(slug, { page });
      if (!found) return res.status(404).type('html').send(notFound(locale, req.account).__raw);

      return res.status(200).type('html').send(rawHtml(layout({
        styles: STYLES,
        account: req.account,
        locale,
        path: `/people/${slug}`,
        title: pageTitle(locale, found.name),
        description: t(locale, 'person.description', { name: found.name }),
        // Человек с одним сериалом в индексе не нужен: странице нечего
        // предложить, кроме имени, которое и так видно в выдаче сериала
        // (F-02-09 §3).
        noindex: found.thin,
        jsonLd: personJsonLd({ locale, person: found }),
        body: personView({ locale, person: found }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

function collectionJsonLd({ locale, collection: found }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: found.title,
    url: `/${locale}/collections/${found.slug}`,
    hasPart: found.series.map((item) => ({
      '@type': 'TVSeries',
      name: item.title,
      url: `/${locale}/series/${item.slug}`,
    })),
  };
}

function personJsonLd({ locale, person: found }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: found.name,
    url: `/${locale}/people/${found.slug}`,
    jobTitle: found.roles.join(', ') || undefined,
  };
}