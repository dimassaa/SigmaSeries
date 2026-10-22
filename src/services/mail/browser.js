// Отметка браузера для демо-помощника (F-01-12 §4, H-51).
//
// Письмо привязывается к браузеру, который его заказал, и показывается только
// ему. Отметка живёт в подписанной cookie: подпись не даёт ни подделать её,
// ни назвать чужую, а короткий срок не даёт использовать её позже.
//
// Подписывается тем же секретом, что и сессия: отдельный секрет ради одной
// cookie заводить нечем, а разделять его с сессией нельзя было бы только по
// недосмотру — оба секрета уже обязательны при запуске.

import crypto from 'node:crypto';

import { MAIL_SETTINGS } from '../../config/settings.js';

const COOKIE = 'mbox';

const secret = () => process.env.SESSION_SECRET ?? '';

/** Подпись отметки: `id.подпись`, сравнение постоянного времени. */
export function signBrowserId(id) {
  const mac = crypto.createHmac('sha256', secret()).update(String(id)).digest('base64url');
  return `${id}.${mac}`;
}

/**
 * Отметка из cookie или пустая строка.
 *
 * Неверная подпись и битая cookie — это не ошибка, а отсутствие отметки:
 * человек просто не увидит подсказку, и это лучше, чем 500 на странице.
 *
 * Заголовок `Cookie` разбирается здесь, а не через `cookie-parser`: ради одной
 * cookie подключать модуль, которого нет в списке зависимостей, незачем.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
export function browserIdFrom(req) {
  const pair = (req.headers?.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`));
  const raw = pair === undefined ? '' : decodeURIComponent(pair.slice(COOKIE.length + 1));
  if (typeof raw !== 'string' || !raw.includes('.')) return '';
  const at = raw.lastIndexOf('.');
  const id = raw.slice(0, at);
  const mac = raw.slice(at + 1);

  const expected = crypto.createHmac('sha256', secret()).update(String(id)).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return '';
  return id;
}

/**
 * Отметка браузера, с выдачей cookie при первом обращении.
 *
 * Cookie ставится только когда её нет: перезаписывать подпись на каждом
 * запросе незачем, а лишняя запись в заголовке мешает кешированию.
 *
 * @returns {string} отметка или пустая строка, если подписи нет
 */
export function ensureBrowserId(req, res) {
  const existing = browserIdFrom(req);
  if (existing) return existing;
  if (!secret()) return '';

  const id = crypto.randomBytes(16).toString('base64url');
  res.cookie(COOKIE, signBrowserId(id), {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(req.secure),
    maxAge: MAIL_SETTINGS.browserCookieMin * 60_000,
    path: '/',
  });
  return id;
}