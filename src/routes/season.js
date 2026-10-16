// Адреса сезона и серии (F-02-02, S-07 и S-08).
//
// Маршрут тонкий: разбор адреса, проверка видимости, отдача вида. Правила
// тонких страниц (H-35) и 410 у снятых — здесь, данные — в
// `src/services/catalogue/season.js`.

import express from 'express';

import { layout } from '../view/layout.js';
import { notFound } from './home.js';
import { seasonView, episodeView } from '../view/season.js';
import { csrfToken } from '../services/auth/session.js';
import { timezoneOf, todayIn } from '../services/timezone.js';
import { UNDO_WINDOW_SECONDS } from '../services/tracking/marks.js';
import { goneView } from '../view/series.js';
import { t, isLocale } from '../i18n/strings.js';

const rawHtml = (page) => page.__raw;

/** Номер сезона и серии — целое и в границах (F-02-02 §валидация). */
const number = (value, min) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min ? parsed : null;
};

export function createSeasonRoutes({ seasons, sessionMw = null, series = null }) {
  const router = express.Router({ strict: true });
  // Сессия нужна ради отметок: гость видит такую же строку серии, но без
  // флажка, а вошедший — с отметкой.
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  router.get('/:locale/series/:slug/seasons/:season', async (req, res, next) => {
    const { locale, slug } = req.params;
    if (!isLocale(locale)) return next('route');

    const seasonNumber = number(req.params.season, 0);
    if (seasonNumber === null) return res.status(404).type('html').send(notFound(locale).__raw);

    try {
      const marks = marksOf(req);
      const found = await seasons.season(slug, seasonNumber, marks.options);
      // Отсутствие сезона у видимого сериала и отсутствие сериала — одно и то же
      // для посетителя: такого адреса нет. Различие живёт в источнике.
      //
      // Снятый с публикации — исключение: сериал был, и человек должен об этом
      // узнать, поэтому 410, а не 404 (EC-C1, как на странице сериала).
      if (!found) return sendMissing({ res, locale, slug, series });

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
        body: seasonView({
          locale,
          page: found,
          slug,
          marks,
          notice: String(req.query.mark ?? '') || null,
          noticeMarked: Number(req.query.marked ?? 0) || 0,
          noticeBatch: req.query.batch ? Number(req.query.batch) : null,
        }),
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
      const marks = marksOf(req);
      const found = await seasons.episode(slug, seasonNumber, episodeNumber, marks.options);
      if (!found) return sendMissing({ res, locale, slug, series });

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
        body: episodeView({ locale, page: found, slug, marks }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/**
 * Ответ на адрес, страницы для которого нет: 410 или 404.
 *
 * Дополнительный запрос делается только на этом пути — на живом адресе лишнего
 * запроса не появляется, а различие 404 и 410 иначе пришлось бы угадывать в
 * каждом маршруте отдельно.
 *
 * @param {object} args
 * @param {import('express').Response} args.res
 * @param {string} args.locale
 * @param {string} args.slug
 * @param {object|null} args.series источник карточки; без него всегда 404
 */
async function sendMissing({ res, locale, slug, series }) {
  const found = series ? await series.bySlug(slug) : null;

  if (found?.archived) {
    return res.status(410).type('html').send(goneView({ locale, slug }).__raw);
  }
  return res.status(404).type('html').send(notFound(locale).__raw);
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

/**
 * Состояние отметок для страницы.
 *
 * Гостю отметок не бывает, и форма у него не рисуется: пустой флажок — это
 * приглашение нажать кнопку, которая ничего не сделает.
 *
 * @param {import('express').Request} req
 * @returns {{csrf: string, signedIn: boolean, undoWindow: number, options: object}}
 */
function marksOf(req) {
  const user = req.session?.user ?? null;
  const timezone = req.headers ? timezoneOf(req) : 'Europe/Minsk';
  const today = todayIn(timezone);

  return {
    csrf: req.session ? csrfToken(req.session) : '',
    signedIn: Boolean(user),
    undoWindow: UNDO_WINDOW_SECONDS,
    options: { userId: user?.id ?? null, today },
  };
}
