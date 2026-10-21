// Потолок очереди модерации (R-MOD-11, F-05-03).
//
// Проверяются и правило (числа), и «низкое доверие» по живой базе: автор с
// историей модерации и автор без неё считаются по-разному.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
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
  // Последний по номеру свободный пользователь: проверка бюджета помеченных
  // берёт первого, иначе проверки мешали бы друг другу.
  const { rows } = await pool.query(
    `SELECT u.id FROM e_user u
      WHERE NOT EXISTS (SELECT 1 FROM e_material m WHERE m.author_id = u.id)
      ORDER BY u.id DESC LIMIT 1`,
  );
  const userId = rows[0]?.id;
  assert.ok(userId, 'есть пользователь без материалов');

  await pool.query('DELETE FROM e_material WHERE author_id = $1', [userId]);
  const clean = await budget.queueOverflow(userId);
  assert.equal(clean.lowTrust, false, 'у нового автора истории нет');
  assert.equal(clean.refuse, false);

  // Второй сериал: первый занят проверкой бюджета помеченных, а отзыв
  // автора на одном сериале может быть только один.
  const { rows: series } = await pool.query('SELECT id FROM e_series ORDER BY id LIMIT 1 OFFSET 1');
  await pool.query(
    `INSERT INTO e_material (author_id, kind, series_id, body, state, submitted_at)
     VALUES ($1, 'review', $2, 'текст', 'flagged', now())`,
    [userId, series[0].id],
  );
  const flagged = await budget.queueOverflow(userId);
  assert.equal(flagged.lowTrust, true, 'помеченный материал — это история модерации');

  await pool.query(
    `DELETE FROM e_material WHERE author_id = $1 AND kind = 'review' AND body = 'текст'`,
    [userId],
  );
});
