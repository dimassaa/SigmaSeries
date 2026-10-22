// Адреса сезона и серии (F-02-02, S-07 и S-08) и оценка серии (F-04-02).
//
// Маршрут тонкий: разбор адреса, проверка видимости, отдача вида. Правила
// тонких страниц (H-35) и 410 у снятых — здесь, данные — в
// `src/services/catalogue/season.js`, правила оценок — в
// `src/services/rating/store.js`.

import express from 'express';

import { layout, pageTitle } from '../view/layout.js';
import { notFound } from './home.js';
import { seasonView, episodeView } from '../view/season.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { timezoneOf, todayIn } from '../services/timezone.js';
import { rateReason } from '../services/rating/store.js';
import { HOUR } from '../config/settings.js';
import { UNDO_WINDOW_SECONDS } from '../services/tracking/marks.js';
import { goneView } from '../view/series.js';
import { t, isLocale } from '../i18n/strings.js';
// Таблицы стилей этой страницы: общая плюс нужные группам. Список
// берётся из `src/config/styles.js`, порядок подключения — оттуда же.
const STYLES = ['series', 'tracking'];


const rawHtml = (page) => page.__raw;

/** Номер сезона и серии — целое и в границах (F-02-02 §валидация). */
const number = (value, min) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min ? parsed : null;
};

export function createSeasonRoutes({
  seasons, sessionMw = null, series = null, ratings = null, ratingLimiter = null,
  analytics = null,
}) {
  const router = express.Router({ strict: true });
  // Сессия нужна ради отметок: гость видит такую же строку серии, но без
  // флажка, а вошедший — с отметкой.
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  router.get('/:locale/series/:slug/seasons/:season', async (req, res, next) => {
    const { locale, slug } = req.params;
    if (!isLocale(locale)) return next('route');

    const seasonNumber = number(req.params.season, 0);
    if (seasonNumber === null) return res.status(404).type('html').send(notFound(locale, req.account).__raw);

    try {
      const marks = marksOf(req);
      const found = await seasons.season(slug, seasonNumber, marks.options);
      // Отсутствие сезона у видимого сериала и отсутствие сериала — одно и то же
      // для посетителя: такого адреса нет. Различие живёт в источнике.
      //
      // Снятый с публикации — исключение: сериал был, и человек должен об этом
      // узнать, поэтому 410, а не 404 (EC-C1, как на странице сериала).
      if (!found) return sendMissing({ res, locale, slug, series, account: req.account });

      const path = `/series/${slug}/seasons/${seasonNumber}`;
      return res.status(200).type('html').send(rawHtml(layout({
        styles: STYLES,
        account: req.account,
        locale,
        path,
        title: pageTitle(locale, t(locale, 'season.title', {
          series: found.series.title,
          season: seasonNumber,
        })),
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
          // Оценки серий (F-04-02): готовые блоки по строкам, собранные тремя
          // выборками на весь сезон, — см. `ratingsOfSeason`.
          ratings: ratings
            ? await ratingsOfSeason({
              ratings,
              user: marks.user,
              csrf: marks.csrf,
              episodes: found.season.episodes,
              today: marks.options.today,
            })
            : null,
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
      return res.status(404).type('html').send(notFound(locale, req.account).__raw);
    }

    try {
      const marks = marksOf(req);
      const found = await seasons.episode(slug, seasonNumber, episodeNumber, marks.options);
      if (!found) return sendMissing({ res, locale, slug, series, account: req.account });

      const path = `/series/${slug}/seasons/${seasonNumber}/episodes/${episodeNumber}`;
      return res.status(200).type('html').send(rawHtml(layout({
        styles: STYLES,
        account: req.account,
        locale,
        path,
        title: pageTitle(locale, found.episode.title
          ? t(locale, 'episode.title', { title: found.episode.title, series: found.series.title })
          : t(locale, 'episode.titleNumber', { number: episodeNumber, series: found.series.title })),
        description: found.episode.description.slice(0, 160),
        // H-35: страница серии индексируется только с описанием и датой не
        // позже сегодняшней. Тонкие страницы — это тысячи почти пустых адресов.
        noindex: found.episode.thin || (locale === 'en' && !found.episode.descriptionRu),
        jsonLd: episodeJsonLd({ locale, page: found, seasonNumber, episodeNumber }),
        body: episodeView({
          locale,
          page: found,
          slug,
          marks,
          // Право спрашивается у того же сервиса, что принимает оценку: иначе
          // интерфейс и правило разойдутся.
          rating: ratings
            ? await ratingOfEpisode({
              ratings,
              user: marks.user,
              csrf: marks.csrf,
              episodeId: found.episode.id,
              today: marks.options.today,
            })
            : null,
          timezone: timezoneOf(req),
        }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  /**
   * Оценка серии (F-04-02).
   *
   * Форма стоит и в строке списка серий, и на странице серии, а правило у неё
   * одно. Куда вернуть человека, решает скрытое поле `from`: это не адрес из
   * запроса, а выбор одной из двух известных страниц этого же сериала, поэтому
   * чужой адрес сюда попасть не может (R-SEC-08).
   */
  if (ratings) {
    router.post('/:locale/series/:slug/seasons/:season/episodes/:episode/rating',
      async (req, res, next) => {
        const { locale, slug } = req.params;
        if (!isLocale(locale)) return next('route');

        const seasonNumber = number(req.params.season, 0);
        const episodeNumber = number(req.params.episode, 1);
        if (seasonNumber === null || episodeNumber === null) return next('route');

        const episodePath =
          `/${locale}/series/${slug}/seasons/${seasonNumber}/episodes/${episodeNumber}`;
        const seasonPath = `/${locale}/series/${slug}/seasons/${seasonNumber}`;
        const back = req.body?.from === 'season' ? seasonPath : episodePath;

        const user = req.session?.user ?? null;
        if (!user) {
          // R-SEC-08: возврат только на эту же страницу и только внутренний.
          return res.redirect(303, `/${locale}/login?next=${encodeURIComponent(back)}`);
        }
        if (!csrfValid(req.session, req.body?.csrf)) {
          return res.status(403).type('text/plain; charset=utf-8')
            .send(t(locale, 'rating.error.csrf'));
        }
        if (ratingLimiter && !ratingLimiter.allow(String(user.id))) {
          return res.status(429)
            .set('Retry-After', String(Math.ceil((ratingLimiter.windowMs ?? HOUR) / 1000)))
            .type('text/plain; charset=utf-8')
            .send(t(locale, 'rating.error.rate'));
        }

        try {
          const today = todayIn(timezoneOf(req));
          const ref = await seasons.episodeRef(slug, seasonNumber, episodeNumber, { today });
          if (!ref) {
            return res.status(404).type('text/plain; charset=utf-8')
              .send(t(locale, 'rating.error.missing'));
          }

          const raw = String(req.body?.value ?? '').trim();
          // Пустое значение — это «убрать оценку», а не «ноль»: ноль вне
          // диапазона и должен быть отвергнут, а человек хочет снять своё.
          const result = raw === '' || raw === '0'
            ? await ratings.removeEpisodeRating({ userId: user.id, episodeId: ref.episodeId })
            : await ratings.setEpisodeRating({
              userId: user.id,
              seriesId: ref.seriesId,
              episodeId: ref.episodeId,
              value: Number(raw),
              today,
            });

          // Якорь возвращает к строке списка: после оценки сезона из двадцати
          // четырёх серий страница длинная, и оказаться в её начале — значит
          // потерять место, на котором стоял. Причина отказа в адрес не
          // кладётся: она и так видна на странице словами (`rateReason` — та же
          // функция, что проверяла запись), а параметр, которого никто не
          // читает, выглядел бы работающим поведением, которого нет.
          return res.redirect(303, `${back}#ep-${episodeNumber}`);
        } catch (error) {
          return next(error);
        }
      });
  }

  return router;
}

/**
 * Оценки серий для списка сезона (F-04-02).
 *
 * Три выборки на весь список: средние, свои оценки, подтверждение адреса.
 * Запрос на строку дал бы двадцать запросов там, где нужен один (M4 §0,
 * измерение 14).
 *
 * @param {object} args
 * @param {object} args.ratings сервис оценок
 * @param {object|null} args.user вошедший или `null`
 * @param {string} args.csrf
 * @param {object[]} args.episodes строки сезона с отметкой и датой
 * @param {string|null} args.today сегодня в поясе посетителя
 * @returns {Promise<Map<number, object>>} блок оценки по идентификатору серии
 */
async function ratingsOfSeason({ ratings, user, csrf, episodes, today }) {
  const ids = episodes.map((episode) => episode.id);
  const summaries = await ratings.episodeSummaries(ids);
  const own = user ? await ratings.ownEpisodeRatings(user.id, ids) : new Map();
  const confirmed = user ? await ratings.emailConfirmed(user.id) : false;

  const rows = new Map();
  for (const episode of episodes) {
    // Отметка и дата — свои у каждой строки, подтверждение адреса — одно на
    // человека. Правило собирается той же функцией, что проверяет запись,
    // поэтому «кнопка есть, а запрос отклонён» разойтись не могут (EC-V1).
    const reason = user
      ? rateReason({
        confirmed,
        marked: episode.precision === 'exact',
        aired: episode.aired,
      })
      : null;
    rows.set(episode.id, {
      summary: summaries.get(episode.id),
      own: own.get(episode.id) ?? null,
      canRate: reason === null,
      reason,
      signedIn: Boolean(user),
      csrf,
    });
  }
  return rows;
}

/**
 * Блок оценки одной серии для страницы серии.
 *
 * Гостю тот же блок, но без шкалы и с приглашением войти: пустое место на
 * странице выглядит как ошибка вёрстки, а приглашение объясняет, что делать.
 *
 * @param {object} args
 * @param {object} args.ratings сервис оценок
 * @param {object|null} args.user
 * @param {string} args.csrf
 * @param {number} args.episodeId
 * @param {string|null} args.today
 */
async function ratingOfEpisode({ ratings, user, csrf, episodeId, today }) {
  const summary = await ratings.episodeSummary(episodeId);
  if (!user) {
    return { summary, own: null, canRate: false, reason: null, signedIn: false, csrf };
  }

  const allowed = await ratings.canRateEpisode({ userId: user.id, episodeId, today });
  return {
    summary,
    own: await ratings.ownEpisodeRating(user.id, episodeId),
    canRate: allowed.ok,
    reason: allowed.reason ?? null,
    signedIn: true,
    csrf,
  };
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
 * @param {object|null} [args.account] меню аккаунта из верхней панели
 */
async function sendMissing({ res, locale, slug, series, account = null }) {
  const found = series ? await series.bySlug(slug) : null;

  if (found?.archived) {
    return res.status(410).type('html').send(goneView({ locale, slug }).__raw);
  }
  return res.status(404).type('html').send(notFound(locale, account).__raw);
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
 * @returns {{csrf: string, signedIn: boolean, user: object|null,
 *   undoWindow: number, options: object}}
 */
function marksOf(req) {
  const user = req.session?.user ?? null;
  const timezone = req.headers ? timezoneOf(req) : 'Europe/Minsk';
  const today = todayIn(timezone);

  return {
    csrf: req.session ? csrfToken(req.session) : '',
    signedIn: Boolean(user),
    user,
    undoWindow: UNDO_WINDOW_SECONDS,
    options: { userId: user?.id ?? null, today },
  };
}
