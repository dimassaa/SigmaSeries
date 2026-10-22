// Кластеры одинаковых материалов (F-05-03, R-MOD-13).
//
// Проверяется то, ради чего кластеры и нужны: волна одинаковых материалов
// собирается в одну группу, редактор принимает по ней одно решение, и решение
// достаёт до материалов, пришедших позже.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';
import { pgModerationClusters, distanceOf, fingerprintOf, signatureOf } from '../src/services/moderation/cluster.js';
import { MODERATION } from '../src/config/settings.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — кластеры не проверялись';

let pool;
let clusters;
const series = [];

async function viewer() {
  const { hash } = makeToken();
  const nickname = `cluster-${crypto.randomUUID().slice(0, 8)}`;
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
     VALUES ($1, 'Кластер фикстуры', 'Cluster fixture', $2, 'published', 'airing', 2024) RETURNING id`,
    [`cluster-${crypto.randomUUID().slice(0, 8)}`, 966_000_000 + Math.floor(Math.random() * 900)],
  );
  series.push(row.id);
  return row.id;
}

/** Материал в очереди: помечен и ждёт решения. */
async function queued({ authorId, seriesId, body, state = 'flagged' }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO e_material (author_id, kind, series_id, body, state, submitted_at)
     VALUES ($1, 'review', $2, $3, $4, now()) RETURNING id`,
    [authorId, seriesId, body, state],
  );
  return Number(row.id);
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  clusters = pgModerationClusters(pool);
});

test.after(async () => {
  if (!pool) return;
  const ids = `SELECT id FROM e_series WHERE id = ANY($1::bigint[])`;
  await pool.query(`DELETE FROM e_editor_decision WHERE material_id IN (SELECT id FROM e_material WHERE series_id IN (${ids}))`, [series]);
  await pool.query(`DELETE FROM e_moderation_cluster WHERE signature IN (
    SELECT signature FROM e_material WHERE series_id IN (${ids}) GROUP BY signature)`, [series]);
  await pool.query(`DELETE FROM e_material WHERE series_id IN (${ids})`, [series]);
  await pool.query('DELETE FROM e_series WHERE id = ANY($1::bigint[])', [series]);
  await pool.end();
});

test('одинаковые тексты дают одинаковую сигнатуру, разные — разную', { skip }, async () => {
  const body = 'Один и тот же текст отзыва про сериал';
  assert.equal(signatureOf(body), signatureOf(`  ${body}  `), 'пробелы и регистр не важны');
  assert.notEqual(signatureOf(body), signatureOf(`${body} и ещё одно предложение`));
});

test('почти одинаковые тексты дают близкие отпечатки', { skip }, async () => {
  const a = fingerprintOf('Сериал держит в напряжении до последней серии');
  const b = fingerprintOf('До последней серии сериал держит в напряжении');
  assert.ok(distanceOf(a, b) <= MODERATION.clusterSimilarity,
    `расстояние ${distanceOf(a, b)} не больше порога ${MODERATION.clusterSimilarity}`);
  const far = fingerprintOf('Совершенно другой текст про другое совсем');
  assert.ok(distanceOf(a, far) > MODERATION.clusterSimilarity, 'разные тексты далеко');
});

test('волна одинаковых материалов собирается в один кластер (EC-U8, F-05-03 §18)', { skip }, async () => {
  const seriesId = await seriesWith();
  const authors = [];
  for (let i = 0; i < 12; i += 1) {
    const author = await viewer();
    authors.push(author);
    await queued({
      authorId: author,
      seriesId,
      body: 'Одинаковый текст, который прислали разные люди',
    });
  }

  const groups = await clusters.groups({
    windowHours: MODERATION.clusterWindowH,
    minSize: MODERATION.clusterMinSize,
  });
  const ours = groups.find((group) => group.size === 12);
  assert.ok(ours, `кластер из 12 материалов найден (всего групп: ${groups.length})`);
  assert.equal(ours.size, 12);
  assert.equal(ours.authors, 12, 'двенадцать разных авторов');
  assert.equal(ours.decided, null, 'решения по кластеру ещё нет');
});

test('один материал — не кластер: ниже порога группа не предлагается', { skip }, async () => {
  const seriesId = await seriesWith();
  await queued({ authorId: await viewer(), seriesId, body: 'Одиночный текст, который никто не повторил' });

  const groups = await clusters.groups({
    windowHours: MODERATION.clusterWindowH,
    minSize: MODERATION.clusterMinSize,
  });
  assert.equal(groups.some((group) => group.materials.some((m) => m.body.includes('Одиночный'))), false,
    'одиночный материал в кластер не попал');
});

test('очередь упорядочена: прождавшие, потом жалобы, потом свежие (F-05-03 §4(1), EC-U9)', { skip }, async () => {
  const seriesId = await seriesWith();
  const now = new Date();
  const fresh = await queued({ authorId: await viewer(), seriesId, body: 'Свежий материал без жалоб' });
  const complained = await queued({ authorId: await viewer(), seriesId, body: 'Материал с жалобами' });
  const stale = await queued({
    authorId: await viewer(),
    seriesId,
    body: 'Материал, пролежавший в очереди дольше суток',
  });
  await pool.query(
    `UPDATE e_material SET submitted_at = now() - interval '30 hours' WHERE id = $1`,
    [stale],
  );
  await pool.query(
    `INSERT INTO e_report (material_id, user_id, reason) VALUES ($1, $2, 'spam')`,
    [complained, await viewer()],
  );

  const queue = await clusters.ordered({ windowHours: MODERATION.clusterWindowH });
  const ids = queue.map((item) => item.id);
  assert.ok(ids.includes(stale) && ids.includes(complained) && ids.includes(fresh),
    'все три в очереди');
  assert.ok(ids.indexOf(stale) < ids.indexOf(complained),
    'прождавший поднят над жалобами');
  assert.ok(ids.indexOf(complained) < ids.indexOf(fresh),
    'с жалобами — выше свежего');

  const staleItem = queue.find((item) => item.id === stale);
  assert.equal(staleItem.raised, true, 'прождавший помечен поднятым');
  assert.ok(staleItem.waitingMinutes > MODERATION.clusterWindowH * 60, 'ждал дольше суток');
  const complainedItem = queue.find((item) => item.id === complained);
  assert.equal(complainedItem.complaints, 1, 'число жалоб посчитано');
});

test('решение по кластеру достаёт до всех материалов группы и до пришедших позже', { skip }, async () => {
  const seriesId = await seriesWith();
  const body = 'Один текст, на который решили кластером';
  const first = [];
  for (let i = 0; i < 4; i += 1) {
    const author = await viewer();
    first.push(await queued({ authorId: author, seriesId, body }));
  }
  const editor = await viewer();

  const groups = await clusters.groups({
    windowHours: MODERATION.clusterWindowH,
    minSize: MODERATION.clusterMinSize,
  });
  const group = groups.find((one) => one.materials.some((m) => m.body === body));
  assert.ok(group, 'кластер найден');

  // Решение принимается по сигнатуре этого текста, а не по `group.signature`:
  // группы объединяют и близкие отпечатки, и при параллельном прогоне первым
  // в группе может оказаться материал соседнего файла.
  const result = await clusters.decide({
    signature: signatureOf(body),
    decision: 'rejected',
    editorId: editor,
    reason: 'тест: кластер запрещён',
  });
  assert.equal(result.applied, 4, 'решение применено к четырём материалам группы');

  const { rows } = await pool.query(
    'SELECT state FROM e_material WHERE id = ANY($1::bigint[])',
    [first],
  );
  assert.deepEqual([...new Set(rows.map((row) => row.state))], ['rejected'],
    'все материалы группы получили решение');

  // Материал с той же сигнатурой, пришедший после решения.
  const late = await queued({ authorId: await viewer(), seriesId, body });
  const again = await clusters.decide({
    signature: group.signature,
    decision: 'rejected',
    editorId: editor,
    reason: 'тест: кластер запрещён',
  });
  // Уже решённые материалы из очереди ушли, поэтому в счётчике остаётся
  // только пришедший позже.
  assert.equal(again.applied, 1, 'решение достало и до пришедшего позже материала');
  const { rows: [lateRow] } = await pool.query('SELECT state FROM e_material WHERE id = $1', [late]);
  assert.equal(lateRow.state, 'rejected');
});

test('решение пишется в журнал решений редактора с указанием кластера', { skip }, async () => {
  const seriesId = await seriesWith();
  const body = 'Текст, решение по которому попадёт в журнал';
  for (let i = 0; i < 3; i += 1) {
    await queued({ authorId: await viewer(), seriesId, body });
  }
  const editor = await viewer();

  const groups = await clusters.groups({
    windowHours: MODERATION.clusterWindowH,
    minSize: MODERATION.clusterMinSize,
  });
  const group = groups.find((one) => one.materials.some((m) => m.body === body));
  await clusters.decide({ signature: group.signature, decision: 'approved', editorId: editor, reason: 'тест: пропущено' });

  const { rows } = await pool.query(
    `SELECT d.decision, d.reason, d.cluster_id FROM e_editor_decision d
      WHERE d.material_id IN (SELECT id FROM e_material WHERE series_id = $1)`,
    [seriesId],
  );
  assert.ok(rows.length >= 3, 'решения записаны по каждому материалу');
  assert.equal(rows[0].decision, 'approved');
  assert.equal(rows[0].reason, 'тест: пропущено');
  assert.ok(rows[0].cluster_id, 'указано, каким кластером решено');
});
