// Лимит частоты поиска (`search.rate_limit`, R-SEC-31, DEC-055).
//
// Ключа в документации не было, пока автор не подтвердил 30 запросов в минуту
// (находка #116). Проверяется ровно то, из-за чего находка и появилась: число
// берётся из настроек, а не живёт в коде, и при отсутствии ключа приложение
// не остаётся без предела.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { DEFAULT_RATE_PER_MINUTE, searchSettings } from '../src/services/search/limits.js';
import { searchLimited } from '../src/routes/search.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — лимит частоты поиска не проверялся';

let pool;

test.before(async () => {
  if (!available) return;
  pool = createPool();
});

test.after(async () => {
  if (pool) await pool.end();
});

test('число читается из настроек, и оно совпадает с ключом', { skip }, async () => {
  const { rows } = await pool.query("SELECT value FROM e_system_setting WHERE key = 'search.rate_limit'");
  const { ratePerIp } = await searchSettings(pool);

  assert.ok(rows.length, 'ключ search.rate_limit заведён в базе');
  assert.equal(ratePerIp, Number(rows[0].value));
});

test('без ключа остаётся подтверждённое автором число, а не ноль', { skip }, async () => {
  const { rows } = await pool.query(
    "DELETE FROM e_system_setting WHERE key = 'search.rate_limit' RETURNING key",
  );
  try {
    const { ratePerIp } = await searchSettings(pool);
    assert.equal(ratePerIp, DEFAULT_RATE_PER_MINUTE);
    assert.ok(ratePerIp > 0, 'класс «поиск» без предела оставлять нельзя (R-SEC-31)');
  } finally {
    if (rows.length) {
      await pool.query(
        "INSERT INTO e_system_setting (key, value) VALUES ('search.rate_limit', $1)",
        [DEFAULT_RATE_PER_MINUTE],
      );
    }
  }
});

test('счётчик отпускает ровно столько запросов, сколько разрешено', { skip }, async () => {
  // Разные адреса: счётчик общий на адрес, и чужие тесты не должны попадать в
  // один счёт с этим.
  const ip = '198.51.100.7';
  const limit = 5;
  const start = 1_700_000_000_000;

  for (let i = 0; i < limit; i += 1) {
    assert.equal(searchLimited(ip, limit, start + i), false, `запрос ${i + 1} проходит`);
  }
  assert.equal(searchLimited(ip, limit, start + limit), true, 'следующий запрос упирается в лимит');

  // Окно истекло — адрес снова проходит.
  assert.equal(searchLimited(ip, limit, start + 61_000), false);
});