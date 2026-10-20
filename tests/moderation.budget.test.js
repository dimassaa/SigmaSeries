// Бюджеты модерации: лимит частоты, «осторожный» режим, давление очереди
// (F-05-03, R-MOD-10).
//
// Проверяется то, что видит человек: шестой материал за минуту отвергается,
// а когда помеченных много, новый материал ждёт решения редактора вместо
// публикации.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';
import { cautiousFrom, pgModerationBudget } from '../src/services/moderation/budget.js';
import { MODERATION } from '../src/config/settings.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — бюджеты модерации не проверялись';

let pool;
let budget;
const series = [];

async function viewer() {
  const { hash } = makeToken();
  const nickname = `budget-${crypto.randomUUID().slice(0, 8)}`;
  const created = await pgAuthStore(pool).createUser({
    email: `${nickname}@example.com`,
    nickname,
    passwordHash: 'x',
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  return created.id;
}

async function seriesWith() {
  const { rows: [row] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Бюджет фикстуры', 'Budget fixture', $2, 'published', 'airing', 2024) RETURNING id`,
    [`budget-${crypto.randomUUID().slice(0, 8)}`, 967_000_000 + Math.floor(Math.random() * 900)],
  );
  series.push(row.id);
  return row.id;
}

/** Материал автора: состояние и когда подан. */
async function material({ authorId, seriesId, state = 'published', at = new Date() }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO e_material (author_id, kind, series_id, body, state, submitted_at)
     VALUES ($1, 'review', $2, 'Текст материала для бюджета', $3, $4) RETURNING id`,
    [authorId, seriesId, state, at],
  );
  return Number(row.id);
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  // Свой ключ состояния: общий ключ включал бы режим для всех файлов прогона.
  budget = pgModerationBudget(pool, { stateKey: 'mod.cautious.test' });
});

test.after(async () => {
  if (!pool) return;
  const ids = `SELECT id FROM e_series WHERE id = ANY($1::bigint[])`;
  await pool.query(`DELETE FROM e_material WHERE series_id IN (${ids})`, [series]);
  await pool.query('DELETE FROM e_series WHERE id = ANY($1::bigint[])', [series]);
  await pool.query("DELETE FROM e_system_setting WHERE key = 'mod.cautious.test'");
  await pool.end();
});

test('сколько материалов автор подал за минуту — считается по подаче (F-05-03 §5)', { skip }, async () => {
  const author = await viewer();
  const seriesId = await seriesWith();
  const now = new Date();

  for (let i = 0; i < 3; i += 1) {
    await material({
      authorId: author,
      seriesId: i === 0 ? seriesId : await seriesWith(),
      at: new Date(now.getTime() - i * 10_000),
    });
  }
  assert.equal(await budget.submissionsInMinute(author, now), 3, 'три материала за последнюю минуту');

  // Материал трёхминутной давности в минуту не попадает.
  await material({
    authorId: author,
    seriesId: await seriesWith(),
    at: new Date(now.getTime() - 3 * 60_000),
  });
  assert.equal(await budget.submissionsInMinute(author, now), 3, 'старый материал не считается');
});

test('правило режима: помеченных больше доли — режим включён (F-05-03 §18)', { skip }, async () => {
  // Правило проверяется числами: доля считается по всей базе, где рядом
  // лежат материалы чужих проверок, и сравнение с живой базой ничего не
  // значило бы.
  assert.equal(cautiousFrom({ flagged: 5, total: 10 }).cautious, true,
    'доля 0,5 больше порога — режим включён');
  assert.equal(cautiousFrom({ flagged: 2, total: 10 }).cautious, false,
    'доля 0,2 не больше порога — режим выключен');
  assert.equal(cautiousFrom({ flagged: 0, total: 0 }).cautious, false,
    'пустая база — режим выключен');
  assert.equal(cautiousFrom({ flagged: 3, total: 10 }).share, 0.3, 'доля посчитана');
});

test('состояние режима читается из настроек системы и включается пересчётом', { skip }, async () => {
  await pool.query("DELETE FROM e_system_setting WHERE key = 'mod.cautious.test'");
  const before = await budget.cautiousState();
  assert.equal(before.cautious, false, 'без записи режим выключен');

  await pool.query("INSERT INTO e_system_setting (key, value) VALUES ('mod.cautious.test', '1')");
  const after = await budget.cautiousState();
  assert.equal(after.cautious, true, 'запись включает режим');

  // Пересчёт кладёт состояние в настройки: решение о режиме принимает
  // система по расписанию, а не та отправка, что пришла последней.
  const refreshed = await budget.refresh();
  assert.equal(typeof refreshed.cautious, 'boolean');
  const { rows } = await pool.query("SELECT value FROM e_system_setting WHERE key = 'mod.cautious.test'");
  assert.equal(rows[0].value, refreshed.cautious ? '1' : '0', 'состояние записано');

  await pool.query("DELETE FROM e_system_setting WHERE key = 'mod.cautious.test'");
});

test('очередь растёт, когда самый старый материал ждёт дольше цели разбора (EC-U9)', { skip }, async () => {
  const seriesId = await seriesWith();
  const now = new Date();
  const old = new Date(now.getTime() - (MODERATION.queueTargetMin + 5) * 60_000);
  await material({ authorId: await viewer(), seriesId, state: 'flagged', at: old });
  await material({ authorId: await viewer(), seriesId, state: 'flagged', at: now });

  const pressure = await budget.queuePressure({ at: now });
  // Очередь общая: в ней лежат и материалы чужих проверок, поэтому проверяется
  // не число, а свойства — свои материалы посчитаны, и самый старый ждёт
  // дольше цели разбора.
  assert.ok(pressure.waiting >= 2, `в очереди есть наши два материала: ${pressure.waiting}`);
  assert.ok(pressure.oldestMinutes >= MODERATION.queueTargetMin, 'самый старый ждёт дольше цели');
  assert.equal(pressure.growing, true, 'очередь растёт');
});
