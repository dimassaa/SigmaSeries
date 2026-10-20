// Кластеры одинаковых материалов (R-MOD-13, F-05-03).
//
// Задача: волна запрещённого не должна завалить очередь, а редактор должен
// разбирать не материалы по одному, а группы. Материалы с одинаковым
// нормализованным текстом попадают в один кластер, и решение принимается
// один раз на всю группу.
//
// Два уровня совпадения (R-MOD-13):
//   · точное — хэш нормализованного текста: одинаковые тексты дают
//     одинаковую сигнатуру;
//   · близкое — отпечаток SimHash: почти одинаковые тексты (перестановки
//     слов, опечатки) дают отпечатки рядом, и расстояние между ними
//     сравнивается с порогом.
//
// Кластер — не наказание, а способ разбора (M5 §8г): решение всегда
// выносит редактор, автоматика только группирует.

import crypto from 'node:crypto';

import { normalize } from './check.js';
import { MODERATION } from '../settings.js';

/** Состояния материала, в которых он ждёт решения. */
export const QUEUE_STATES = ['flagged', 'checking'];

/** Порог близости SimHash: расстояние Хэмминга, при котором тексты считаются одним кластером. */
const CLOSE_DISTANCE = MODERATION.clusterSimilarity;

/** Длина отпечатка SimHash в битах. */
const FINGERPRINT_BITS = 64;

/**
 * Нормализованный текст материала.
 *
 * Нормализация та же, что при проверке словаря (R-MOD-02): иначе два
 * одинаковых текста, написанные по-разному, разошлись бы по разным
 * кластерам.
 *
 * @param {string} body
 * @returns {string}
 */
export function normalized(body) {
  return normalize(String(body ?? ''));
}

/**
 * Точная сигнатура материала: хэш нормализованного текста.
 *
 * @param {string} body
 * @returns {string}
 */
export function signatureOf(body) {
  return crypto.createHash('sha256').update(normalized(body), 'utf8').digest('hex');
}

/**
 * Отпечаток SimHash: 64 бита, рядом у похожих текстов.
 *
 * Признаки — слова текста, а не тройки подряд: переставленные слова дают
 * тот же набор признаков, и отпечаток совпадает, а у текста с опечаткой
 * отличается на несколько бит. Бит отпечатка ставится по большинству
 * голосов признаков.
 *
 * @param {string} body
 * @returns {string} 16 символов hex
 */
export function fingerprintOf(body) {
  const words = [...new Set(normalized(body).split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
  const bits = new Array(FINGERPRINT_BITS).fill(0);
  if (!words.length) return '0'.repeat(16);

  for (const word of words) {
    const digest = crypto.createHash('sha1').update(word, 'utf8').digest();
    for (let byte = 0; byte < 8; byte += 1) {
      for (let bit = 0; bit < 8; bit += 1) {
        const value = (digest[byte] >> (7 - bit)) & 1;
        const index = byte * 8 + bit;
        bits[index] += value === 1 ? 1 : -1;
      }
    }
  }

  let hex = '';
  for (let index = 0; index < FINGERPRINT_BITS; index += 4) {
    let nibble = 0;
    for (let shift = 0; shift < 4; shift += 1) {
      if (bits[index + shift] > 0) nibble |= 1 << (3 - shift);
    }
    hex += nibble.toString(16);
  }
  return hex;
}

/**
 * Расстояние между отпечатками: число различающихся битов.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function distanceOf(a, b) {
  let distance = 0;
  for (let index = 0; index < FINGERPRINT_BITS; index += 1) {
    const bitA = (parseInt(a[index >> 2], 16) >> (3 - (index & 3))) & 1;
    const bitB = (parseInt(b[index >> 2], 16) >> (3 - (index & 3))) & 1;
    if (bitA !== bitB) distance += 1;
  }
  return distance;
}

/**
 * Материалы в очереди, собранные в кластеры.
 *
 * @param {import('pg').Pool} pool
 * @returns {object}
 */
export function pgModerationClusters(pool) {
  /**
   * Материалы, ждущие решения, за окно.
   *
   * @param {{windowHours: number, states?: string[]}} input
   * @returns {Promise<Array<{id: number, authorId: number, seriesId: number|null,
   *   body: string, state: string, createdAt: Date, submittedAt: Date, signature: string, fingerprint: string}>>}
   */
  async function queued({ windowHours, states = QUEUE_STATES }) {
    const { rows } = await pool.query(
      `SELECT id, author_id, series_id, body, state, created_at, submitted_at
         FROM e_material
        WHERE state = ANY($1::text[])
          AND submitted_at >= now() - ($2 || ' hours')::interval
        ORDER BY submitted_at DESC`,
      [states, String(windowHours)],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      authorId: Number(row.author_id),
      seriesId: row.series_id === null ? null : Number(row.series_id),
      body: row.body,
      state: row.state,
      createdAt: row.created_at,
      submittedAt: row.submitted_at,
      signature: signatureOf(row.body),
      fingerprint: fingerprintOf(row.body),
    }));
  }

  /**
   * Очередь модерации в порядке разбора (F-05-03 §4(1)).
   *
   * Порядок такой:
   *   1. материалы, пролежавшие в очереди дольше суток, — их поднимают
   *      вперёд: иначе они не будут разобраны никогда (EC-U9);
   *   2. среди остальных — те, на которые пожаловались: жалобы говорят,
   *      что материал скорее всего плох;
   *   3. потом свежие: волна идёт сейчас, и разбирают её сейчас.
   *
   *   Окно кластеризации (`mod.cluster_window_h`) тут — порог подъёма, а не
   *   отбор материалов: материал, пролежавший дольше суток, в очередь входит
   *   и поднимается, а отсекать его как «старый» нельзя.
   *
   * Фраза спецификации («сначала жалобы, затем свежие, затем старые — старый
   * поднимается») читается двояко: поднятые старые материалы стоят либо
   * перед всеми, либо после жалоб. Здесь они перед всеми — иначе «подняться»
   * ничего не меняет, кроме хвоста, который и так разбирают последним.
   *
   * @param {{windowHours?: number, limit?: number, states?: string[]}} [input]
   * @returns {Promise<Array<{id: number, authorId: number, seriesId: number|null,
   *   state: string, createdAt: Date, submittedAt: Date, complaints: number,
   *   raised: boolean, waitingMinutes: number}>>}
   */
  async function ordered({ windowHours = MODERATION.clusterWindowH, limit = 50, states = QUEUE_STATES } = {}) {
    const { rows } = await pool.query(
      `SELECT m.id, m.author_id, m.series_id, m.state, m.created_at, m.submitted_at,
              (SELECT count(*)::int FROM e_report r WHERE r.material_id = m.id) AS complaints,
              (m.submitted_at < now() - ($2 || ' hours')::interval) AS raised,
              extract(epoch FROM (now() - m.submitted_at)) / 60 AS waiting
         FROM e_material m
        WHERE m.state = ANY($1::text[])
        ORDER BY raised DESC, complaints DESC, m.submitted_at DESC
        LIMIT $3`,
      [states, String(windowHours), limit],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      authorId: Number(row.author_id),
      seriesId: row.series_id === null ? null : Number(row.series_id),
      state: row.state,
      createdAt: row.created_at,
      submittedAt: row.submitted_at,
      complaints: Number(row.complaints),
      raised: row.raised === true,
      waitingMinutes: Math.round(Number(row.waiting)),
    }));
  }

  /**
   * Кластеры: группы материалов с общей сигнатурой или близким отпечатком.
   *
   * @param {{windowHours: number, minSize: number, states?: string[]}} input
   * @returns {Promise<Array<{signature: string, size: number, authors: number,
   *   materials: object[], decided: string|null}>>}
   */
  async function groups({ windowHours, minSize, states = QUEUE_STATES }) {
    const materials = await queued({ windowHours, states });
    const clusters = [];

    for (const material of materials) {
      const found = clusters.find((cluster) => {
        if (cluster.signature === material.signature) return true;
        return distanceOf(cluster.fingerprint, material.fingerprint) <= CLOSE_DISTANCE;
      });
      if (found) {
        found.materials.push(material);
        continue;
      }
      clusters.push({
        signature: material.signature,
        fingerprint: material.fingerprint,
        size: 0,
        authors: 0,
        materials: [material],
        decided: null,
      });
    }

    for (const cluster of clusters) {
      cluster.size = cluster.materials.length;
      cluster.authors = new Set(cluster.materials.map((material) => material.authorId)).size;
    }

    const { rows } = await pool.query(
      'SELECT signature, decision FROM e_moderation_cluster',
    );
    const decided = new Map(rows.map((row) => [row.signature, row.decision]));

    return clusters
      .filter((cluster) => cluster.size >= minSize)
      .map((cluster) => ({ ...cluster, decided: decided.get(cluster.signature) ?? null }));
  }

  /**
   * Решение по кластеру: одно решение на всю группу.
   *
   * Материалы группы получают решение редактора, а материалы с той же
   * сигнатурой или близким отпечатком, пришедшие позже, — то же решение
   * (F-05-03 §4, [ГИПОТЕЗА] про распространение). Кластер помечается
   * применённым, и решение пишется в журнал решений редактора.
   *
   * @param {{signature: string, decision: 'approved'|'rejected', editorId: number,
   *   reason: string}} input
   * @returns {Promise<{clusterId: number, applied: number}>}
   */
  async function decide({ signature, decision, editorId, reason }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [cluster] } = await client.query(
        `INSERT INTO e_moderation_cluster (signature, decision, decided_by, decided_at, applied)
         VALUES ($1, $2, $3, now(), TRUE)
         ON CONFLICT (signature) DO UPDATE
            SET decision = EXCLUDED.decision,
                decided_by = EXCLUDED.decided_by,
                decided_at = now(),
                applied = TRUE
         RETURNING id`,
        [signature, decision, editorId],
      );

      // Материалы группы: та же сигнатура. Близкие по отпечатку добираются
      // отдельно — их текст отличается, и решение по кластеру на них не
      // распространяется само по себе.
      const { rows: members } = await client.query(
        `SELECT id, body FROM e_material
          WHERE state = ANY($1::text[])
            AND submitted_at >= now() - ($2 || ' hours')::interval`,
        [QUEUE_STATES, String(MODERATION.clusterWindowH)],
      );

      let applied = 0;
      for (const row of members) {
        const same = signatureOf(row.body) === signature;
        if (!same) continue;
        await client.query(
          `INSERT INTO e_editor_decision (material_id, editor_id, decision, reason, cluster_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [row.id, editorId, decision, reason, cluster.id],
        );
        await client.query(
          'UPDATE e_material SET state = $2, decided_at = now() WHERE id = $1',
          [row.id, decision],
        );
        applied += 1;
      }

      await client.query('COMMIT');
      return { clusterId: Number(cluster.id), applied };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return { queued, ordered, groups, decide };
}
