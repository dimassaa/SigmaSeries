// Страница сериала (F-02-01, S-06).
//
// Маршрут тонкий: разбор адреса, выбор локали, вызов источника, отдача вида.
// Вся правда — в `src/services/catalogue/series.js` и `src/view/series.js`.

import express from 'express';

import { layout } from '../view/layout.js';
import { notFound } from './home.js';
import { seriesView, goneView } from '../view/series.js';
import { csrfToken } from '../services/auth/session.js';
import { t, isLocale } from '../i18n/strings.js';
import { timezoneOf, todayIn } from '../services/timezone.js';

/** Ответ отправляется разобранной строкой: `send()` объекта ушёл бы в JSON. */
const rawHtml = (page) => page.__raw;

export function createSeriesRoutes({
  series,
  watchStatus = null,
  sessionMw = null,
  progress = null,
  subscriptions = null,
}) {
  const router = express.Router({ strict: true });
  // Сессия нужна ради одного — статуса зрителя на этой карточке.
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);
  router.get('/:locale/series/:slug', async (req, res, next) => {
    const { locale, slug } = req.params;
    if (!isLocale(locale)) return next('route');

    try {
      const found = await series.bySlug(slug);
      // Неопубликованный сериал для посетителя не существует: иначе его адрес
      // утекал бы наружу до того, как редактор закончит с ним (EC-K2).
      // `next('notfound')` в Express 5 — не сигнал, а ошибка, поэтому 404
      // отдаётся здесь же, тем же видом, что и на главной.
      if (!found) {
        return res.status(404).type('html').send(notFound(locale).__raw);
      }

      // Снятый с публикации сериал — 410, а не 404: он был, и человек должен
      // об этом узнать (EC-C1).
      if (found.archived) {
        return res.status(410).type('html').send(rawHtml(layout({
          locale,
          path: `/series/${slug}`,
          title: t(locale, 'series.gone.title'),
          description: t(locale, 'series.gone.text'),
          noindex: true,
          body: goneView({ locale, slug }),
        })));
      }

      // Английская страница без перевода описания остаётся открытой, но не
      // индексируется: иначе в выдаче окажется пустая страница (R-SEO-04).
      const noindex = locale === 'en' && !found.descriptionRu;

      const session = req.session ?? null;
      const user = session?.user ?? null;
      // Прогресс считается только вошедшему: гостю нечего «продолжать», а
      // пустая полоса на странице сериала выглядит как ошибка вёрстки.
      const watchProgress = progress && user
        ? await progress.of({ userId: user.id, seriesId: found.id, today: todayIn(timezoneOf(req)) })
        : null;
      // Гость тоже получает место под кнопку — с приглашением войти: пустое
      // место на странице сериала выглядит как ошибка вёрстки, а приглашение
      // объясняет, что делать (F-03-01 §2).
      const watch = watchStatus
        ? {
          status: user ? (await watchStatus.of(user.id, found.id))?.status ?? null : null,
          csrf: session ? csrfToken(session) : '',
          signedIn: Boolean(user),
          archived: found.archived,
        }
        : null;

      // Колокольчик есть и у гостя: вместо него — приглашение войти (F-03-07 §4).
      const bell = subscriptions
        ? {
          state: user ? await subscriptions.state(user.id, found.id) : null,
          csrf: session ? csrfToken(session) : '',
          signedIn: Boolean(user),
        }
        : null;

      return res.status(200).type('html').send(rawHtml(layout({
        locale,
        path: `/series/${slug}`,
        title: found.title,
        description: found.description.slice(0, 160),
        noindex,
        jsonLd: seriesJsonLd({ locale, series: found }),
        body: seriesView({
          locale,
          series: found,
          status: watch ? { value: watch.status, csrf: watch.csrf, signedIn: watch.signedIn, archived: watch.archived } : null,
          progress: watchProgress,
          subscribe: bell,
          notice: String(req.query.subs ?? '') || null,
        }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/**
 * Разметка schema.org для карточки (F-02-01 §18).
 *
 * Без неё поисковики показывают сериал без описания и дат, а проверка
 * приёмки требует `TVSeries` в HTML.
 */
function seriesJsonLd({ locale, series: found }) {
  const episodes = found.seasons.flatMap((season) => season.episodes);
  const data = {
    '@context': 'https://schema.org',
    '@type': 'TVSeries',
    name: found.title,
    url: `/${locale}/series/${found.slug}`,
  };

  if (found.description) data.description = found.description;
  if (found.yearStart) data.startDate = String(found.yearStart);
  if (found.genres.length) data.genre = found.genres.map((genre) => genre.name_ru);
  if (episodes.length) data.numberOfEpisodes = episodes.length;
  if (found.seasons.length) data.numberOfSeasons = found.seasons.length;

  return data;
}