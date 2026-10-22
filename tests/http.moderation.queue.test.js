// Экран очереди модерации по HTTP (F-05-04, S-50).
//
// Проверяется то, что видит редактор: очередь в порядке разбора, материал
// крупно, найденное слово и форма решения. И то, что экран служебный:
// зрителю он не выдаётся.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { generateSecret, totpAt } from '../src/services/auth/totp.js';
import { pgModerationDecisions } from '../src/services/moderation/decision.js';
import { pgModerationClusters } from '../src/services/moderation/cluster.js';
import { pgModerationBudget } from '../src/services/moderation/budget.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';
const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — очередь модерации не проверялась';

let pool;
let auth;
const series = [];

async function staff({ roles = ['editor'] } = {}) {
  const { hash } = makeToken();
  const nickname = `queue-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${nickname}@example.com`;
  const passwordHash = await hashPassword(PASSWORD);
  const created = await pgAuthStore(pool).createUser({
    email,
    nickname,
    passwordHash,
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  await pool.query(
    `UPDATE e_user SET email_confirmed = TRUE, registered_at = now() - interval '30 days' WHERE id = $1`,
    [created.id],
  );
  for (const role of roles) {
    await pool.query(
      `INSERT INTO e_role_assignment (user_id, role, granted_by, note) VALUES ($1, $2, $1, 'тест очередь')`,
      [created.id, role],
    );
  }
  const secret = generateSecret();
  if (roles.length) await auth.enableTwoFactor(created.id, secret, []);
  return { id: created.id, email, nickname, passwordHash, roles, secret };
}

async function seriesWith() {
  const { rows: [row] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Очередь фикстуры', 'Queue fixture', $2, 'published', 'airing', 2024) RETURNING id`,
    [`queue-${crypto.randomUUID().slice(0, 8)}`, 970_000_000 + Math.floor(Math.random() * 900)],
  );
  series.push(row.id);
  return row.id;
}

/** Материал в очереди: помечен, с находкой и жалобой. */
async function material({ authorId, seriesId, body, matches = [], complaints = 0 }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO e_material (author_id, kind, series_id, body, state, matches)
     VALUES ($1, 'review', $2, $3, 'flagged', $4) RETURNING id`,
    [authorId, seriesId, body, JSON.stringify(matches)],
  );
  for (let i = 0; i < complaints; i += 1) {
    // Жалобы от разных людей: одна и та же жалоба дважды не считается
    // (порог — по разным пользователям, R-MOD-16).
    const { rows: [reporter] } = await pool.query(
      `INSERT INTO e_user (email_hash, email_blind_idx, email_enc, password_hash, nickname, email_confirmed)
       VALUES (decode(md5($1),'hex'), decode(md5($1),'hex'), decode(md5($1),'hex'), 'x', $2, TRUE)
       RETURNING id`,
      [`complaint-${crypto.randomUUID()}@example.com`, `complaint-${crypto.randomUUID().slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO e_report (material_id, user_id, reason) VALUES ($1, $2, 'spam')`,
      [row.id, reporter.id],
    );
  }
  return Number(row.id);
}

async function withServer({ user = null, run }) {
  const app = createApp({
    data: stubData(),
    auth,
    decisions: pgModerationDecisions(pool),
    moderationClusters: pgModerationClusters(pool),
    moderationBudget: pgModerationBudget(pool),
    audit: { write: async (entry) => entry },
    // createApp объявляет middleware сессий функцией, а модуль отдаёт обработчик
    // или их пару — Express принимает и то и другое.
    sessionMw: /** @type {Function} */ (createSessionMiddleware(pool, createMemorySessionStore(), {
      account: async (u) => ({ nickname: u.nickname, unread: 0, pollSeconds: 0 }),
    })),
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
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

  if (user) {
    const form = await (await get('/ru/login')).text();
    const first = await get('/ru/login', { method: 'POST', body: new URLSearchParams({
      email: user.email, password: PASSWORD, csrf: csrfOf(form),
    }), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    if (first.headers.get('location')?.endsWith('/2fa')) {
      const page = await (await get('/ru/2fa')).text();
      await get('/ru/2fa', {
        method: 'POST',
        body: new URLSearchParams({
          code: totpAt(user.secret, Math.floor(Date.now() / 1000)),
          csrf: csrfOf(page),
        }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        redirect: 'manual',
      });
    }
  }

  try {
    await run({ get, csrfOf });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
  auth = pgAuthStore(pool);
});

test.after(async () => {
  if (!pool) return;
  const ids = `SELECT id FROM e_series WHERE id = ANY($1::bigint[])`;
  await pool.query(`DELETE FROM e_report WHERE material_id IN (SELECT id FROM e_material WHERE series_id IN (${ids}))`, [series]);
  await pool.query(`DELETE FROM e_editor_decision WHERE material_id IN (SELECT id FROM e_material WHERE series_id IN (${ids}))`, [series]);
  // Кластеры убираются до материалов: их сигнатуры ищутся по материалам, а
  // решение по кластеру доживает до новых материалов и без них.
  await pool.query(`DELETE FROM e_moderation_cluster WHERE signature IN (
    SELECT signature FROM e_material WHERE series_id IN (${ids}) GROUP BY signature)`, [series]);
  await pool.query(`DELETE FROM e_material WHERE series_id IN (${ids})`, [series]);
  await pool.query('DELETE FROM e_series WHERE id = ANY($1::bigint[])', [series]);
  await pool.query("DELETE FROM e_role_assignment WHERE note = 'тест очередь'");
  await pool.query("DELETE FROM e_user WHERE nickname LIKE 'complaint-%'");
  await pool.query("DELETE FROM e_two_factor WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE 'queue-%')");
  await pool.end();
});

test('редактор видит очередь и разбирает материал (F-05-04, S-50)', { skip }, async () => {
  const seriesId = await seriesWith();
  const author = await staff({ roles: [] });
  const editor = await staff({ roles: ['editor'] });
  const id = await material({
    authorId: author.id,
    seriesId,
    body: 'Материал, который редактор разбирает: текст целиком, без обрезки.',
    matches: [{ word: 'запрещённое', list: 'block', category: 'profanity' }],
    complaints: 2,
  });

  await withServer({
    user: editor,
    run: async ({ get }) => {
      const queue = await (await get('/ru/mod')).text();
      assert.match(queue, /Очередь модерации/, 'заголовок экрана');
      assert.match(queue, new RegExp(`material=${id}`), 'материал в очереди');
      assert.match(queue, /2 жалоб/, 'число жалоб показано');
      assert.match(queue, /name="robots" content="noindex/, 'экран служебный');

      const material = await (await get(`/ru/mod?material=${id}`)).text();
      assert.match(material, /Материал, который редактор разбирает: текст целиком, без обрезки\./,
        'текст материала показан целиком');
      assert.match(material, /запрещённое/, 'найденное слово видно редактору');
      assert.match(material, /name="decision" value="approve"/, 'есть действие «Одобрить»');
      assert.match(material, /name="decision" value="reject"/, 'есть действие «Запретить»');
      assert.match(material, /name="reason"/, 'причина обязательна');
    },
  });
});

test('зрителю очередь не выдаётся (EC-R7)', { skip }, async () => {
  await withServer({
    user: await staff({ roles: [] }),
    run: async ({ get }) => {
      const res = await get('/ru/mod');
      assert.equal(res.status, 404, 'служебный экран не выдаёт своего существования');
    },
  });
});
