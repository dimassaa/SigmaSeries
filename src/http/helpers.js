// Общие мелочи HTTP-обвязки.
//
// Пять маршрутов отвечали одинаково и одинаково брали адрес посетителя:
// правило, написанное пять раз, разъезжается при первом же исправлении. Здесь
// оно одно.

import { hashToken } from '../services/auth/password.js';

/**
 * Ответ служебной страницы.
 *
 * Личная страница не кэшируется: иначе на общем компьютере следующий человек
 * увидит из кэша заполненную форму и адрес из неё (R-SEC-24).
 *
 * @param {import('express').Response} res
 * @param {number} status
 * @param {{__raw: string}} page
 * @returns {import('express').Response}
 */
export function respond(res, status, page) {
  res.set('X-Robots-Tag', 'noindex, follow');
  res.set('Cache-Control', 'no-store');
  return res.status(status).type('html').send(page.__raw);
}

/**
 * Адрес посетителя для лимитов.
 *
 * Заголовок берётся только если приложение стоит за прокси: иначе им можно
 * подделать счётчик (R-SEC-31).
 *
 * @param {object} req
 * @returns {string}
 */
export function clientIp(req) {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Хеш токена; при мусоре на входе — null, без исключения.
 *
 * @param {unknown} token
 * @returns {string|null}
 */
export function safeHash(token) {
  if (typeof token !== 'string' || !token) return null;
  return hashToken(token);
}
