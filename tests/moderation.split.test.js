// Разделение кластера (F-05-03 §5).
//
// Кластер — способ разбора, а не приговор: решение по группе касается всей
// группы, а если группа собрана ошибочно, редактор решает по выбранным
// материалам, и решение применяется только к ним.

import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgModerationDecisions } from '../src/services/moderation/decision.js';
import { pgModerationClusters } from '../src/services/moderation/cluster.js';
import { acquireImportLock } from './helpers/import-lock.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — разделение кластера не проверялось';

let pool;
/** Отпускается в `after`: держит общую блокировку строк запуска. */
let unlockImport;
let decisions;
let clusters;
let series;
/** @type {any} */
const materials = [];

test.before(async () => {
  if (!available) return;
  pool = createPool();
  unlockImport = await acquireImportLock(pool);
  decisions = pgModerationDecisions(pool);
  clusters = pgModerationClusters(pool);
  // Слаг уникален: проверка может остаться после обрыва прогона.
  const slug = `test-cluster-split-${crypto.randomUUID().slice(0, 8)}`;
  // Два сериала: на один автор и сериал отзыва один, а в кластере нужны два
  // материала с одинаковым текстом.
  const { rows } = await pool.query(
    `INSERT INTO e_series (slug, title_original, level, reasons, imdb_key)
     VALUES ($1, 'Cluster Split', 'full', '{}', $2),
            ($3, 'Cluster Split 2', 'full', '{}', $4)
     RETURNING id`,
    [slug, `tt${Date.now()}1`, `${slug}-2`, `tt${Date.now()}2`],
  );
  series = rows.map((row) => Number(row.id));
});

test.after(async () => {
  if (!pool) return;
  const ids = `SELECT id FROM e_series WHERE id = ANY($1::bigint[])`;
  await pool.query(`DELETE FROM e_editor_decision WHERE material_id IN (SELECT id FROM e_material WHERE series_id IN (${ids}))`, [series]);
  await pool.query(`DELETE FROM e_notification WHERE kind = 'material_decision' AND params->>'materialId' IN (
    SELECT id::text FROM e_material WHERE series_id IN (${ids}))`, [series]);
  await pool.query(`DELETE FROM e_moderation_cluster WHERE signature IN (
    SELECT signature FROM e_material WHERE series_id IN (${ids}) GROUP BY signature)`, [series]);
  await pool.query(`DELETE FROM e_material WHERE series_id IN (${ids})`, [series]);
  await pool.query('DELETE FROM e_series WHERE id = ANY($1::bigint[])', [series]);
  await unlockImport?.();
  await pool.end();
});

/** Материал в очереди: помеченный и ждущий решения. */
async function queued(body, seriesId, authorId = materials.authorId) {
  const { rows } = await pool.query(
    `INSERT INTO e_material (author_id, kind, series_id, body, state, submitted_at)
     VALUES ($1, 'review', $2, $3, 'flagged', now()) RETURNING id`,
    [authorId, seriesId, body],
  );
  materials.push(rows[0].id);
  return rows[0].id;
}

test.before(async () => {
  if (!available) return;
  // Редактор: решения пишутся от его имени, и их темп считается по нему.
  const { rows } = await pool.query(
    `SELECT u.id FROM e_user u
      WHERE NOT EXISTS (SELECT 1 FROM e_role_assignment r WHERE r.user_id = u.id)
      ORDER BY u.id LIMIT 2`,
  );
  assert.ok(rows.length === 2, 'есть два пользователя без ролей');
  materials.editorId = rows[0].id;
  materials.authorId = rows[1].id;
  materials.authorId2 = rows[0].id;

});

test('разделение решает по выбранным, остальные остаются в очереди', { skip }, async () => {
  const body = `Одинаковый текст для разделения ${Date.now()}`;
  const first = await queued(body, series[0]);
  const second = await queued(body, series[1], materials.authorId2);

  const result = await decisions.split({
    materialIds: [first],
    decision: 'reject',
    editorId: materials.editorId,
    reason: 'похоже, но не то же самое',
  });
  assert.equal(result.ok, true);
  assert.equal(result.decided, 1, 'решение принято по одному материалу');

  const { rows } = await pool.query(
    'SELECT id, state FROM e_material WHERE id = ANY($1::bigint[]) ORDER BY id', [[first, second]],
  );
  const states = new Map(rows.map((row) => [Number(row.id), row.state]));
  assert.equal(states.get(first), 'rejected', 'выбранный материал запрещён');
  assert.equal(states.get(second), 'flagged', 'невыбранный остался в очереди');
});

test('разделённый кластер не запрещает сигнатуру для новых материалов', { skip }, async () => {
  const body = `Одинаковый текст без кластерной подписи ${Date.now()}`;
  const first = await queued(body, series[1]);
  await decisions.split({
    materialIds: [first],
    decision: 'reject',
    editorId: materials.editorId,
    reason: 'разделено',
  });

  // Кластерной подписи нет — решение не должно достать до новых материалов.
  const { rows } = await pool.query(
    'SELECT decision FROM e_moderation_cluster WHERE signature = $1',
    [crypto.createHash('sha256').update(body).digest('hex')],
  );
  assert.ok(!rows.length || rows[0].decision !== 'rejected',
    'сигнатура не помечена запрещённой');
});
