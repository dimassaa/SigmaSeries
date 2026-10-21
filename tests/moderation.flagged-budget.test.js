// Бюджет помеченных попыток (R-MOD-08, F-05-03).
//
// Проверяются и правило (числа), и счётчик по живой базе: правило без счётчика
// не ограничивает никого, а счётчик без правила — просто число.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import {
  pgModerationBudget, flaggedBudgetFrom, FLAGGED_BUDGET,
} from '../src/services/moderation/budget.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — бюджет помеченных не проверялся';

let pool;

test.before(async () => {
  if (!available) return;
  pool = createPool();
});

test.after(async () => {
  if (!pool) return;
  await pool.end();
});

test('пятый помеченный материал за час даёт мьют на час, повтор — на сутки', () => {
  assert.equal(FLAGGED_BUDGET.limit, 5, 'порог взят из правила R-MOD-08');

  assert.deepEqual(flaggedBudgetFrom({ flaggedInHour: 4 }), {
    mute: false, hours: null, reason: null, hits: 0, notify: false,
  }, 'четыре помеченных — ещё не бюджет');

  const first = flaggedBudgetFrom({ flaggedInHour: 5, hits: 1 });
  assert.equal(first.mute, true);
  assert.equal(first.hours, 1, 'первый мьют — на час');
  assert.equal(first.notify, false, 'первый раз администратора не тревожим');

  const repeat = flaggedBudgetFrom({ flaggedInHour: 5, hits: 2 });
  assert.equal(repeat.mute, true);
  assert.equal(repeat.hours, 24, 'повтор — на сутки');
  assert.equal(repeat.notify, false);

  const third = flaggedBudgetFrom({ flaggedInHour: 5, hits: 3 });
  assert.equal(third.hours, 24);
  assert.equal(third.notify, true, 'третий раз — флаг администратору');
});

test('бюджет считает помеченные материалы автора за час', { skip }, async () => {
  const budget = pgModerationBudget(pool);
  // Первый по номеру свободный пользователь: проверка потолка очереди берёт
  // последнего, иначе проверки мешали бы друг другу.
  const { rows } = await pool.query(
    `SELECT u.id FROM e_user u
      WHERE NOT EXISTS (SELECT 1 FROM e_material m WHERE m.author_id = u.id)
      ORDER BY u.id LIMIT 1`,
  );
  const userId = rows[0]?.id;
  assert.ok(userId, 'есть пользователь без материалов');

  const before = await budget.flaggedBudget(userId);
  assert.equal(before.flaggedInHour, 0);
  assert.equal(before.mute, false);

  const { rows: series } = await pool.query('SELECT id FROM e_series LIMIT 1');
  assert.ok(series[0]?.id, 'есть сериал для материала');
  await pool.query(
    `INSERT INTO e_material (author_id, kind, series_id, body, state, submitted_at)
     VALUES ($1, 'review', $2, 'текст', 'flagged', now())`,
    [userId, series[0].id],
  );
  const after = await budget.flaggedBudget(userId);
  assert.equal(after.flaggedInHour, before.flaggedInHour + 1, 'помеченный материал в счёт попал');
  assert.equal(after.mute, false, 'одно помеченное — ещё не бюджет');

  await pool.query(
    `DELETE FROM e_material WHERE author_id = $1 AND kind = 'review' AND body = 'текст'`,
    [userId],
  );
});
