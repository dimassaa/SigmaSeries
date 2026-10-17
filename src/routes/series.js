// Страница сериала (F-02-01, S-06).
//
// Маршрут тонкий: разбор адреса, выбор локали, вызов источника, отдача вида.
// Вся правда — в `src/services/catalogue/series.js` и `src/view/series.js`.

import express from 'express';

import { layout } from '../view/layout.js';
import { notFound } from './home.js';
import { seriesView, goneView } from '../view/series.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { t, isLocale } from '../i18n/strings.js';
import { timezoneOf, todayIn } from '../services/timezone.js';
import { HOUR } from '../config/settings.js';

/** Ответ отправляется разобранной строкой: `send()` объекта ушёл бы в JSON. */
const rawHtml = (page) => page.__raw;

export function createSeriesRoutes({
  series,
  watchStatus = null,
  sessionMw = null,
  progress = null,
  subscriptions = null,
  ratings = null,
  ratingLimiter = null,
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
        return res.status(404).type('html').send(notFound(locale, req.account).__raw);
      }

      // Снятый с публикации сериал — 410, а не 404: он был, и человек должен
      // об этом узнать (EC-C1).
      if (found.archived) {
        return res.status(410).type('html').send(rawHtml(layout({
          account: req.account,
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

      // Оценка (F-04-01). Право «оценить» спрашивается у того же сервиса,
      // что и принимает оценку, — иначе интерфейс и правило разойдутся.
      const rating = ratings
        ? await ratingBlock({ ratings, user, seriesId: found.id, session })
        : null;

      return res.status(200).type('html').send(rawHtml(layout({
        account: req.account,
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
          ratingBlock: rating,
          notice: String(req.query.subs ?? '') || null,
        }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  /**
   * Оценка сериала (F-04-01, OP-03).
   *
   * Отдельный POST рядом со страницей, а не действие в общем списке: у
   * отметок свой адрес и свой сценарий отказа (EC-T2), у оценки — свой.
   */
  if (ratings) {
    router.post('/:locale/series/:slug/rating', async (req, res, next) => {
      const { locale, slug } = req.params;
      if (!isLocale(locale)) return next('route');

      const back = `/${locale}/series/${slug}`;
      const user = req.session?.user ?? null;
      if (!user) {
        // R-SEC-08: возврат только на эту же страницу и только внутренний.
        return res.redirect(303, `/${locale}/login?next=${encodeURIComponent(back)}`);
      }
      if (!csrfValid(req.session, req.body?.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8').send(t(locale, 'rating.error.csrf'));
      }
      if (ratingLimiter && !ratingLimiter.allow(String(user.id))) {
        return res.status(429)
          .set('Retry-After', String(Math.ceil((ratingLimiter.windowMs ?? HOUR) / 1000)))
          .type('text/plain; charset=utf-8')
          .send(t(locale, 'rating.error.rate'));
      }

      try {
        const found = await series.bySlug(slug);
        if (!found) return res.status(404).type('text/plain; charset=utf-8').send(t(locale, 'rating.error.missing'));

        const raw = String(req.body?.value ?? '').trim();
        // Пустое значение — это «убрать оценку», а не «ноль»: ноль вне
        // диапазона и должен быть отвергнут, а человек хочет снять своё.
        const result = raw === '' || raw === '0'
          ? await ratings.removeSeriesRating({ userId: user.id, seriesId: found.id })
          : await ratings.setSeriesRating({
            userId: user.id, seriesId: found.id, value: Number(raw),
          });

        if (!result.ok) return res.redirect(303, `${back}?rating=${result.reason}`);
        return res.redirect(303, `${back}?rating=ok${result.counted === false ? '&young=1' : ''}`);
      } catch (error) {
        return next(error);
      }
    });
  }

  return router;
}

/**
 * Данные блока оценки для страницы сериала.
 *
 * @param {object} deps
 * @param {object} deps.ratings сервис оценок
 * @param {object|null} deps.user
 * @param {number} deps.seriesId
 * @param {object|null} deps.session
 */
async function ratingBlock({ ratings, user, seriesId, session }) {
  const summary = await ratings.summary(seriesId);
  if (!user) {
    // Гость видит то же место с приглашением войти: пустое место на странице
    // сериала выглядит как ошибка вёрстки (F-04-01 §2).
    return { summary, own: null, canRate: false, signedIn: false, csrf: session ? csrfToken(session) : '', slug: null };
  }

  const allowed = await ratings.canRate({ userId: user.id, seriesId });
  return {
    summary,
    own: await ratings.ownRating(user.id, seriesId),
    canRate: allowed.ok,
    reason: allowed.reason ?? null,
    signedIn: true,
    csrf: csrfToken(session),
  };
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