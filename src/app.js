// Сборка приложения.
//
// createApp возвращает готовое приложение Express без listen() — так его
// поднимает тест на случайном порту и не занимает настоящий. server.js
// делает то же самое и запускает.

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { createHomeRoutes, createNotFoundRoutes, errorHandler, robots } from './routes/home.js';
import { createAuthRoutes } from './routes/auth.js';
import { createRegisterRoutes } from './routes/register.js';
import { createResetRoutes } from './routes/reset.js';
import { createTwoFactorRoutes } from './routes/twofactor.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createJournal } from './services/journal.js';
import { DEFAULT_LOCALE } from './i18n/strings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, '..', 'public');

/**
 * @param {object} deps
 * @param {object} deps.data источник данных S-01
 * @param {object} deps.auth доступ к учётным записям
 * @param {Function} deps.sessionMw middleware сессий
 * @param {object} [deps.mailQueue] очередь служебных писем (F-01-12)
 * @param {string} [deps.publicDir] где лежит собранная таблица стилей
 */
export function createApp({
  data,
  auth,
  sessionMw,
  mailQueue,
  journal = createJournal(),
  baseUrl = '',
  now = () => Date.now(),
  publicDir = PUBLIC_DIR,
}) {
  const app = express();

  // Заголовки безопасности. helmet в списке зависимостей нет: набор ниже
  // покрывает то, что важно для серверного рендеринга без форм и загрузок,
  // и не тянет библиотеку ради шести строк.
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'",
      // Идентификатор свой, а не присланный: иначе человек подставил бы в
      // журнал перевод строки и дописал запись (R-SEC-29).
      'X-Request-Id': crypto.randomUUID(),
    });
    req.requestId = res.getHeader('X-Request-Id');
    next();
  });

  // Корень всегда русский, независимо от заголовков запроса (ADR-003).
  app.get('/', (_req, res) => res.redirect(301, `/${DEFAULT_LOCALE}/`));
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send(robots()));

  // Разбор тела запроса. Без него req.body пуст, и любая проверка CSRF
  // отклоняет всё подряд — форма выглядит сломанной без видимой причины.
  // extended:false — свойства с точками не разбираются в объекты, иначе
  // параметр вида user[password] может стать вложенным объектом.
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(express.json({ limit: '16kb' }));

  app.use(express.static(publicDir, {
    maxAge: '1y',
    immutable: true,
    setHeaders(res) {
      // Встроенный ранний скрипт темы меняет тему до отрисовки.
      res.set('Content-Security-Policy', "script-src 'self' 'unsafe-inline'");
    },
  }));

  app.use(createHomeRoutes({ data }));

  if (auth && sessionMw) {
    // Маршруты входа подключаются только если есть и хранилище, и middleware:
    // страница без работающей сессии опаснее, чем её отсутствие.
    app.use(createAuthRoutes({ auth, sessionMw }));
    app.use(createRegisterRoutes({ auth, sessionMw, mailQueue, baseUrl }));
    app.use(createResetRoutes({ auth, sessionMw, mailQueue, journal, baseUrl }));
    app.use(createTwoFactorRoutes({ auth, sessionMw, journal, mailQueue, now }));
  }
  // Настройки доступны и гостю: тема и язык хранятся у него на стороне
  // браузера, вход для них не нужен (F-01-06 §8(а)).
  if (auth && sessionMw) {
    app.use(createSettingsRoutes({ auth, sessionMw, journal, mailQueue, now, baseUrl }));
  }
  app.use(createNotFoundRoutes());
  app.use(errorHandler(DEFAULT_LOCALE));

  return app;
}