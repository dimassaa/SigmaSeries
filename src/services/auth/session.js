// Хранилище сессий.
//
// R-SEC-02: сессии живут на сервере, cookie содержит только идентификатор
// и помечена HttpOnly, Secure, SameSite=Lax. Хранение в памяти исключено:
// перезапуск выкинул бы человека из аккаунта посреди работы, а на очной
// демонстрации это случилось бы при худшем времени.

import crypto from 'node:crypto';

import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';

import { AUTH } from '../../config/settings.js';

export function createSessionMiddleware(pool, providedStore) {
  const store = providedStore ?? new (connectPgSimple(session))({
    pool,
    tableName: 'session',
    // Чистить протухшие записи должен кто-то: иначе таблица растёт
    // бесконечно, а сессии лежат после истечения срока.
    pruneSessionInterval: 15 * 60,
  });

  return session({
    name: AUTH.cookieName,
    store,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    // Смена идентификатора при входе обязательна: без неё идентификатор
    // госте��ой сессии становится идентификатором пользовательской (R-SEC-02).
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: AUTH.viewerAbsoluteMs,
    },
  });
}

/**
 * CSRF-токен на сессию.
 *
 * Генерируется один раз и живёт вместе с сессией: отдельный токен в форме
 * без привязки к сессии защищает от чужих форм не лучше, чем его отсутствие.
 */
export function csrfToken(session) {
  if (!session.csrf) {
    session.csrf = cryptoRandom();
  }
  return session.csrf;
}

/** Проверка. Не сравнение строк, а устойчивое к таймингу сравнение. */
export function csrfValid(session, token) {
  const expected = session?.csrf;
  if (!expected || typeof token !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function cryptoRandom() {
  return crypto.randomBytes(32).toString('base64url');
}
/**
 * Хранилище сессий в памяти.
 *
 * Существует ради тестов и для запуска без базы. В рабочем режиме
 * использовать нельзя: перезапуск выкидывает всех, а при нескольких
 * процессах каждый видит только свои сессии. Тесты HTTP идут против
 * PostgreSQL, но им нужен магазин без настоящей таблицы `session`, иначе
 * каждая проверка требует развёрнутой базы.
 *
 * Наследует Store, а не перекрывает createSession: базовая реализация
 * разжимает сохранённый объект в настоящий Session с полем cookie и
 * без этого express-session падает на первом чтении.
 */
export function createMemorySessionStore() {
  const rows = new Map();
  const now = () => Date.now();

  const store = new session.Store();

  store.get = (sid, cb) => {
    const row = rows.get(sid);
    if (!row) return cb(null, null);
    if (row.expiresAt <= now()) {
      rows.delete(sid);
      return cb(null, null);
    }
    return cb(null, row.data);
  };

  store.set = (sid, sess, cb) => {
    const ttl = sess?.cookie?.originalMaxAge ?? sess?.cookie?.maxAge ?? 86400000;
    rows.set(sid, { data: sess, expiresAt: now() + ttl });
    if (cb) cb(null);
  };

  store.destroy = (sid, cb) => {
    rows.delete(sid);
    if (cb) cb(null);
  };

  store.touch = (sid, sess, cb) => store.set(sid, sess, cb);
  store.all = (cb) => cb(null, [...rows.values()].map((r) => r.data));
  store.length = (cb) => cb(null, rows.size);
  store.clear = (cb) => { rows.clear(); if (cb) cb(null); };

  return store;
}
