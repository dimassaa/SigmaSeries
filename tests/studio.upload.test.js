// Загрузка изображения в студии через HTTP (F-10-04).
//
// Проверяется путь целиком: тело multipart разбирается, файл доходит до
// проверки типа по содержимому, изображение попадает в базу. Разбор тела
// проверяется отдельно (`tests/multipart.test.js`), а здесь важно, что
// маршрут вообще подключён и тело доходит до обработчика.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import sharp from 'sharp';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { generateSecret, totpAt } from '../src/services/auth/totp.js';
import { pgStudioCard } from '../src/services/studio/card.js';
import { pgStudioImages } from '../src/services/studio/images.js';
import { pgAuditLog } from '../src/services/audit/log.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — загрузка через HTTP не проверялась';

let pool;
let auth;
let seriesId;
const created = [];

/** Тело multipart с полями и файлом. */
function multipartBody({ fields, filename, content }) {
  const boundary = '----proverka-zagruzki';
  const parts = Object.entries(fields)
    .map(([name, value]) => `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${name}"\r\n\r\n`
      + `${value}\r\n`)
    .join('');
  const head = Buffer.from(
    parts
    + `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + `Content-Type: image/png\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { boundary, body: Buffer.concat([head, content, tail]) };
}

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
  auth = pgAuthStore(pool);

  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, imdb_key, title_ru, title_original, year_start, exit_state, publication_state, reasons, level)
     VALUES ($1, $2, 'Загрузка: тест', 'Upload fixture', 2020, 'ended', 'published', '{}', 'minimum')
     RETURNING id`,
    [`upload-${crypto.randomUUID().slice(0, 8)}`, `tt${crypto.randomUUID().slice(0, 8)}`],
  );
  seriesId = series.id;
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_series WHERE id = $1', [seriesId]);
  await pool.query("DELETE FROM e_role_assignment WHERE note = 'тест загрузки'");
  await pool.query('DELETE FROM e_user WHERE id = ANY($1::bigint[])', [created]);
  await pool.end();
});

test('файл доезжает до карточки и попадает в базу', { skip }, async () => {
  // Админ со включённой двухфакторной проверкой: вход служебной роли без
  // второго фактора не проходит (R-SEC-04).
  const { hash } = makeToken();
  const name = `upload-admin-${crypto.randomUUID().slice(0, 8)}`;
  const passwordHash = await hashPassword('правильный-пароль-из-десяти');
  const account = await auth.createUser({
    email: `${name}@example.com`,
    nickname: name,
    passwordHash,
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  created.push(account.id);
  const secret = generateSecret();
  await auth.enableTwoFactor(account.id, secret, []);
  await pool.query(
    `INSERT INTO e_role_assignment (user_id, role, granted_by, note) VALUES ($1, 'admin', $1, 'тест загрузки')`,
    [account.id],
  );

  const app = createApp({
    data: stubData(),
    auth,
    pool,
    audit: pgAuditLog(pool),
    studioCard: pgStudioCard(pool),
    studioImages: pgStudioImages(pool),
    sessionMw: createSessionMiddleware(pool, createMemorySessionStore(), {
      account: async () => ({ nickname: name, unread: 0, pollSeconds: 0 }),
    }),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let jar = '';

  const get = async (path, init = {}) => {
    const res = await fetch(base + path, {
      redirect: 'manual',
      ...init,
      headers: { cookie: jar, ...(init.headers ?? {}) },
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) jar = set.map((c) => c.split(';')[0]).join('; ');
    return res;
  };
  const post = (path, fields) => get(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

  try {
    const form = await (await get('/ru/login')).text();
    const first = await post('/ru/login', {
      email: `${name}@example.com`,
      password: 'правильный-пароль-из-десяти',
      csrf: csrfOf(form),
    });
    assert.ok(first.headers.get('location')?.endsWith('/2fa'), 'служебная роль требует второго фактора');
    const page = await (await get('/ru/2fa')).text();
    const second = await post('/ru/2fa', {
      code: totpAt(secret, Math.floor(Date.now() / 1000)),
      csrf: csrfOf(page),
    });
    assert.notEqual(second.status, 403, 'второй фактор принят, ответ ' + second.status);

    const cardPage = await (await get(`/ru/admin/catalog/${seriesId}?tab=images`)).text();
    const token = csrfOf(cardPage);
    assert.ok(token, 'у формы загрузки есть токен');

    const png = await sharp({
      create: { width: 1920, height: 1080, channels: 3, background: { r: 10, g: 40, b: 70 } },
    }).png().toBuffer();
    const { boundary, body } = multipartBody({
      fields: { role: 'backdrop', csrf: token },
      filename: 'фон.png',
      content: png,
    });

    const res = await get(`/ru/admin/catalog/${seriesId}/images`, {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    assert.equal(res.status, 303, `загрузка принята, ответ ${res.status}`);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM e_image WHERE series_id = $1 AND role = 'backdrop'`,
      [seriesId],
    );
    assert.equal(rows[0].n, 1, 'изображение записано в базу');
  } finally {
    await /** @type {Promise<void>} */ (new Promise((r) => server.close(r)));
  }
});
