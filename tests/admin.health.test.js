// Здоровье системы (F-09-06, S-82).
//
// Проверяются три вещи, которые нельзя увидеть на живой базе без ожидания:
// «нет данных» не превращается в ноль, проблемные строки идут первыми, а
// сборщик запросов считает p95 по маршруту, а не по всему серверу.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRequestMetrics } from '../src/services/admin/metrics.js';
import { createTaskRegistry } from '../src/services/admin/tasks.js';
import { classifyHealth, pgSystemHealth } from '../src/services/admin/health.js';
import { adminHealthView } from '../src/view/adminHealth.js';

const HOUR = 3_600_000;

test('без запросов отклик — «нет данных», а не ноль', () => {
  const metrics = createRequestMetrics({ now: () => 10 * HOUR });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.response.p95, null);
  assert.equal(snapshot.errors.count, 0, 'ошибок за час действительно ноль');
  assert.equal(snapshot.response.series.length, 24);
  metrics.stop();
});

test('5xx и p95 считаются по маршруту', () => {
  const metrics = createRequestMetrics({ now: () => 10 * HOUR });
  metrics.record({ route: '/ru/series/:slug', status: 200, ms: 100, at: 10 * HOUR });
  metrics.record({ route: '/ru/series/:slug', status: 200, ms: 200, at: 10 * HOUR });
  metrics.record({ route: '/ru/series/:slug', status: 500, ms: 900, at: 10 * HOUR });
  metrics.record({ route: '/ru/admin', status: 200, ms: 50, at: 10 * HOUR });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.errors.count, 1);
  const route = snapshot.response.routes.find((item) => item.route === '/ru/series/:slug');
  assert.equal(route.count, 3);
  assert.ok(route.p95 >= 200 && route.p95 <= 900, `p95 маршрута: ${route.p95}`);
  assert.ok(snapshot.response.p95 >= 200, 'общий p95 не теряет медленный запрос');
  metrics.stop();
});

test('карта маршрутов не растёт от случайных адресов', () => {
  const metrics = createRequestMetrics({ now: () => 10 * HOUR });
  for (let index = 0; index < 60; index += 1) {
    metrics.record({ route: `/ru/random/${index}`, status: 404, ms: 5, at: 10 * HOUR });
  }
  const snapshot = metrics.snapshot();
  assert.ok(snapshot.response.routes.length <= 51, 'потолок маршрутов соблюдён');
  assert.ok(snapshot.response.routes.some((row) => row.route === 'other'));
  metrics.stop();
});

test('старые часы остаются в ряду, а не исчезают', () => {
  const metrics = createRequestMetrics({ now: () => 10 * HOUR });
  metrics.record({ route: '/ru/admin', status: 500, ms: 10, at: 8 * HOUR });
  const snapshot = metrics.snapshot();
  const old = snapshot.errors.series.find((point) => point.hour.getTime() === 8 * HOUR);
  assert.equal(old.count, 1);
  assert.equal(snapshot.errors.count, 0, 'за текущий час ошибок нет');
  metrics.stop();
});

test('реестр задач различает «не запускалась», успех и ошибку', async () => {
  let now = 1_000;
  const registry = createTaskRegistry({ now: () => now });
  const good = registry.wrap('banners', async () => 'ok');
  const bad = registry.wrap('backup', async () => { throw new Error('диск'); });

  assert.equal(registry.list().find((item) => item.name === 'backup').state, 'unknown');

  now = 2_000;
  await good();
  await assert.rejects(bad(), /диск/);
  const backup = registry.list().find((item) => item.name === 'backup');
  assert.equal(backup.state, 'error');
  assert.match(backup.lastError, /диск/);
  assert.equal(backup.lastRunAt.getTime(), 2_000);
});

test('проблема идёт первой, а недоступная метрика — не ноль', () => {
  const data = {
    online: { now: 3, average: 2.5, peak: 8, dataPoints: 4 },
    errors: { count: 0, series: [] },
    response: { p95: null, routes: [], series: [] },
    eventLoop: { delayMs: null },
    moderation: {
      waiting: 4, oldestMinutes: 48, growing: true, cautious: true, share: 0.4, threshold: 0.2,
    },
    tasks: { items: [], failed: 0, unknown: 0 },
    disk: { freePercent: 41, freeBytes: 41, totalBytes: 100 },
    backup: { last: null, verifiedAgeHours: null },
  };

  const metrics = classifyHealth(data);
  assert.equal(metrics[0].key, 'moderation', 'сломанное первым');
  assert.equal(metrics[0].severity, 'problem');
  assert.equal(metrics.find((item) => item.key === 'response').severity, 'unknown');
  assert.equal(metrics.find((item) => item.key === 'response').state, 'noData');
});

test('снимок собирает метрики, очередь и копию, не теряя «нет данных»', async () => {
  const now = new Date('2026-10-26T12:00:00Z');
  const pool = /** @type {any} */ ({
    query: async (sql) => {
      if (sql.includes('pg_database_size')) return { rows: [{ size: '123456' }] };
      if (sql.includes('e_backup_job')) return { rows: [{ n: 0 }] };
      if (sql.includes('e_material')) return { rows: [{ waiting: 2 }] };
      if (sql.includes('e_online_sample')) {
        return { rows: [{ hour: now, registered: 3, guests: 1 }] };
      }
      throw new Error(`неожиданный запрос: ${sql}`);
    },
  });
  const metrics = {
    snapshot: () => ({
      errors: { count: 2, series: [] },
      response: { p95: 140, routes: [{ route: '/ru/series/:slug', count: 3, p95: 140 }], series: [] },
      eventLoop: { delayMs: 12 },
    }),
  };
  const tasks = { snapshot: () => ({ items: [{ name: 'banners', state: 'ok' }], failed: 0, unknown: 0 }) };
  const budget = {
    cautiousState: async () => ({ cautious: true }),
    queuePressure: async () => ({ waiting: 2, oldestMinutes: 48, growing: true }),
  };
  const backups = {
    recent: async () => [{
      status: 'verified', verified_at: new Date(now.getTime() - 49 * HOUR),
    }],
  };

  const health = pgSystemHealth(pool, {
    metrics, tasks, budget, backups, now: () => now, diskPath: '/',
  });
  const data = await health.screen();

  assert.equal(data.online.now, 3);
  assert.equal(data.errors.count, 2);
  assert.equal(data.response.p95, 140);
  assert.equal(data.moderation.cautious, true);
  assert.equal(data.backup.verifiedAgeHours, 49);
  assert.equal(data.metrics[0].key, 'moderation');
  assert.equal(data.metrics.find((item) => item.key === 'backup').severity, 'problem');
});

test('старый бэкап — проблема с текстом, а не только цвет', () => {
  const data = {
    online: { now: 0, average: 0, peak: 0, dataPoints: 0 },
    errors: { count: 0, series: [] },
    response: { p95: 120, routes: [], series: [] },
    eventLoop: { delayMs: 12 },
    moderation: { waiting: 0, oldestMinutes: 0, growing: false, cautious: false },
    tasks: { items: [], failed: 0, unknown: 0 },
    disk: { freePercent: 41, freeBytes: 41, totalBytes: 100 },
    backup: { last: { status: 'verified' }, verifiedAgeHours: 50 },
  };
  const backup = classifyHealth(data).find((item) => item.key === 'backup');
  assert.equal(backup.severity, 'problem');
  assert.equal(backup.textKey, 'admin.health.text.backup.stale');
});

// #231: ветка «в норме» обязана заполнить textParams, как slow и warning:
// вид подставляет textParams в строку, а она читает {ms} — иначе экран печатает
// сырую скобку в штатном, самом частом состоянии отклика.
test('отклик в норме — текст с числом, а не сырой {ms}', () => {
  const data = {
    online: { now: 0, average: 0, peak: 0, dataPoints: 0 },
    errors: { count: 0, series: [] },
    response: { p95: 120, routes: [], series: [] },
    eventLoop: { delayMs: 12 },
    moderation: { waiting: 0, oldestMinutes: 0, growing: false, cautious: false },
    tasks: { items: [], failed: 0, unknown: 0 },
    disk: { freePercent: 41, freeBytes: 41, totalBytes: 100 },
    backup: { last: { status: 'verified' }, verifiedAgeHours: 1 },
  };
  const response = classifyHealth(data).find((item) => item.key === 'response');
  assert.equal(response.severity, 'ok');
  assert.equal(response.textKey, 'admin.health.text.response.ok');
  assert.deepEqual(response.textParams, { ms: 120 });
});

test('экран показывает последний результат задач, а не только счётчик', () => {
  const data = {
    metrics: [],
    tasks: {
      items: [
        { name: 'banners', state: 'ok', lastRunAt: new Date('2026-10-26T09:30:00Z'), durationMs: 120, lastError: null },
        { name: 'backup', state: 'error', lastRunAt: new Date('2026-10-26T09:40:00Z'), durationMs: 250, lastError: 'диск переполнен' },
      ],
      failed: 1,
      unknown: 0,
    },
    errors: { count: null, series: [] },
    response: { p95: null, routes: [], series: [] },
    eventLoop: { delayMs: null },
    moderation: { waiting: 0, oldestMinutes: 0, growing: false, cautious: false },
    disk: { freePercent: 41 },
    backup: { last: null, verifiedAgeHours: null },
    online: { points: [], now: 0, average: 0, peak: 0, dataPoints: 0 },
  };
  const html = adminHealthView({ locale: 'ru', data, csrf: 'token' }).__raw;
  assert.match(html, /Баннеры/, 'имя задачи переведено');
  assert.match(html, /Резервные копии/, 'вторая задача видна');
  assert.match(html, /диск переполнен/, 'текст ошибки не потерян');
  assert.match(html, /admin-health__task-error/);
});

test('экран показывает ссылку на очередь и кнопку проверки копии', () => {
  const data = {
    metrics: [
      {
        key: 'moderation', severity: 'problem', state: 'growing',
        textKey: 'admin.health.text.moderation.growing', textParams: { minutes: 48 },
        value: 4, unit: 'count', link: '/mod',
      },
      {
        key: 'backup', severity: 'warning', state: 'due',
        textKey: 'admin.health.text.backup.due', value: null, unit: 'text', link: '/admin/backups',
      },
    ],
    errors: { count: 2, series: [] },
    response: { p95: 140, routes: [], series: [] },
    eventLoop: { delayMs: 12 },
    moderation: { waiting: 4, oldestMinutes: 48, growing: true, cautious: true },
    tasks: { items: [], failed: 0, unknown: 0 },
    disk: { freePercent: 41 },
    backup: { last: null, verifiedAgeHours: null },
  };
  const html = adminHealthView({ locale: 'ru', data, csrf: 'token' }).__raw;
  assert.match(html, /\/ru\/mod/, 'ссылка на S-50');
  assert.match(html, /Очередь растёт/, 'текст состояния, а не только цвет');
  assert.match(html, /admin\/backups\/verify/, 'кнопка проверки восстановления');
  assert.match(html, /name="csrf" value="token"/);
  assert.match(html, /tabindex="-1" data-health-focus/, 'фокус на первой проблеме');
});
