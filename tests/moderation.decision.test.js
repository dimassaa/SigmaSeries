// Решение редактора по материалу (F-05-04).
//
// Проверяется то, что после решения остаётся в системе: состояние материала,
// запись в журнале решений, уведомление автору, белое слово — и то, что
// решение без причины не принимается.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';
import { pgModerationDecisions } from '../src/services/moderation/decision.js';
import { MODERATION } from '../src/config/settings.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — решения редактора не проверялись';

let pool;
let decisions;
const series = [];
const words = [];

async function viewer() {
  const { hash } = makeToken();
  const nickname = `decision-${crypto.randomUUID().slice(0, 8)}`;
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
     VALUES ($1, 'Решение фикстуры', 'Decision fixture', $2, 'published', 'airing', 2024) RETURNING id`,
    [`decision-${crypto.randomUUID().slice(0, 8)}`, 968_000_000 + Math.floor(Math.random() * 900)],
  );
  series.push(row.id);
  return row.id;
}

/** Материал в очереди. */
async function material({ authorId, seriesId, state = 'flagged' }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO e_material (author_id, kind, series_id, body, state)
     VALUES ($1, 'review', $2, 'Материал на разбор, с причиной и решением', $3) RETURNING id`,
    [authorId, seriesId, state],
  );
  return Number(row.id);
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  decisions = pgModerationDecisions(pool);
});

test.after(async () => {
  if (!pool) return;
  const ids = `SELECT id FROM e_series WHERE id = ANY($1::bigint[])`;
  await pool.query(`DELETE FROM e_editor_decision WHERE material_id IN (SELECT id FROM e_material WHERE series_id IN (${ids}))`, [series]);
  await pool.query(`DELETE FROM e_notification WHERE kind = 'material_decision' AND params->>'materialId' IN (
    SELECT id::text FROM e_material WHERE series_id IN (${ids}))`, [series]);
  // Кластеры убираются до материалов: их сигнатуры ищутся по материалам, а
  // решение по кластеру доживает до новых материалов и без них.
  await pool.query(`DELETE FROM e_moderation_cluster WHERE signature IN (
    SELECT signature FROM e_material WHERE series_id IN (${ids}) GROUP BY signature)`, [series]);
  await pool.query(`DELETE FROM e_material WHERE series_id IN (${ids})`, [series]);
  await pool.query('DELETE FROM e_series WHERE id = ANY($1::bigint[])', [series]);
  await pool.query('DELETE FROM e_dictionary_word WHERE word = ANY($1::text[])', [words]);
  await pool.end();
});

test('одобрение публикует материал, запись и уведомление остаются (F-05-04 §4, §18)', { skip }, async () => {
  const seriesId = await seriesWith();
  const author = await viewer();
  const editor = await viewer();
  const id = await material({ authorId: author, seriesId });

  const result = await decisions.decide({
    materialId: id,
    decision: 'approve',
    editorId: editor,
    reason: 'слово не то, что мы думали',
    matchedWord: 'не-подозрительное',
  });
  assert.equal(result.ok, true);

  const { rows: [row] } = await pool.query('SELECT state FROM e_material WHERE id = $1', [id]);
  assert.equal(row.state, 'approved', 'материал опубликован');

  const { rows: [decision] } = await pool.query(
    'SELECT editor_id, decision, reason FROM e_editor_decision WHERE material_id = $1', [id],
  );
  assert.equal(decision.decision, 'approved', 'в журнале — состояние материала');
  assert.equal(decision.reason, 'слово не то, что мы думали', 'причина сохранена');
  assert.equal(Number(decision.editor_id), editor);

  const { rows: [notice] } = await pool.query(
    `SELECT user_id, kind, params FROM e_notification
      WHERE kind = 'material_decision' AND params->>'materialId' = $1`, [String(id)],
  );
  assert.ok(notice, 'автору пришло уведомление');
  assert.equal(Number(notice.user_id), author);
  assert.equal(notice.params.reason, 'слово не то, что мы думали', 'автору ушла причина');
});

test('запрет оставляет материал отклонённым', { skip }, async () => {
  const seriesId = await seriesWith();
  const author = await viewer();
  const editor = await viewer();
  const id = await material({ authorId: author, seriesId });

  const result = await decisions.decide({
    materialId: id, decision: 'reject', editorId: editor, reason: 'запрещённый список',
  });
  assert.equal(result.ok, true);

  const { rows: [row] } = await pool.query('SELECT state FROM e_material WHERE id = $1', [id]);
  assert.equal(row.state, 'rejected');
});

test('решение без причины не принимается (F-05-04 §8а)', { skip }, async () => {
  const seriesId = await seriesWith();
  const author = await viewer();
  const editor = await viewer();
  const id = await material({ authorId: author, seriesId });

  const result = await decisions.decide({
    materialId: id, decision: 'approve', editorId: editor, reason: '   ',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'reason');

  const { rows: [row] } = await pool.query('SELECT state FROM e_material WHERE id = $1', [id]);
  assert.equal(row.state, 'flagged', 'материал остался в очереди');
});

test('неизвестное решение и несуществующий материал отвергаются', { skip }, async () => {
  const seriesId = await seriesWith();
  const author = await viewer();
  const editor = await viewer();
  const id = await material({ authorId: author, seriesId });

  const unknown = await decisions.decide({
    materialId: id, decision: 'maybe', editorId: editor, reason: 'что-то',
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'decision');

  const missing = await decisions.decide({
    materialId: 987_654_321, decision: 'approve', editorId: editor, reason: 'что-то',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing');
});

test('удалённый автором материал не разбирается и не ломает разбор (F-05-04 §5)', { skip }, async () => {
  const seriesId = await seriesWith();
  const author = await viewer();
  const editor = await viewer();
  const id = await material({ authorId: author, seriesId, state: 'deleted' });

  const result = await decisions.decide({
    materialId: id, decision: 'approve', editorId: editor, reason: 'разбор не нужен',
  });
  assert.equal(result.ok, true, 'удалённый материал — не ошибка');
  assert.equal(result.skipped, 'deleted');
});

test('белое слово добавляется вместе с решением (F-05-04 §18)', { skip }, async () => {
  const seriesId = await seriesWith();
  const author = await viewer();
  const editor = await viewer();
  const id = await material({ authorId: author, seriesId });
  const word = `белый-${crypto.randomUUID().slice(0, 8)}`;
  words.push(word);

  const result = await decisions.decide({
    materialId: id,
    decision: 'approve',
    editorId: editor,
    reason: 'слово употребляется в нормальном смысле',
    matchedWord: word,
    whitelist: true,
  });
  assert.equal(result.ok, true);

  const { rows } = await pool.query(
    'SELECT list, active FROM e_dictionary_word WHERE word = $1', [word],
  );
  assert.equal(rows.length, 1, 'слово добавлено в словарь');
  assert.equal(rows[0].list, 'allow', 'слово в белом списке');
});

test('история автора видна редактору (F-05-04 §4)', { skip }, async () => {
  const seriesId = await seriesWith();
  const author = await viewer();
  const editor = await viewer();
  const first = await material({ authorId: author, seriesId });
  const second = await material({ authorId: author, seriesId: await seriesWith() });

  await decisions.decide({
    materialId: first, decision: 'reject', editorId: editor, reason: 'запрещённый список',
  });
  await decisions.decide({
    materialId: second, decision: 'approve', editorId: editor, reason: 'всё в порядке',
  });

  const history = await decisions.authorHistory(author);
  // Решений не меньше двух: запрещённое и одобренное. Третьим может прийти
  // решение, дошедшее по кластеру, — решение редактора распространяется на
  // материалы с той же сигнатурой (подтверждено автором 21.10).
  assert.ok(history.length >= 2, `решения в истории: ${history.length}`);
  assert.ok(history.every((row) => row.reason), 'у каждого решения есть причина');
});
