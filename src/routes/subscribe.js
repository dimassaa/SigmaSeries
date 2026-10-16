// Подписка на выходы: приём запроса (F-03-07).
//
// Маршрут тонкий, как и остальные принимающие: сессия, CSRF, сериал по адресу,
// действие, возврат туда, откуда нажали. Лимита частоты у колокольчика нет —
// в M3 §0 нет ключа для него, и выдумывать число значило бы записать в
// документацию то, чего автор не решал (находка #131).

import express from 'express';

import { csrfValid } from '../services/auth/session.js';
import { KINDS } from '../services/tracking/subscription.js';
import { isLocale, t } from '../i18n/strings.js';

/**
 * @param {object} deps
 * @param {object} deps.subscriptions источник данных
 * @param {object} deps.series источник карточки: адрес сериала должен существовать
 * @param {Function} deps.sessionMw
 */
export function createSubscribeRoutes({ subscriptions, series, sessionMw }) {
  const router = express.Router({ strict: true });
  router.use('/:locale{/:rest}', sessionMw);

  router.post('/:locale/series/:slug/subscribe', async (req, res, next) => {
    const { locale, slug } = req.params;
    if (!isLocale(locale)) return next('route');

    const back = backTo({ locale, slug, req });

    // Гость идёт на вход и возвращается сюда (R-SEC-08).
    if (!req.session?.user) return res.redirect(303, `/${locale}/login?next=${encodeURIComponent(back)}`);

    if (!csrfValid(req.session, req.body?.csrf)) {
      return res.status(403).type('text/plain; charset=utf-8')
        .send(`${t(locale, 'subs.error.csrf')}\n\n${back}`);
    }

    const found = await series.bySlug(slug);
    if (!found) return res.status(404).type('text/plain; charset=utf-8').send(t(locale, 'subs.error.missing'));

    const kind = String(req.body?.kind ?? 'release');
    // Неизвестный вид — ошибка вызывающего кода: белый список уже отсекает
    // мусор из адреса, значит сюда пришло что-то чужое.
    if (!KINDS.includes(kind)) return res.status(400).type('text/plain; charset=utf-8').send('bad kind');

    const on = String(req.body?.on ?? '') === '1';
    const result = await subscriptions.toggle({
      userId: req.session.user.id,
      seriesId: found.id,
      kind,
      on,
    });

    // Потолок подписок — единственный отказ, который человек может исправить
    // сам, поэтому о нём говорит страница, а не пустой ответ: вернуться и
    // ничего не увидеть — это «ничего не произошло».
    if (!result.ok && result.reason === 'limit') {
      return res.redirect(303, `${back}?subs=limit`);
    }

    // Снятый с публикации (EC-T8) и неизвестный сериал — молча назад: колокольчик
    // на такой карточке и не должен был работать.
    return res.redirect(303, back);
  });

  return router;
}

/**
 * Адрес возврата: страница, откуда нажали.
 *
 * `view=library` — кнопка в карточке закладки. Путь собирается здесь, из
 * локали и адреса сериала: значение из тела запроса не доверяется как путь.
 */
function backTo({ locale, slug, req }) {
  return req.body?.view === 'library'
    ? `/${locale}/library`
    : `/${locale}/series/${slug}`;
}
