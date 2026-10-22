// Потолок очереди модерации (R-MOD-11, F-05-03).
//
// Проверяются и правило (числа), и «низкое доверие» по живой базе: автор с
// историей модерации и автор без неё считаются по-разному.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';
import {
  pgModerationBudget, queueOverflowFrom, QUEUE_CEILING,
} from '../src/services/moderation/budget.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — потолок очереди не проверялся';

let pool;

test.before(async () => {
  if (!available) return;
  pool = createPool();
});

test.after(async () => {
  if (!pool) return;
  await pool.end();
});

test('потолок — две тысячи ожидающих, а отказ достаётся лишь «низкому доверию»', () => {
  assert.equal(QUEUE_CEILING, 2000, 'потолок взят из правила R-MOD-11');

  assert.deepEqual(queueOverflowFrom({ waiting: 1999, lowTrust: true }), {
    full: false, lowTrust: true, refuse: false,
  }, 'до потолка очередь ещё не переполнена');

  assert.deepEqual(queueOverflowFrom({ waiting: 2000, lowTrust: false }), {
    full: true, lowTrust: false, refuse: false,
  }, 'переполнение без истории модерации не отказывает');

  assert.deepEqual(queueOverflowFrom({ waiting: 2000, lowTrust: true }), {
    full: true, lowTrust: true, refuse: true,
  }, 'переполнение с историей модерации отказывает');
});

test('низкое доверие — это помеченные материалы автора', { skip }, async () => {
  const budget = pgModerationBudget(pool);

  // Свой автор: чужой «свободный» пользователь может получить материал от
  // параллельного файла между выбором и проверкой, и тогда проверка
  // «истории нет» падает не по вине кода.
  const nickname = `ceiling-${crypto.randomUUID().slice(0, 8)}`;
  const { hash } = makeToken();
  const { id: userId } = await pgAuthStore(pool).createUser({
    email: `${nickname}@example.com`,
    nickname,
    passwordHash: 'x',
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });

  const slug = `ceiling-${crypto.randomUUID().slice(0, 8)}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Потолок очереди: тест', 'Ceiling fixture', $2, 'published', 'airing', 2026)
     RETURNING id`,
    [slug, 965_000_000 + Math.floor(Math.random() * 900)],
  );

  try {
    const clean = await budget.queueOverflow(userId);
    assert.equal(clean.lowTrust, false, 'у нового автора истории нет');
    assert.equal(clean.refuse, false);

    await pool.query(
      `INSERT INTO e_material (author_id, kind, series_id, body, state, submitted_at)
       VALUES ($1, 'review', $2, 'текст', 'flagged', now())`,
      [userId, series.id],
    );
    const flagged = await budget.queueOverflow(userId);
    assert.equal(flagged.lowTrust, true, 'помеченный материал — это история модерации');
  } finally {
    await pool.query('DELETE FROM e_material WHERE author_id = $1', [userId]);
    await pool.query('DELETE FROM e_series WHERE id = $1', [series.id]);
  }
});
