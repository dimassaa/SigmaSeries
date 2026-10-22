// Метрики и словарь (M8, F-08-02, F-08-03).
//
// Проверяется главное правило словаря: у каждой метрики есть определение,
// формула, пример с числами, известные искажения и версия — иначе «128
// пользователей» значит четыре разные вещи у четырёх людей.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgAnalyticsMetrics, METRICS, metricOf } from '../src/services/analytics/metrics.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — метрики не проверялись';

let pool;
let metrics;
const ids = [];

test.before(async () => {
  if (!available) return;
  pool = createPool();
  metrics = pgAnalyticsMetrics(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_event WHERE event_id = ANY($1::uuid[])', [ids]);
  await pool.end();
});

/** Кладёт событие в таблицу — как это делает приёмник. */
async function put(name, props, { pseudo = 'pseudo_test', hoursAgo = 1, demo = false } = {}) {
  const id = crypto.randomUUID();
  ids.push(id);
  await pool.query(
    `INSERT INTO e_event (event_id, name, ts_client, ts_server, anon_id, user_pseudo_id, props, is_demo)
     VALUES ($1, $2, now(), now() - ($3 || ' hours')::interval, 'anon_test', $4, $5, $6)`,
    [id, name, String(hoursAgo), pseudo, JSON.stringify(props), demo],
  );
}

test('у каждой метрики есть определение, формула, пример и искажения', () => {
  assert.ok(METRICS.length >= 10, 'метрик в словаре достаточно');
  for (const metric of METRICS) {
    assert.ok(metric.key, 'у метрики есть ключ');
    assert.ok(metric.titleRu && metric.titleEn, 'название переводимо');
    assert.ok(metric.definitionRu && metric.definitionEn, 'определение переводимо');
    assert.ok(metric.formula, 'формула обязательна');
    assert.ok(metric.source, 'источник указан');
    assert.ok(metric.exampleRu && metric.exampleEn, 'пример с числами есть');
    assert.ok(metric.distortionsRu.length && metric.distortionsEn.length,
      'известные искажения перечислены');
    assert.ok(metric.version, 'версия определения указана');
  }
});

test('метрика находится по ключу, чужая — нет', () => {
  assert.equal(metricOf('active_users')?.key, 'active_users');
  assert.equal(metricOf('такой_метрики_нет'), null);
});

test('обзор считает активных, регистрации и строит графики', { skip }, async () => {
  await put('page_view', { page_type: 'home' });
  await put('episode_mark', { precision: 'exact' });
  await put('episode_mark', { precision: 'exact' }, { pseudo: 'pseudo_two' });
  await put('signup_complete', { step: 'done' });

  const data = await metrics.overview({ hours: 23, excludeDemo: true });

  assert.equal(data.numbers.length, 5, 'крупных чисел не больше пяти');
  const active = data.numbers.find((item) => item.key === 'active_users');
  assert.ok(active.value >= 2, 'активные посчитаны по значимым событиям');
  const signups = data.numbers.find((item) => item.key === 'signups');
  assert.ok(signups.value >= 1, 'регистрации посчитаны');
  assert.equal(data.graphs.length, 2, 'два графика');
});

test('просмотр страницы активностью не считается', { skip }, async () => {
  const before = await metrics.overview({ hours: 22, excludeDemo: true });
  const activeBefore = before.numbers.find((item) => item.key === 'active_users').value;
  await put('page_view', { page_type: 'home' }, { pseudo: 'pseudo_three' });
  const after = await metrics.overview({ hours: 22, excludeDemo: true });
  const activeAfter = after.numbers.find((item) => item.key === 'active_users').value;
  assert.equal(activeAfter, activeBefore, 'просмотр страницы активность не увеличил');
});

test('демо-события исключаются, а доля демо видна', { skip }, async () => {
  await put('episode_mark', { precision: 'exact' }, { pseudo: 'pseudo_demo', demo: true });
  const data = await metrics.overview({ hours: 21, excludeDemo: true });
  assert.ok(data.demoShare > 0, 'доля демо посчитана');
  const withDemo = await metrics.overview({ hours: 21, excludeDemo: false });
  assert.ok(withDemo.numbers.find((item) => item.key === 'active_users').value
    >= data.numbers.find((item) => item.key === 'active_users').value,
  'с демо активных не меньше');
});

test('качество модерации читается из таблиц, где есть автор материала', { skip }, async () => {
  const data = await metrics.moderation({ hours: 168, excludeDemo: true });
  assert.equal(typeof data.flagged, 'number', 'помеченные материалы посчитаны');
  assert.equal(typeof data.decided, 'number', 'разобранные материалы посчитаны');
  assert.equal(typeof data.decisions, 'number', 'решения посчитаны');
  assert.equal(typeof data.falsePositive, 'number', 'доля ложных срабатываний посчитана');
});

test('воронка показывает отказы, а не только успехи', { skip }, async () => {
  await put('page_view', { page_type: 'home' });
  const steps = await metrics.funnel({ hours: 168, excludeDemo: true });
  assert.equal(steps.length, 4);
  assert.ok(steps[0].value >= steps[1].value, 'визитов не меньше регистраций');
});

test('отказы приёма видны на обзоре', { skip }, async () => {
  await pool.query(
    `INSERT INTO e_event_reject (name, reason, day, count) VALUES ('page_view', 'props', current_date, 3)
     ON CONFLICT (name, reason, day) DO UPDATE SET count = e_event_reject.count + 3`,
  );
  const rows = await metrics.rejects();
  assert.ok(rows.some((row) => row.reason === 'props'), 'отказ виден');
  await pool.query('DELETE FROM e_event_reject');
});
