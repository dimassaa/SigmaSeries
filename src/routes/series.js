// Страница сериала (F-02-01, S-06) и действия на ней: оценка (F-04-01) и
// отзыв (F-04-04; проверка текста на входе — OP-01).
//
// Маршрут тонкий: разбор адреса, выбор локали, вызов источника, отдача вида.
// Вся правда — в `src/services/…` и `src/view/series.js`.

import crypto from 'node:crypto';

import express from 'express';

import { layout } from '../view/layout.js';
import { notFound } from './home.js';
import { seriesView, goneView } from '../view/series.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { t, isLocale } from '../i18n/strings.js';
import { timezoneOf, todayIn } from '../services/timezone.js';
import { HOUR, REVIEW } from '../config/settings.js';
import { cooldownLeft, REASONS } from '../services/reviews/store.js';
import { checkMaterial } from '../services/moderation/check.js';

/** Ответ отправляется разобранной строкой: `send()` объекта ушёл бы в JSON. */
const rawHtml = (page) => page.__raw;

/** Сеть посетителя: тот же ключ, что у прочих лимитов (`R-SEC-31`). */
function clientIp(req) {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Ключ устройства для потолка публикаций (R-MOD-10).
 *
 * «Устройство» здесь — пара «сеть + браузер»: лимит по сети обходится сменой
 * сети, лимит по аккаунту — новым аккаунтом с той же машины. Отпечаток
 * нигде не хранится: счётчик живёт в памяти процесса, поэтому хеш нужен
 * лишь затем, чтобы ключ не разрастался до размеров заголовка браузера.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function deviceKey(req) {
  return crypto.createHash('sha256')
    .update(`${clientIp(req)}|${req.get('user-agent') ?? ''}`)
    .digest('hex')
    .slice(0, 24);
}

export function createSeriesRoutes({
  series,
  watchStatus = null,
  sessionMw = null,
  progress = null,
  subscriptions = null,
  ratings = null,
  ratingLimiter = null,
  reviews = null,
  dictionary = null,
  reviewIpLimiter = null,
  reviewDeviceLimiter = null,
}) {
  const router = express.Router({ strict: true });
  // Сессия нужна ради одного — статуса зрителя на этой карточке.
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  /**
   * Страница целиком — общая точка у показа и у повторной отдачи после
   * отказа формы (422).
   *
   * Человек, вернувшийся с ошибкой, должен получить ту же страницу, что была
   * до отправки, плюс открытую форму с его значениями. Собрать её вторым
   * способом значило бы завести два расходящихся вида одной страницы.
   *
   * @param {object} args
   * @param {import('express').Request} args.req
   * @param {string} args.locale
   * @param {string} args.slug
   * @param {object} args.found сериал из источника
   * @param {object|null} [args.reviewState] `{ values, error, editing }` —
   *   что показать в форме отзыва после отказа
   */
  const composePage = async ({ req, locale, slug, found, reviewState = null }) => {
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

    // Оценка (F-04-01) спрашивается у того же сервиса, что и принимает
    // оценку, — иначе интерфейс и правило разойдутся. Своя оценка берётся
    // один раз: она нужна и блоку оценки, и форме отзыва.
    const ownRating = ratings && user ? await ratings.ownRating(user.id, found.id) : null;
    // Отзыв (F-04-04). Право «писать» спрашивается у сервиса отзывов — тому
    // же, кто отказывает при отправке (EC-V1).
    const review = reviews
      ? await reviewDataFor({
        reviews,
        dictionary,
        user,
        seriesId: found.id,
        session,
        rating: ownRating?.value ?? null,
        state: reviewState,
      })
      : null;
    const rating = ratings
      ? await ratingBlock({
        ratings,
        user,
        seriesId: found.id,
        session,
        own: ownRating,
        hasReview: Boolean(review?.own),
      })
      : null;

    return layout({
      account: req.account,
      locale,
      path: `/series/${slug}`,
      title: found.title,
      description: found.description.slice(0, 160),
      noindex: locale === 'en' && !found.descriptionRu,
      jsonLd: seriesJsonLd({ locale, series: found, rating }),
      body: seriesView({
        locale,
        series: found,
        status: watch ? { value: watch.status, csrf: watch.csrf, signedIn: watch.signedIn, archived: watch.archived } : null,
        progress: watchProgress,
        subscribe: bell,
        ratingBlock: rating,
        reviewBlock: review,
        notice: String(req.query.subs ?? '') || null,
        timezone: timezoneOf(req),
      }),
    });
  };

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

      return res.status(200).type('html').send(rawHtml(await composePage({ req, locale, slug, found })));
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
        if (raw === '' || raw === '0') {
          await ratings.removeSeriesRating({ userId: user.id, seriesId: found.id });
          // H-75: отзыв — продолжение оценки, и «убрать оценку» при живом
          // отзыве удаляет и его. Подтверждение спрашивает интерфейс: без
          // скрипта данные остаются в целости (см. `rating.clear.confirm`).
          if (reviews) await reviews.deleteOwn({ userId: user.id, seriesId: found.id });
        } else {
          await ratings.setSeriesRating({ userId: user.id, seriesId: found.id, value: Number(raw) });
        }

        // Один и тот же возврат и на успех, и на отказ: причина отказа приходит
        // из данных страницы (та же `rateReason`, что проверяла запись), а
        // `?rating=…` и `?young=1` в адресе не читал никто — параметры выглядели
        // работающим поведением, которого нет (#149). Молодой голос виден на
        // странице полями `own.counted` и `own.maturesAt` (EC-V4).
        return res.redirect(303, `${back}#h-rating`);
      } catch (error) {
        return next(error);
      }
    });
  }

  /**
   * Отправка отзыва (F-04-04). Группа отзыва (OP-04) при публикации не
   * считается: классификация — сторона показа (F-04-05), и её здесь нет.
   *
   * Порядок отказов — от «кто ты» к «что ты сказал»: вход, CSRF, потолки
   * (R-MOD-10), мьют, оценка, длина, проверка текста. Оценка сохраняется при
   * отправке независимо от результата проверки текста (F-04-04 §8б, EC-V8),
   * но не во время мьюта: мьют — отказ от приёма материала целиком, и часть
   * его сохранять нельзя.
   */
  if (reviews && dictionary) {
    router.post('/:locale/series/:slug/reviews', async (req, res, next) => {
      const { locale, slug } = req.params;
      if (!isLocale(locale)) return next('route');

      const back = `/${locale}/series/${slug}`;
      const user = req.session?.user ?? null;
      if (!user) {
        // R-SEC-08: возврат только на эту же страницу и только внутренний.
        return res.redirect(303, `/${locale}/login?next=${encodeURIComponent(back)}`);
      }
      if (!csrfValid(req.session, req.body?.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8').send(t(locale, 'review.error.csrf'));
      }
      // Потолки сети и устройства (R-MOD-10) — до обращения к базе: их
      // задача не пропустить поток, а не разобрать его. Счёт отдельный от
      // часового лимита сервиса: тот отвечает за одного автора, эти — за
      // одну сеть.
      for (const [limiter, key] of [
        [reviewIpLimiter, `ip:${clientIp(req)}`],
        [reviewDeviceLimiter, `dev:${deviceKey(req)}`],
      ]) {
        if (limiter && !limiter.allow(key)) {
          return res.status(429)
            .set('Retry-After', String(Math.ceil((limiter.windowMs ?? HOUR) / 1000)))
            .type('text/plain; charset=utf-8')
            .send(t(locale, 'review.error.rate'));
        }
      }

      try {
        const found = await series.bySlug(slug);
        if (!found) return res.status(404).type('text/plain; charset=utf-8').send(t(locale, 'review.error.missing'));

        /** Отказ формы: та же страница, форма открыта, значения сохранены. */
        const reject = async (state) => {
          const page = await composePage({ req, locale, slug, found, reviewState: state });
          return res.status(422).type('html').send(rawHtml(page));
        };

        const parsed = Number(String(req.body?.value ?? '').trim());
        const rating = Number.isInteger(parsed) && parsed >= 1 && parsed <= 10 ? parsed : null;
        const text = String(req.body?.body ?? '').trim();
        const values = {
          body: text,
          value: rating,
          spoiler: req.body?.spoiler === 'on',
          lang: req.body?.lang === 'en' ? 'en' : 'ru',
        };

        // Пустой текст — это оценка без отзыва (F-04-04 §5, EC-V7), и её
        // мьют не запрещает: оценка — не материал (F-05-08 §4).
        if (text === '') {
          if (rating === null) {
            return reject({ values, error: { key: 'review.error.rating' }, editing: true });
          }
          // Право проверит сам сервис оценок: у него то же условие, что у
          // блока оценки, и второй копии правила не нужно.
          if (ratings) await ratings.setSeriesRating({ userId: user.id, seriesId: found.id, value: rating });
          return res.redirect(303, `${back}#h-reviews`);
        }

        // Текст есть — значит, это отправка материала: мьют отклоняет её
        // целиком, с причиной и сроком на странице (F-04-04 §5, F-05-08 §4).
        const mute = await reviews.muteOf(user.id, new Date());
        if (mute) return res.redirect(303, `${back}#h-reviews`);

        // Оценка — часть отзыва: без неё текст не публикуется (F-04-04 §5
        // «нет оценки — сначала выбрать»).
        if (rating === null) {
          return reject({ values, error: { key: 'review.error.rating' }, editing: true });
        }

        const result = await reviews.submit({
          userId: user.id,
          seriesId: found.id,
          body: text,
          spoiler: values.spoiler,
          lang: values.lang,
          dictionary: await dictionary.load(),
        });

        if (result.reason === REASONS.MUTED) return res.redirect(303, `${back}#h-reviews`);
        if (result.reason === REASONS.LIMIT) {
          return res.status(429)
            .set('Retry-After', String(result.retryAfterSec))
            .type('text/plain; charset=utf-8')
            .send(t(locale, 'review.error.rate'));
        }

        // Оценка сохраняется до разбора отказа по тексту: человек уже выразил
        // мнение числом, и оно не должно пропасть из-за длины текста (EC-V7).
        if (ratings) await ratings.setSeriesRating({ userId: user.id, seriesId: found.id, value: rating });

        if (result.ok) return res.redirect(303, `${back}#h-reviews`);

        switch (result.reason) {
          case REASONS.SHORT:
            return reject({ values, error: { key: 'review.error.short', params: { min: REVIEW.lenMin } }, editing: true });
          case REASONS.LONG:
            return reject({ values, error: { key: 'review.error.long', params: { max: REVIEW.lenMax } }, editing: true });
          case REASONS.EMPTY:
            return reject({ values, error: { key: 'review.error.empty' }, editing: true });
          case REASONS.COOLDOWN:
            return reject({
              values,
              error: { key: 'review.error.cooldown', params: { minutes: Math.ceil(result.retryAfterSec / 60) } },
              editing: true,
            });
          case REASONS.NO_MARK:
            return reject({ values, error: { key: 'review.error.no-mark' }, editing: true });
          case REASONS.NOT_CONFIRMED:
            return reject({ values, error: { key: 'review.error.not-confirmed' }, editing: true });
          default:
            // Неизвестный отказ — это не «форма сломалась», а код, который
            // разошёлся с сервисом: падать громко, а не показывать пустоту.
            return next(new Error(`Неизвестный отказ отзыва: ${result.reason}`));
        }
      } catch (error) {
        return next(error);
      }
    });

    /**
     * Удаление отзыва (F-04-04 §8ж). Оценка остаётся: это разные записи, и
     * человек, убравший текст, не теряет свою оценку.
     */
    router.post('/:locale/series/:slug/reviews/delete', async (req, res, next) => {
      const { locale, slug } = req.params;
      if (!isLocale(locale)) return next('route');

      const back = `/${locale}/series/${slug}`;
      const user = req.session?.user ?? null;
      if (!user) {
        return res.redirect(303, `/${locale}/login?next=${encodeURIComponent(back)}`);
      }
      if (!csrfValid(req.session, req.body?.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8').send(t(locale, 'review.error.csrf'));
      }

      try {
        const found = await series.bySlug(slug);
        if (!found) return res.status(404).type('text/plain; charset=utf-8').send(t(locale, 'review.error.missing'));

        // Мьют удалению не помеха: удалять своё можно всегда (F-05-08 §4).
        await reviews.deleteOwn({ userId: user.id, seriesId: found.id });
        return res.redirect(303, `${back}#h-reviews`);
      } catch (error) {
        return next(error);
      }
    });
  }

  return router;
}

/**
 * Данные блока «Ваш отзыв» для страницы сериала (F-04-04).
 *
 * Гостю блок тоже нужен: приглашение войти объясняет, что здесь можно
 * написать, — пустое место читается как поломка (F-04-01 §2). Причину отказа
 * называет тот же сервис, что и отказывает: иначе интерфейс и правило
 * разойдутся (EC-V1).
 *
 * @param {object} deps
 * @param {object} deps.reviews сервис отзывов
 * @param {object|null} deps.dictionary словарь проверки (для подсветки)
 * @param {object|null} deps.user
 * @param {number} deps.seriesId
 * @param {object|null} deps.session
 * @param {number|null} [deps.rating] своя оценка — подставляется в форму
 * @param {object|null} [deps.state] `{ values, error, editing }` после отказа
 */
async function reviewDataFor({
  reviews, dictionary, user, seriesId, session, rating = null, state = null,
}) {
  if (!user) {
    return {
      own: null,
      gate: {
        signedIn: false, canWrite: false, reason: null, mute: null, csrf: '', cooldownSec: 0,
      },
      review: null,
      rating: null,
      values: null,
      error: null,
      editing: false,
    };
  }

  const own = await reviews.ownReview(user.id, seriesId);
  const mute = await reviews.muteOf(user.id);
  let reason = null;
  // Право спрашивается только у того, кому оно нужно: автор с отзывом уже
  // доказал его, а отметку он мог и снять — правка своего разрешена
  // (F-04-04 §5 «один отзыв на пользователя и сериал»).
  if (!own && !mute) {
    const right = await reviews.rightToWrite(user.id, seriesId);
    if (!right.ok) reason = right.reason ?? 'no-mark';
  }

  // Помеченный отзыв показывается фрагментом с подсветкой (R-MOD-12): слова
  // из словаря автору не раскрываются — вид получает только позиции.
  let review = null;
  if (own && own.state === 'flagged' && dictionary) {
    const dict = await dictionary.load();
    review = { matched: checkMaterial({ body: own.body, dictionary: dict }).matched };
  }

  return {
    own,
    gate: {
      signedIn: true,
      canWrite: !mute && (Boolean(own) || reason === null),
      reason,
      mute,
      csrf: session ? csrfToken(session) : '',
      cooldownSec: cooldownLeft(own),
    },
    review,
    rating,
    values: state?.values ?? null,
    error: state?.error ?? null,
    editing: state?.editing ?? false,
  };
}

/**
 * Данные блока оценки для страницы сериала.
 *
 * @param {object} deps
 * @param {object} deps.ratings сервис оценок
 * @param {object|null} deps.user
 * @param {number} deps.seriesId
 * @param {object|null} deps.session
 * @param {object|null} [deps.own] своя оценка, уже прочитанная вызывающим
 * @param {boolean} [deps.hasReview] есть ли отзыв: от него зависит
 *   подтверждение снятия оценки (H-75)
 */
async function ratingBlock({
  ratings, user, seriesId, session, own = null, hasReview = false,
}) {
  const summary = await ratings.summary(seriesId);
  if (!user) {
    // Гость видит то же место с приглашением войти: пустое место на странице
    // сериала выглядит как ошибка вёрстки (F-04-01 §2).
    return { summary, own: null, canRate: false, signedIn: false, csrf: session ? csrfToken(session) : '', slug: null };
  }

  const allowed = await ratings.canRate({ userId: user.id, seriesId });
  return {
    summary,
    own,
    canRate: allowed.ok,
    reason: allowed.reason ?? null,
    signedIn: true,
    hasReview,
    csrf: csrfToken(session),
  };
}

/**
 * Разметка schema.org для карточки (F-02-01 §18, F-04-03 §17).
 *
 * Без неё поисковики показывают сериал без описания и дат, а проверка
 * приёмки требует `TVSeries` в HTML. `aggregateRating` появляется только
 * вместе с видимым числом: разметка, заявляющая оценку, которой человек на
 * странице не видит, — это обещание, которого мы не выполняем (R-SEO-18).
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.series данные сериала
 * @param {object|null} [args.rating] блок оценки: берётся `summary`
 */
function seriesJsonLd({ locale, series: found, rating = null }) {
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

  const summary = rating?.summary;
  if (summary?.shown) {
    data.aggregateRating = {
      '@type': 'AggregateRating',
      // Точка, а не запятая: JSON — не текст страницы, и русская запятая в нём
      // сделала бы значение строкой, которую поисковик не прочитает.
      ratingValue: Number(summary.average.toFixed(1)),
      ratingCount: summary.votes,
      bestRating: 10,
      worstRating: 1,
    };
  }

  return data;
}
