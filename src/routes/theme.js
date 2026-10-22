// Переключатель темы в шапке: выбор сохраняется в профиле (F-01-06 §8).
//
// Тему человека видно на каждой странице, и она должна быть одна: профиль
// говорит «какая тема», а браузер не должен решать по-своему. Поэтому
// переключатель в шапке пишет выбор в профиль, а страница берёт тему оттуда.
//
// Гостю сохранять нечего: его тема живёт в браузере, и сервер отвечает
// «204», ничего не меняя.

import express from 'express';

import { csrfValid } from '../services/auth/session.js';
import { isLocale } from '../i18n/strings.js';

/** Темы из `e_user.theme` (CHECK в схеме). */
const THEMES = ['light', 'dark', 'system'];

/**
 * Маршруты переключателя темы.
 *
 * @param {object} deps
 * @param {any} [deps.auth] источник учётных записей
 * @param {any} [deps.sessionMw] middleware сессий
 * @returns {import('express').Router}
 */
export function createThemeRoutes({ auth = null, sessionMw = null }) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  router.post('/:locale/theme', async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    try {
      const user = req.session?.user ?? null;
      // Гость: тема живёт в его браузере, серверу нечего менять.
      if (!user) return res.status(204).end();

      const body = req.body ?? {};
      if (!csrfValid(req.session, body.csrf)) {
        return res.status(403).type('text/plain; charset=utf-8').send('Токен не тот.');
      }
      const theme = String(body.theme ?? '');
      if (!THEMES.includes(theme)) {
        return res.status(400).type('text/plain; charset=utf-8').send('Темы такой нет.');
      }

      await auth.updatePreferences(user.id, { theme });
      // Сессия — то, что страница читает на каждом экране: без неё тема
      // осталась бы прежней до следующего входа.
      req.session.user.theme = theme;
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
