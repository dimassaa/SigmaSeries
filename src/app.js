// Сборка приложения.
//
// createApp возвращает готовое приложение Express без listen() — так его
// поднимает тест на случайном порту и не занимает настоящий. server.js
// делает то же самое и запускает.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { createHomeRoutes, createNotFoundRoutes, errorHandler, robots } from './routes/home.js';
import { DEFAULT_LOCALE } from './i18n/strings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, '..', 'public');

/**
 * @param {object} deps
 * @param {object} deps.data источник данных S-01
 * @param {string} [deps.publicDir] где лежит собранная таблица стилей
 */
export function createApp({ data, publicDir = PUBLIC_DIR }) {
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
    });
    next();
  });

  // Корень всегда русский, независимо от заголовков запроса (ADR-003).
  app.get('/', (_req, res) => res.redirect(301, `/${DEFAULT_LOCALE}/`));
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send(robots()));

  app.use(express.static(publicDir, {
    maxAge: '1y',
    immutable: true,
    setHeaders(res) {
      // Встроенный ранний скрипт темы меняет тему до отрисовки.
      res.set('Content-Security-Policy', "script-src 'self' 'unsafe-inline'");
    },
  }));

  app.use(createHomeRoutes({ data }));
  app.use(createNotFoundRoutes());
  app.use(errorHandler(DEFAULT_LOCALE));

  return app;
}