// Адреса сезона и серии (F-02-02, S-07 и S-08).
//
// Маршрут тонкий: разбор адреса, проверка видимости, отдача вида. Правила
// тонких страниц (H-35) и 410 у снятых — здесь, данные — в
// `src/services/catalogue/season.js`.

import express from 'express';

import { layout } from '../view/layout.js';
import { notFound } from './home.js';
import { seasonView, episodeView } from '../view/season.js';
import { goneView } from '../view/series.js';
import { t, isLocale } from '../i18n/strings.js';

const rawHtml = (page) => page.__raw;

/** Номер сезона и серии — целое и в границах (F-02-02 §валидация). */
const number = (value, min) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min ? parsed : null;
};

export function createSeasonRoutes({ seasons }) {
  const router = express.Router({ strict: true });

  router.get('/:locale/series/:slug/seasons/:season', async (req, res, next) => {
    const { locale, slug } = req.params;
    if (!isLocale(locale)) return next('route');

    const seasonNumber = number(req.params.season, 0);
    if (seasonNumber === null) return res.status(404).type('html').send(notFound(locale).__raw);

    try {
      const found = await seasons.season(slug, seasonNumber);
      // Отсутствие сезона у видимого сериала и отсутствие сериала — одно и то же
      // для посетителя: такого адреса нет. Различие живёт в источнике.
      if (!found) return res.status(404).type('html').send(notFound(locale).__raw);

      const path = `/series/${slug}/seasons/${seasonNumber}`;
      return res.status(200).type('html').send(rawHtml(layout({
        locale,
        path,
        title: t(locale, 'season.title', {
          series: found.series.title,
          season: seasonNumber,
        }),
        description: t(locale, 'season.description', {
          series: found.series.title,
          season: seasonNumber,
        }),
        noindex: locale === 'en' && !found.series.titleOriginal,
        body: seasonView({ locale, page: found, slug }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:locale/series/:slug/seasons/:season/episodes/:episode', async (req, res, next) => {
    const { locale, slug } = req.params;
    if (!isLocale(locale)) return next('route');

    const seasonNumber = number(req.params.season, 0);
    const episodeNumber = number(req.params.episode, 1);
    if (seasonNumber === null || episodeNumber === null) {
      return res.status(404).type('html').send(notFound(locale).__raw);
    }

    try {
      const found = await seasons.episode(slug, seasonNumber, episodeNumber);
      if (!found) return res.status(404).type('html').send(notFound(locale).__raw);

      const path = `/series/${slug}/seasons/${seasonNumber}/episodes/${episodeNumber}`;
      return res.status(200).type('html').send(rawHtml(layout({
        locale,
        path,
        title: found.episode.title
          ? t(locale, 'episode.title', { title: found.episode.title, series: found.series.title })
          : t(locale, 'episode.titleNumber', { number: episodeNumber, series: found.series.title }),
        description: found.episode.description.slice(0, 160),
        // H-35: страница серии индексируется только с описанием и датой не
        // позже сегодняшней. Тонкие страницы — это тысячи почти пустых адресов.
        noindex: found.episode.thin || (locale === 'en' && !found.episode.descriptionRu),
        jsonLd: episodeJsonLd({ locale, page: found, seasonNumber, episodeNumber }),
        body: episodeView({ locale, page: found, slug }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/**
 * Разметка schema.org для серии.
 *
 * Без неё в выдаче поисковика серия без рейтинга и описания, а `SEO` §2 требует
 * тип для страниц S-08.
 */
function episodeJsonLd({ locale, page, seasonNumber, episodeNumber }) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'TVEpisode',
    name: page.episode.title || `Season ${seasonNumber}, episode ${episodeNumber}`,
    url: `/${locale}/series/${page.series.slug}/seasons/${seasonNumber}/episodes/${episodeNumber}`,
    seasonNumber,
    episodeNumber,
  };
  if (page.episode.description) data.description = page.episode.description;
  if (page.episode.date) data.datePublished = page.episode.date;
  return data;
}