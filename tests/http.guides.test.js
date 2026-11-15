// Руководство через HTTP: отказ POST-формы (№265).
//
// Отказы форм раньше уходили text/plain без оформления: человек видел белую
// страницу с одной служебной строкой. Проверяется то, что видно снаружи:
// отказ приходит страницей в общем каркасе, с той же причиной словами.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { pgGuides } from '../src/services/guides/service.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';
const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — руководство через HTTP не проверялось';

let pool;
const fixtures = [];

async function viewer() {
  const { hash } = makeToken();
  const email = `guide-http-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const created = await pgAuthStore(pool).createUser({
    email,
    nickname: `guide-http-${crypto.randomUUID().slice(0, 8)}`,
    passwordHash: await hashPassword(PASSWORD),
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  await pool.query('UPDATE e_user SET email_confirmed = TRUE WHERE id = $1', [created.id]);
  fixtures.push(created.id);
  return {
    id: created.id,
    email,
    email_enc: null,
    password_hash: await hashPassword(PASSWORD),
    nickname: 'мария',
    status: 'active',
    email_confirmed: true,
    locale: 'ru',
    theme: 'dark',
    timezone: 'Europe/Minsk',
  };
}

async function withServer({ user, run }) {
  const auth = stubAuthStore({ [user.email]: user });
  const app = createApp({
    data: stubData(),
    auth,
    series: pgSeries(pool),
    guides: pgGuides(pool),
    dictionary: { load: async () => ({ block: [], allow: [], available: true }) },
    sessionMw: createSessionMiddleware(pool, createMemorySessionStore(), {
      account: async (u) => ({ nickname: u.nickname, unread: 0, pollSeconds: 0 }),
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
  const post = (path, fields, init = {}) => get(path, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(init.headers ?? {}) },
    body: new URLSearchParams(fields),
  });
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

  if (user) {
    const form = await (await get('/ru/login')).text();
    await post('/ru/login', { email: user.email, password: PASSWORD, csrf: csrfOf(form) });
  }

  try {
    await run({ get, post, csrfOf });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
});

test.after(async () => {
  if (!pool) return;
  for (const id of fixtures) {
    await pool.query('DELETE FROM e_material WHERE author_id = $1', [id]);
    await pool.query('DELETE FROM e_user WHERE id = $1', [id]);
  }
  await pool.end();
});

test('слишком короткая статья приходит отказом-страницей, а не голым текстом (№265)', { skip }, async () => {
  const user = await viewer();
  const slug = `guide-refusal-${crypto.randomUUID().slice(0, 8)}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, imdb_key, title_ru, title_original, year_start, exit_state, publication_state, reasons, level)
     VALUES ($1, $2, 'Сериал для отказа', 'Refusal series', 2020, 'ended', 'published', '{}', 'minimum')
     RETURNING id`,
    [slug, `tt${crypto.randomUUID().slice(0, 8)}`],
  );

  try {
    await withServer({
      user,
      run: async ({ get, post, csrfOf }) => {
        const page = await (await get(`/ru/series/${slug}`)).text();
        const res = await post('/ru/guides', {
          series_slug: slug,
          title: 'Разбор',
          text: '## Раздел\nМало текста.',
          csrf: csrfOf(page),
        });
        assert.equal(res.status, 400);
        // Отказ в общем каркасе: HTML со стилями и сообщением, а не text/plain.
        assert.match(res.headers.get('content-type') ?? '', /text\/html/);
        const text = await res.text();
        assert.match(text, /<main/, 'страница отказа в общем каркасе');
        assert.match(text, /message__title/, 'заголовок отказа на месте');
        assert.match(text, /слишком коротк/i, 'причина отказа видна словами');
        // Уничтоженный до фикса ответ состоял из одной строки причины без каркаса.
        assert.ok(text.length > 500, 'отказ не одна строка, а страница');
      },
    });
  } finally {
    await pool.query('DELETE FROM e_series WHERE id = $1', [series.id]);
  }
});
