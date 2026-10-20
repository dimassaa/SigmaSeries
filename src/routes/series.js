// Страница сериала (F-02-01, S-06) и действия на ней: оценка (F-04-01) и
// отзыв (F-04-04; проверка текста на входе — OP-01).
//
// Маршрут тонкий: разбор адреса, выбор локали, вызов источника, отдача вида.
// Вся правда — в `src/services/…` и `src/view/series.js`.

import crypto from 'node:crypto';

import express from 'express';

import { layout, pageTitle } from '../view/layout.js';
import { notFound } from './home.js';
import { seriesView, goneView } from '../view/series.js';
import { reviewListView, topReviews as topReviewsView, reviewsHref } from '../view/reviewList.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { safeReturnTo } from '../services/auth/login.js';
import { t, isLocale } from '../i18n/strings.js';
import { timezoneOf, todayIn } from '../services/timezone.js';
import { HOUR, DAY, REVIEW } from '../config/settings.js';
import { REPORT_CODES } from '../services/reviews/reports.js';
import { reportStateFor, voteNumber, voteStateFor } from './review-actions.js';
import { cooldownLeft, REASONS } from '../services/reviews/store.js';
import { checkMaterial } from '../services/moderation/check.js';
// Таблицы стилей этой страницы: общая плюс нужные группам. Список
// берётся из `src/config/styles.js`, порядок подключения — оттуда же.
const STYLES = ['series', 'reviews', 'tracking'];


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
  reviewList = null,
  votes = null,
  helpfulLimiter = null,
  reports = null,
  reportLimiter = null,
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

    // «Лучшие отзывы» (F-02-01 §4): три карточки тем же порядком, что у ленты
    // на S-09. Пусто — блок не рисуется вовсе: приглашение написать отзыв уже
    // стоит в блоке «Ваш отзыв».
    const top = reviewList ? await reviewList.top({ seriesId: found.id }) : [];
    const voteState = votes ? await voteStateFor({
      votes, user, session, items: top, locale, slug, back: `/${locale}/series/${slug}`,
    }) : null;
    const reportState = reports ? reportStateFor({
      req, locale, slug, back: `/${locale}/series/${slug}`, user, session,
    }) : null;

    return layout({
      styles: STYLES,
      account: req.account,
      locale,
      path: `/series/${slug}`,
      title: pageTitle(locale, found.title),
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
        reviewTop: top,
        votesById: voteState,
        report: top.length > 0 ? reportState : null,
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
          styles: STYLES,
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
   * Список отзывов сериала (F-04-05, S-09).
   *
   * Адрес — единственный носитель состояния: группа, длина, язык, сортировка
   * и страница читаются из строки запроса, и ответ можно переслать ссылкой
   * (M4 §8г). Недопустимое значение не ошибка: адрес собирают руками, и
   * «`?group=zzz`» показывает базовый список, а не 400 — тем же правилом, что
   * у каталога (F-02-03 §4).
   */
  if (reviewList && reviews && ratings) {
    router.get('/:locale/series/:slug/reviews', async (req, res, next) => {
      const { locale, slug } = req.params;
      if (!isLocale(locale)) return next('route');

      try {
        // Шапка без содержимого: людям, эпизодам и картинкам списка невыгодно
        // тратить запросы (F-04-05 §14).
        const found = await series.lite(slug);
        if (!found) {
          return res.status(404).type('html').send(notFound(locale, req.account).__raw);
        }

        // Снятый с публикации сериал — 410: список без сериала смысла не имеет,
        // а человек должен узнать, что случилось (EC-C1).
        if (found.archived) {
          return res.status(410).type('html').send(rawHtml(layout({
            styles: STYLES,
            account: req.account,
            locale,
            path: `/series/${slug}/reviews`,
            title: t(locale, 'series.gone.title'),
            description: t(locale, 'series.gone.text'),
            noindex: true,
            body: goneView({ locale, slug }),
          })));
        }

        const requested = Number(req.query.page);
        const page = await reviewList.page({
          seriesId: found.id,
          filters: {
            group: String(req.query.group ?? ''),
            length: String(req.query.length ?? ''),
            lang: String(req.query.lang ?? ''),
            sort: String(req.query.sort ?? ''),
          },
          page: Number.isInteger(requested) && requested >= 1 ? requested : 1,
        });

        // Страница за концом списка — не пустой экран, а последняя: адрес
        // остаётся живым, и «?page=999» не плодит одинаковых страниц.
        if (page.page > page.pages) {
          return res.redirect(301, reviewsHref(locale, slug, { ...page.applied, page: page.pages }));
        }

        const session = req.session ?? null;
        const user = session?.user ?? null;
        const summary = await ratings.summary(found.id);
        const ownRating = user ? await ratings.ownRating(user.id, found.id) : null;
        const action = await reviewActionFor({ reviews, user, seriesId: found.id, locale, slug });
        const back = reviewsHref(locale, slug, { ...page.applied, page: page.page });
        const voteState = await voteStateFor({
          votes, user, session, items: page.items, locale, slug,
          back,
        });
        const reportState = reports ? reportStateFor({ req, locale, slug, back, user, session }) : null;

        // Индексируется только первая страница с фильтрами и сортировкой по
        // умолчанию (M4 §8г); EN-страница без русского описания не индексируется
        // и здесь — тем же правилом, что S-06 (R-SEO-04).
        const defaults = !page.applied.group && !page.applied.length && !page.applied.lang
          && page.applied.sort === 'helpful';
        const noindex = !(page.page === 1 && defaults) || (locale === 'en' && !found.descriptionRu);

        return res.status(200).type('html').send(rawHtml(layout({
          styles: STYLES,
          account: req.account,
          locale,
          path: `/series/${slug}/reviews`,
          title: pageTitle(locale, t(locale, 'review.list.title', { title: found.title })),
          description: found.description.slice(0, 160),
          noindex,
          body: reviewListView({
            locale,
            series: found,
            summary,
            ownRating,
            action,
            timezone: timezoneOf(req),
            page,
            votesById: voteState,
            report: reportState,
          }),
        })));
      } catch (error) {
        return next(error);
      }
    });
  }

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

  /**
   * Голос «Полезно» (F-04-06).
   *
   * Цель (`set`/`unset`) объявляет кнопка, а не угадывается на сервере:
   * примитивы идемпотентны (F-04-06 §8), двойная отправка формы безопасна.
   * Адрес возврата собирает вид страницы (вместе с фильтрами списка) и идёт
   * через `safeReturnTo` — внутренний и без схемы, как возврат после
   * входа (R-SEC-08). Скрипту отдаётся JSON: следовать за редиректом ради
   * обновления одной кнопки не требуется.
   */
  if (votes) {
    router.post('/:locale/series/:slug/reviews/:reviewId/helpful', async (req, res, next) => {
      const { locale, slug, reviewId } = req.params;
      if (!isLocale(locale)) return next('route');

      const user = req.session?.user ?? null;
      if (!user) {
        return res.redirect(303, `/${locale}/login?next=${encodeURIComponent(safeReturnTo(req.body?.back))}`);
      }
      if (!csrfValid(req.session, req.body?.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8').send(t(locale, 'review.error.csrf'));
      }
      // Потолок один и по пользователю (M4 §0): голос без владельца — не голос.
      if (helpfulLimiter && !helpfulLimiter.allow(String(user.id))) {
        return res.status(429)
          .set('Retry-After', String(Math.ceil((helpfulLimiter.windowMs ?? HOUR) / 1000)))
          .type('text/plain; charset=utf-8')
          .send(t(locale, 'review.error.rate'));
      }

      const to = String(req.body?.to ?? '');
      if (to !== 'set' && to !== 'unset') {
        return res.status(400).type('text/plain; charset=utf-8').send(t(locale, 'review.vote.error.to'));
      }
      const back = safeReturnTo(req.body?.back);
      const materialId = voteNumber(reviewId);
      if (materialId === null) {
        return res.status(404).type('text/plain; charset=utf-8').send(t(locale, 'review.vote.missing'));
      }

      try {
        // Соседние маршруты сверяются с данными страницы: адрес с чужим
        // именем («сериала нет») обязан называться 404, даже если найдётся
        // отзыв по id.
        const header = await series.lite(slug);
        if (!header) return res.status(404).type('text/plain; charset=utf-8').send(t(locale, 'review.error.missing'));

        const result = to === 'set'
          ? await votes.set({ userId: user.id, materialId, seriesId: header.id })
          : await votes.unset({ userId: user.id, materialId, seriesId: header.id });
        if (!result.ok) {
          const missing = result.reason === 'missing' || result.reason === 'kind';
          return res.status(missing ? 404 : 403)
            .type('text/plain; charset=utf-8')
            .send(t(locale, missing ? 'review.vote.missing' : `review.vote.${result.reason ?? ''}`));
        }

        if (req.accepts(['html', 'json']) === 'json') {
          return res.status(200).json({ voted: result.voted, count: result.count });
        }
        return res.redirect(303, back);
      } catch (error) {
        return next(error);
      }
    });
  }

  /**
   * Жалоба на отзыв (F-04-07).
   *
   * Права проверяет сервис: меню — удобство, а не защита (M4 §15-11).
   * Форма работает и без скрипта: состояния («отправлено», «уже подано»)
   * и ошибки полей приходят адресом возврата, где диалог открывается
   * на месте — человеку не показывается текстовая страница ради ошибки
   * в одном поле. Скрипт берёт JSON: 200 при успехе, 409 «уже подано»,
   * 400 с названной ошибкой поля.
   */
  if (reports) {
    router.post('/:locale/series/:slug/reviews/:reviewId/report', async (req, res, next) => {
      const { locale, slug, reviewId } = req.params;
      if (!isLocale(locale)) return next('route');

      const user = req.session?.user ?? null;
      if (!user) {
        return res.redirect(303, `/${locale}/login?next=${encodeURIComponent(safeReturnTo(req.body?.back))}`);
      }
      if (!csrfValid(req.session, req.body?.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8').send(t(locale, 'review.error.csrf'));
      }
      // Потолок — сутки на аккаунт (M4 §0): жалоба — решение, а не поток.
      // Отсекает запись, но не портит её: спрос спрашивается раньше правды.
      if (reportLimiter && !reportLimiter.allow(String(user.id))) {
        return res.status(429)
          .set('Retry-After', String(Math.ceil((reportLimiter.windowMs ?? DAY) / 1000)))
          .type('text/plain; charset=utf-8')
          .send(t(locale, 'review.error.rate'));
      }

      const reason = String(req.body?.reason ?? '');
      // Хвост длиннее 400 знаков всё равно сверх лимита: срез защищает адрес
      // возврата от гигантских тел, не меняя вердикт проверки.
      const comment = String(req.body?.comment ?? '').slice(0, 400).trim();
      const materialId = voteNumber(reviewId);
      if (materialId === null) {
        return res.status(404).type('text/plain; charset=utf-8').send(t(locale, 'review.report.missing'));
      }
      const back = safeReturnTo(req.body?.back) ?? `/${locale}`;
      const withState = (marker) => `${back}${back.includes('?') ? '&' : '?'}${marker}`;
      const wantsJson = req.accepts(['html', 'json']) === 'json';

      if (!REPORT_CODES.includes(reason)) {
        if (wantsJson) return res.status(400).json({ error: 'reason' });
        return res.redirect(303, withState(`report=${materialId}&err=reason&c=${encodeURIComponent(comment)}`));
      }
      if (comment.length > REVIEW.reportCommentMax) {
        if (wantsJson) return res.status(400).json({ error: 'comment' });
        return res.redirect(303, withState(`report=${materialId}&err=comment&c=${encodeURIComponent(comment)}`));
      }

      try {
        // Соседи проверяют сериал с адреса раньше сервиса: отзыв чужой
        // витрины из адреса обязан называться 404, как и у голоса.
        const header = await series.lite(slug);
        if (!header) return res.status(404).type('text/plain; charset=utf-8').send(t(locale, 'review.error.missing'));

        const result = await reports.submit({
          userId: user.id, materialId, seriesId: header.id, reason, comment,
        });
        if (!result.ok) {
          if (result.reason === 'already') {
            if (wantsJson) return res.status(409).json({ already: true });
            return res.redirect(303, withState(`reported=${materialId}&again=1`));
          }
          const missing = result.reason === 'missing' || result.reason === 'kind';
          return res.status(missing ? 404 : 403)
            .type('text/plain; charset=utf-8')
            .send(t(locale, missing ? 'review.report.missing' : `review.report.${result.reason ?? ''}`));
        }
        if (wantsJson) return res.status(200).json({ reported: true });
        return res.redirect(303, withState(`reported=${materialId}`));
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
 * Кнопка у сводки списка отзывов (F-04-05 §4).
 *
 * Своей формы у списка нет: обе кнопки ведут к форме на странице сериала, к
 * тому же диалогу, что и у блока «Ваш отзыв». Пока идёт повторная проверка
 * правки, кнопки нет — как и на S-06: вести к форме, которая откажет по
 * кулдауну, значило бы показывать работающую кнопку и отказ после неё.
 *
 * @param {object} deps
 * @param {object} deps.reviews сервис отзывов
 * @param {object|null} deps.user
 * @param {number} deps.seriesId
 * @param {string} deps.locale
 * @param {string} deps.slug
 * @returns {Promise<{kind: 'write'|'edit', href: string}|null>}
 */
async function reviewActionFor({
  reviews, user, seriesId, locale, slug,
}) {
  if (!user) return null;
  const own = await reviews.ownReview(user.id, seriesId);
  const mute = await reviews.muteOf(user.id);
  if (mute) return null;
  if (!own) {
    const right = await reviews.rightToWrite(user.id, seriesId);
    if (!right.ok) return null;
  }
  if (own && cooldownLeft(own) > 0) return null;
  return {
    kind: own ? 'edit' : 'write',
    href: `/${locale}/series/${slug}#review-dialog`,
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
