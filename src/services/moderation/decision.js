// Решение редактора по материалу (F-05-04, R-MOD-17…R-MOD-19).
//
// Решение всегда с причиной: автору уходит конкретная причина и найденное
// слово, а не код правила. Каждое решение попадает в журнал решений редактора
// и в аудит, а автору приходит уведомление.
//
// Решение необратимо для материала, но отменяемо редактором в пределах
// окна (M5 §8в): отмена — отдельная запись в аудите, а не стирание.

import { MODERATION } from '../../config/settings.js';
import { signatureOf, pgModerationClusters } from './cluster.js';

/** Слова решения маршрута и состояния материала. */
export const DECISIONS = { approve: 'approved', reject: 'rejected' };

/**
 * Источник решений редактора.
 *
 * @param {import('pg').Pool} pool
 * @returns {object}
 */
export function pgModerationDecisions(pool) {
  // Кластеры: решение по кластеру распространяется на новые материалы с той
  // же сигнатурой (подтверждено автором 21.10).
  const clusters = pgModerationClusters(pool);

  /**
   * Принять решение по материалу.
   *
   * @param {{materialId: number, decision: string, editorId: number,
   *   reason: string, matchedWord?: string|null, whitelist?: boolean}} input
   * @returns {Promise<{ok: boolean, reason?: string, skipped?: string,
   *   materialId?: number, clusterId?: number|null}>}
   */
  async function decide({
    materialId, decision, editorId, reason, matchedWord = null, whitelist = false,
  }) {
    if (!DECISIONS[decision]) return { ok: false, reason: 'decision' };
    const cause = String(reason ?? '').trim();
    if (!cause) return { ok: false, reason: 'reason' };

    const { rows: [material] } = await pool.query(
      'SELECT id, author_id, state, body, lang FROM e_material WHERE id = $1',
      [materialId],
    );
    if (!material) return { ok: false, reason: 'missing' };
    // Материал, удалённый автором, разбирать не нужно: решение не требуется,
    // и это не ошибка (F-05-04 §5).
    if (material.state === 'deleted') return { ok: true, skipped: 'deleted' };

    // Темп решений: заведомо неправдоподобная частота — сама по себе
    // сигнал (F-05-04 §9).
    const { rows: [tally] } = await pool.query(
      `SELECT count(*)::int AS n FROM e_editor_decision
        WHERE editor_id = $1 AND decided_at > now() - interval '1 hour'`,
      [editorId],
    );
    if (Number(tally.n) >= MODERATION.decisionsPerHour) return { ok: false, reason: 'rate' };

    const state = DECISIONS[decision];
    const materialLang = material.lang || 'ru';

    // Кластер, если материал в нём состоит: у кластера своё решение, и
    // ссылка на него в журнале показывает, к какой группе решение относится.
    const { rows: [cluster] } = await pool.query(
      'SELECT id FROM e_moderation_cluster WHERE signature = $1',
      [signatureOf(material.body)],
    );
    const clusterId = cluster ? Number(cluster.id) : null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO e_editor_decision (material_id, editor_id, decision, reason, matched_word, cluster_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [material.id, editorId, state, cause, matchedWord, clusterId],
      );
      await client.query(
        'UPDATE e_material SET state = $2, decided_at = now() WHERE id = $1',
        [material.id, state],
      );
      // Слово в белый список — с причиной и в аудит (M5 §8д): правило словаря
      // меняет проверку всех материалов, и молчаливая правка опаснее.
      if (whitelist && matchedWord) {
        // Язык слова — язык материала: слово найдено именно в этом тексте.
        await client.query(
          `INSERT INTO e_dictionary_word (word, language, list, category, active)
           VALUES ($1, $2, 'allow', NULL, TRUE)
           ON CONFLICT (word, language) DO UPDATE SET list = 'allow', active = TRUE`,
          [matchedWord, materialLang],
        );
      }
      await client.query(
        `INSERT INTO e_notification (user_id, kind, category, params, dedup_key)
         VALUES ($1, 'material_decision', 'service', $2, $3)
         ON CONFLICT (user_id, dedup_key) DO NOTHING`,
        [
          material.author_id,
          JSON.stringify({ materialId: material.id, decision: state, reason: cause }),
          `material-decision:${material.id}`,
        ],
      );
      await client.query('COMMIT');

      // Решение по кластеру: помеченный материал запрещается вместе со всей
      // группой, а та же сигнатура в новых материалах запрещается сразу.
      if (state === DECISIONS.reject) {
        await clusters.decide({
          signature: signatureOf(material.body),
          decision: state,
          editorId,
          reason: cause,
        });
      }

      return { ok: true, materialId: Number(material.id), clusterId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Материал для разбора: текст, находки, жалобы и история автора.
   *
   * @param {{materialId: number}} input
   * @returns {Promise<object|null>}
   */
  async function one({ materialId }) {
    const { rows: [material] } = await pool.query(
      `SELECT m.id, m.author_id, m.kind, m.body, m.state, m.created_at, m.submitted_at,
              m.matches, m.series_id, u.nickname,
              (SELECT count(*)::int FROM e_report r WHERE r.material_id = m.id) AS complaints
         FROM e_material m
         JOIN e_user u ON u.id = m.author_id
        WHERE m.id = $1`,
      [materialId],
    );
    if (!material) return null;
    return {
      id: Number(material.id),
      authorId: Number(material.author_id),
      authorNickname: material.nickname,
      kind: material.kind,
      body: material.body,
      state: material.state,
      seriesId: material.series_id === null ? null : Number(material.series_id),
      createdAt: material.created_at,
      submittedAt: material.submitted_at,
      matches: Array.isArray(material.matches) ? material.matches : [],
      complaints: Number(material.complaints),
      history: await authorHistory(material.author_id),
    };
  }

  /**
   * Разделить кластер: решение по выбранным материалам (F-05-03 §5).
   *
   * Кластер — способ разбора, а не приговор: редактор решает по каждому
   * материалу отдельно, и решение применяется только к выбранным. Кластерная
   * подпись (запрет по сигнатуре) при этом не ставится: группа оказалась не
   * однородной, и материалы с той же сигнатурой, пришедшие позже, разбираются
   * сами.
   *
   * @param {{materialIds?: number[], decision: string, editorId: number, reason: string}} input
   * @returns {Promise<{ok: boolean, reason?: string, decided?: number}>}
   */
  async function split({ materialIds = [], decision, editorId, reason }) {
    if (!DECISIONS[decision]) return { ok: false, reason: 'decision' };
    const cause = String(reason ?? '').trim();
    if (!cause) return { ok: false, reason: 'reason' };

    const ids = [...new Set(materialIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length) return { ok: false, reason: 'materials' };

    // Темп решений: заведомо неправдоподобная частота — сама по себе сигнал
    // (F-05-04 §9). Разделение — одно решение редактора, а не десяток.
    const { rows: [tally] } = await pool.query(
      `SELECT count(*)::int AS n FROM e_editor_decision
        WHERE editor_id = $1 AND decided_at > now() - interval '1 hour'`,
      [editorId],
    );
    if (Number(tally.n) >= MODERATION.decisionsPerHour) return { ok: false, reason: 'rate' };

    const state = DECISIONS[decision];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: materials } = await client.query(
        `SELECT id, author_id FROM e_material
          WHERE id = ANY($1::bigint[]) AND state IN ('flagged','checking')`,
        [ids],
      );
      for (const material of materials) {
        await client.query(
          `INSERT INTO e_editor_decision (material_id, editor_id, decision, reason)
           VALUES ($1, $2, $3, $4)`,
          [material.id, editorId, state, cause],
        );
        await client.query(
          'UPDATE e_material SET state = $2, decided_at = now() WHERE id = $1',
          [material.id, state],
        );
        await client.query(
          `INSERT INTO e_notification (user_id, kind, category, params, dedup_key)
           VALUES ($1, 'material_decision', 'service', $2, $3)
           ON CONFLICT (user_id, dedup_key) DO NOTHING`,
          [
            material.author_id,
            JSON.stringify({ materialId: material.id, decision: state, reason: cause }),
            `material-decision:${material.id}`,
          ],
        );
      }
      await client.query('COMMIT');
      return { ok: true, decided: materials.length };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * История решений по материалам автора — редактору о его материалах
   * (F-05-04 §4: «история автора за последние решения»).
   *
   * @param {number} authorId
   * @param {number} [limit]
   * @returns {Promise<Array<{decision: string, reason: string, decidedAt: Date}>>}
   */
  async function authorHistory(authorId, limit = 10) {
    const { rows } = await pool.query(
      `SELECT d.decision, d.reason, d.decided_at FROM e_editor_decision d
         JOIN e_material m ON m.id = d.material_id
        WHERE m.author_id = $1
        ORDER BY d.decided_at DESC
        LIMIT $2`,
      [authorId, limit],
    );
    return rows.map((row) => ({
      decision: row.decision,
      reason: row.reason,
      decidedAt: row.decided_at,
    }));
  }

  return { decide, one, authorHistory, split };
}
