// Публичный профиль пользователя (S-18, F-01-07).
//
// Адрес — `/u/{nick}`. Ник может быть кириллическим, поэтому в адрес он
// попадает закодированным, а ищется без учёта регистра: уникальный индекс
// базы такой же, и «/u/Ivan» и «/u/ivan» — один человек.
//
// Страница личная, поэтому `noindex` (F-01-07 §8). Чужого аккаунта нет —
// 404; удалённый аккаунт отвечает «Пользователь удалён» (EC-A22).

import express from 'express';

import { layout, pageTitle } from '../view/layout.js';
import { profileView, profileHref } from '../view/profile.js';
import { notFound } from './home.js';
import { t, isLocale } from '../i18n/strings.js';
import {
  NICK_ALLOWED,
  NICK_MAX,
  NICK_MIN,
  NICK_SEPARATOR,
} from '../services/auth/validate.js';

const BASE = '/u';

// Таблицы стилей этой страницы: общая плюс нужные группам. Список
// берётся из `src/config/styles.js`, порядок подключения — оттуда же.
const STYLES = ['identity'];

/**
 * Ник из адреса, пригодный для поиска.
 *
 * Правила ника — те же, что при регистрации (F-01-07 §9): иначе в адрес
 * подставляют мусор, и поиск по нему ничего не находит. Негодный ник — это
 * отсутствие пользователя, а не ошибка ввода: страница отвечает 404.
 *
 * @param {string} value
 * @returns {string|null}
 */
function nickFromAddress(value) {
  const nick = String(value ?? '').trim();
  if (nick.length < NICK_MIN || nick.length > NICK_MAX) return null;
  if (!NICK_ALLOWED.test(nick)) return null;
  if (NICK_SEPARATOR.test(nick)) return null;
  return nick;
}

/**
 * Маршруты публичного профиля.
 *
 * @param {object} deps
 * @param {object} deps.profile сервис профиля
 * @param {object|null} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createProfileRoutes({ profile, sessionMw = null }) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  router.get(`/:locale${BASE}/:nick`, async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    try {
      const nick = nickFromAddress(req.params.nick);
      if (!nick) {
        return res.status(404).type('html').send(notFound(locale, req.account).__raw);
      }

      const user = await profile.byNickname(nick);
      if (!user) {
        return res.status(404).type('html').send(notFound(locale, req.account).__raw);
      }

      const tab = req.query.tab === 'guides' ? 'guides' : 'reviews';
      const page = Math.max(1, Number(req.query.page) || 1);
      const marksPage = Math.max(1, Number(req.query.marks) || 1);
      const deleted = user.status === 'deleted';

      const [counts, materials, stats, marked] = await Promise.all([
        profile.counts(user.id),
        profile.materials(user.id, tab === 'guides' ? 'guide' : 'review', { page }),
        // Закрытые части профиля не читаются вовсе: человек, который их не
        // открыл, не должен даже считать, что они там есть.
        deleted || !user.statsPublic ? null : profile.statistics(user.id),
        deleted || !user.profilePublic ? null : profile.marked(user.id, { page: marksPage }),
      ]);

      // Страница за концом списка — не пустой экран, а последняя: адрес
      // остаётся живым, и «?page=999» не плодит одинаковых страниц.
      if (materials.page > materials.pages) {
        const query = tab === 'guides' ? `?tab=guides&page=${materials.pages}` : `?page=${materials.pages}`;
        return res.redirect(301, `/${locale}${BASE}/${encodeURIComponent(user.nickname)}${query}`);
      }

      return res.status(200).type('html').send(layout({
        account: req.account,
        locale,
        path: profileHref(locale, user.nickname).replace(`/${locale}`, ''),
        title: pageTitle(locale, t(locale, 'profile.title', { nickname: user.nickname })),
        description: t(locale, 'profile.description', { nickname: user.nickname }),
        noindex: true,
        styles: STYLES,
        body: profileView({
          locale,
          user,
          counts,
          tab,
          materials,
          stats,
          marked,
          page: materials.page,
          marksPage,
        }),
      }).__raw);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
