// Шаг 3 регистрации: «Выберите любимые» (F-01-01 §4).
//
// Шаг был описан, отмечен в интерфейсе («Шаг 2 из 3») и отсутствовал: после
// подтверждения адреса человека отправляли на главную, а зёрна вкуса, на которых
// зиждется холодный старт рекомендаций, никто не выбирал.
//
// Правила проверяются на сервере, а не в форме: сетка отключает «Готово», но
// прямой запрос с шестью сериалами или с четырьмя одного жанра обязан быть
// отвергнут. Иначе правило держится на честности посетителя.

import express from 'express';

import { layout } from '../view/layout.js';
import { tasteStepView } from '../view/register.js';
import { csrfToken, csrfValid } from '../services/auth/session.js';
import { GRID_SIZE, MAX_CHOICE, MIN_CHOICE } from '../services/recommendations/taste.js';
import { isLocale, t } from '../i18n/strings.js';
// Таблицы стилей этой страницы: общая плюс нужные группам. Список
// берётся из `src/config/styles.js`, порядок подключения — оттуда же.
const STYLES = ['identity'];


const rawHtml = (page) => page.__raw;

/**
 * Шаг 3 (F-01-01 §4, H-55).
 *
 * @param {object} deps
 * @param {object} deps.taste источник зёрен вкуса (`pgTaste`)
 * @param {object} deps.search поиск по тексту для строки поиска на шаге
 * @param {object} deps.auth хранилище учётных записей
 * @param {object} deps.sessionMw
 */
export function createTasteRoutes({ taste, search, auth, sessionMw }) {
  const router = express.Router({ strict: true });
  router.use('/:locale{/:rest}', sessionMw);

  /**
   * Карточки, найденные поиском.
   *
   * Строки поиска не несут жанра, поэтому он добирается вторым запросом: у
   * карточки на шаге подпись та же, что в каталоге, и человек не должен видеть
   * на одной сетке подписи, а на другой — пустоту.
   *
   * @param {string} query
   * @returns {Promise<object[]>}
   */
  const searched = async (query) => {
    const found = await search.find({ query, limit: GRID_SIZE });
    const genres = await taste.genresOf(found.series.map((row) => row.id));
    return found.series.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      posterWidth: row.poster_width,
      ...(genres.get(Number(row.id)) ?? { genreCode: null, genreRu: null, genreEn: null }),
    }));
  };

  router.get('/:locale/register/taste', async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const user = req.session?.user ?? null;
    if (!user) return res.redirect(303, `/${locale}/login?next=${encodeURIComponent(`/${locale}/register/taste`)}`);

    try {
      const query = String(req.query.q ?? '').trim();
      // Поиск идёт своим модулем: каталог не умеет искать по тексту, и запрос с
      // `q` вернул бы ему всю выдачу — то есть поиск был бы украшением.
      const items = query
        ? await searched(query)
        : await taste.popular();
      return res.status(200).type('html').send(rawHtml(layout({
        styles: STYLES,
        account: req.account,
        locale,
        path: '/register/taste',
        title: `${t(locale, 'register.step3.title')} — ${t(locale, 'app.title')}`,
        description: t(locale, 'register.step3.lead', { min: MIN_CHOICE, max: MAX_CHOICE }),
        noindex: true,
        body: tasteStepView({
          locale,
          csrf: csrfToken(req.session),
          items,
          query,
          chosen: await taste.selected(user.id),
          reason: String(req.query.taste ?? '') || null,
        }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:locale/register/taste', async (req, res, next) => {
    const locale = req.params.locale;
    if (!isLocale(locale)) return next('route');

    const user = req.session?.user ?? null;
    if (!user) return res.redirect(303, `/${locale}/login?next=${encodeURIComponent(`/${locale}/register/taste`)}`);

    const body = req.body ?? {};
    if (!csrfValid(req.session, body.csrf)) {
      return res.status(403).type('text/plain; charset=utf-8').send(t(locale, 'signin.error.csrf'));
    }

    const back = `/${locale}/register/taste`;
    // «Пропустить» доступен всегда и не оставляет зёрен: человек, который не
    // хочет ничего выбирать, не должен получать за это отказ (F-01-01 §4).
    if (String(body.action ?? '') === 'skip') return res.redirect(303, `/${locale}/`);

    const chosen = [].concat(body.series ?? []).map(String);
    const result = await taste.save({ userId: user.id, seriesIds: chosen });
    if (!result.ok) return res.redirect(303, `${back}?taste=${result.reason}`);

    // Шаг пройден один раз: возвращаться на него при каждом входе незачем, а
    // повторный выбор поверх сохранённого тихо менял бы зёрна.
    delete req.session.pendingUser;
    return res.redirect(303, `/${locale}/`);
  });

  return router;
}