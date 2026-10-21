// Приём событий аналитики (M8, F-08-01).
//
// Проверяется правило «невалидное отбрасывается и считается»: неизвестное
// имя, чужое свойство, персональные данные и неверный токен не оставляют
// следа в таблице событий, но попадают в счётчик отказов.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgAnalytics } from '../src/services/analytics/events.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — приём событий не проверялся';

let pool;
let analytics;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  analytics = pgAnalytics(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_event WHERE event_id = ANY($1::uuid[])', [ids]);
  await pool.query('DELETE FROM e_event_reject');
  await pool.end();
});

const ids = [];

function event(name, props = {}, extra = {}) {
  const id = crypto.randomUUID();
  ids.push(id);
  return { name, event_id: id, ts_client: new Date().toISOString(), props, ...extra };
}

test('событие из таксономии принимается и попадает в базу', { skip }, async () => {
  const token = analytics.issueToken();
  const result = await analytics.intake({
    events: [event('page_view', { page_type: 'home' })],
    token,
    expectedToken: token,
    context: { anonId: 'anon_test', userPseudoId: 'pseudo_test', locale: 'ru' },
  });

  assert.equal(result.accepted, 1);
  assert.equal(result.rejected, 0);

  const { rows } = await pool.query(
    'SELECT name, anon_id, user_pseudo_id, props FROM e_event WHERE event_id = $1',
    [ids[ids.length - 1]],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'page_view');
  assert.equal(rows[0].anon_id, 'anon_test');
  assert.equal(rows[0].props.page_type, 'home');
});

test('неизвестное имя события отбрасывается и считается', { skip }, async () => {
  const token = analytics.issueToken();
  const result = await analytics.intake({
    events: [event('что_то_новое', {})],
    token,
    expectedToken: token,
    context: {},
  });

  assert.equal(result.accepted, 0);
  assert.equal(result.rejected, 1);

  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM e_event_reject WHERE reason = 'unknown_name'",
  );
  assert.ok(rows[0].n > 0, 'отказ посчитан');
});

test('свойство не из белого списка отбрасывает событие целиком', { skip }, async () => {
  const token = analytics.issueToken();
  const result = await analytics.intake({
    events: [event('page_view', { page_type: 'home', text: 'тайна' })],
    token,
    expectedToken: token,
    context: {},
  });

  assert.equal(result.accepted, 0, 'событие отброшено, а не очищено');
  assert.equal(result.reasons.props, 1);
});

test('персональные данные отбрасывают событие целиком', { skip }, async () => {
  const token = analytics.issueToken();
  const result = await analytics.intake({
    events: [event('series_view', { source: 'someone@example.com' })],
    token,
    expectedToken: token,
    context: {},
  });

  assert.equal(result.accepted, 0);
  assert.equal(result.reasons.pii, 1);
});

test('событие больше предела размера отбрасывается', { skip }, async () => {
  const token = analytics.issueToken();
  const result = await analytics.intake({
    events: [event('page_view', { page_type: 'x'.repeat(5000) })],
    token,
    expectedToken: token,
    context: {},
  });

  assert.equal(result.accepted, 0);
  assert.equal(result.reasons.size, 1);
});

test('без верного одноразового токена пачка не принимается', { skip }, async () => {
  const token = analytics.issueToken();
  const result = await analytics.intake({
    events: [event('page_view', { page_type: 'home' })],
    token: 'чужой',
    expectedToken: token,
    context: {},
  });

  assert.equal(result.accepted, 0);
  assert.equal(result.reasons.token, 1);
});

test('повтор с тем же event_id не двоит событие', { skip }, async () => {
  const token = analytics.issueToken();
  const one = event('page_view', { page_type: 'home' });
  await analytics.intake({ events: [one], token, expectedToken: token, context: {} });
  const again = await analytics.intake({
    events: [one],
    token: analytics.issueToken(),
    expectedToken: analytics.issueToken(),
    context: {},
  });

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM e_event WHERE event_id = $1', [one.event_id]);
  assert.equal(rows[0].n, 1, 'событие осталось одно');
  assert.ok(again.accepted <= 1);
});
