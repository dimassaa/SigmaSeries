// Обсуждения сериала: темы, посты, ответы и комментарии к отзыву
// (F-05-07, F-05-01 §4).
//
// Материал обсуждения — та же `e_material`, что и отзыв: та же проверка
// словаря, тот же «осторожный» режим, те же лимиты. Поэтому подача темы и
// ответа устроена так же, как подача отзыва: сначала проверка, потом запись.
//
// Заголовок темы и отметка «закреплено» хранятся в `sections` — JSONB, который
// в схеме отдан под структурированные части материала. Отдельных колонок
// для них нет (в схеме у `e_material` их и не предполагалось) — это отмечено
// в журнале находок.

import { MODERATION, UGC } from '../../config/settings.js';
import { checkMaterial } from '../moderation/check.js';

/** Состояния, в которых материал виден читателю. */
const VISIBLE = new Set(['published', 'approved']);

/**
 * Обсуждения и комментарии.
 *
 * @param {import('pg').Pool} pool
 * @param {object} [deps]
 * @param {object} [deps.limits] бюджет модерации (лимиты частоты, «осторожный» режим)
 * @param {object} [deps.restrictions] ограничения пользователя (мьют, бан)
 */
export function pgDiscussions(pool, { limits = null, restrictions = null } = {}) {
  /**
   * Темы сериала.
   *
   * @param {number} seriesId
   * @param {{page?: number, perPage?: number}} [options]
   * @returns {Promise<{rows: object[], total: number, page: number, pages: number}>}
   */
  async function listForSeries(seriesId, { page = 1, perPage = 20 } = {}) {
    const { rows } = await pool.query(
      `SELECT m.id, m.body, m.spoiler, m.created_at, m.title, m.state,
              u.nickname, u.id AS author_id,
              (SELECT count(*)::int FROM e_material p
                WHERE p.parent_id = m.id AND p.kind = 'post'
                  AND p.state = ANY($2::text[])) AS posts,
              (SELECT count(*)::int FROM e_material p
                WHERE p.parent_id = m.id AND p.kind = 'post'
                  AND p.state = ANY($2::text[]) AND p.pinned) AS pinned
         FROM e_material m
         JOIN e_user u ON u.id = m.author_id
        WHERE m.kind = 'topic' AND m.series_id = $1
          AND m.state = ANY($2::text[])
        ORDER BY m.created_at DESC
        LIMIT $3 OFFSET $4`,
      [seriesId, [...VISIBLE], perPage, (Math.max(1, page) - 1) * perPage],
    );
    const total = await countTopics(seriesId);
    return {
      rows: rows.map(decorateTopic),
      total,
      page: Math.max(1, page),
      pages: Math.max(1, Math.ceil(total / perPage)),
    };
  }

  /**
   * Тема с постами.
   *
   * @param {number} topicId
   * @param {{page?: number, perPage?: number}} [options]
   * @returns {Promise<object|null>}
   */
  async function topic(topicId, { page = 1, perPage = 50, userId = null } = {}) {
    const { rows: [head] } = await pool.query(
      `SELECT m.id, m.body, m.spoiler, m.created_at, m.title, m.state, m.series_id,
              u.nickname, u.id AS author_id, s.slug AS series_slug
         FROM e_material m
         JOIN e_user u ON u.id = m.author_id
         JOIN e_series s ON s.id = m.series_id
        WHERE m.id = $1 AND m.kind = 'topic'`,
      [topicId],
    );
    if (!head) return null;
    // Тема на проверке видна автору и редактору, но не читателю: пока её не
    // решили, она не должна выглядеть как опубликованная.
    const isEditor = await isEditorOf(userId);
    if (!VISIBLE.has(head.state) && !isEditor && Number(head.author_id) !== Number(userId)) {
      return null;
    }

    const { rows: posts } = await pool.query(
      `SELECT m.id, m.body, m.spoiler, m.created_at, m.pinned, m.state,
              u.nickname, u.id AS author_id
         FROM e_material m
         JOIN e_user u ON u.id = m.author_id
        WHERE m.parent_id = $1 AND m.kind = 'post'
          AND m.state = ANY($2::text[])
        ORDER BY m.pinned DESC, m.created_at ASC
        LIMIT $3 OFFSET $4`,
      [topicId, [...VISIBLE], perPage, (Math.max(1, page) - 1) * perPage],
    );
    const { rows: [total] } = await pool.query(
      `SELECT count(*)::int AS n FROM e_material
        WHERE parent_id = $1 AND kind = 'post'`,
      [topicId],
    );

    return {
      ...decorateTopic(head),
      seriesSlug: head.series_slug,
      state: head.state,
      posts: posts.map((post) => ({
        id: post.id,
        body: post.body,
        spoiler: post.spoiler,
        createdAt: post.created_at,
        author: post.nickname,
        authorId: post.author_id,
        pinned: Boolean(post.pinned),
      })),
      totalPosts: total.n,
    };
  }

  /**
   * Создать тему.
   *
   * @param {object} input
   * @returns {Promise<object>}
   */
  async function createTopic({
    userId, seriesId, title, body, spoiler = false, dictionary, at = new Date(),
  }) {
    const text = String(body ?? '').trim();
    const heading = String(title ?? '').trim();
    if (heading.length < 3 || heading.length > 100) {
      return { ok: false, reason: 'title' };
    }
    if (text.length < UGC.topicMinChars || text.length > UGC.topicMaxChars) {
      return { ok: false, reason: text.length < UGC.topicMinChars ? 'short' : 'long' };
    }

    const blocked = await blockedBy(userId, at);
    if (blocked) return blocked;
    const burst = await limits && (await limits.submissionsInMinute(userId, at))
      >= MODERATION.submissionRatePerMin;
    if (burst) return { ok: false, reason: 'rate', retryAfterSec: 60 };

    const result = checkMaterial({ body: text, dictionary });
    if (result.decision === 'reject') return { ok: false, reason: 'empty' };

    const state = result.decision === 'publish'
      ? ((await limits && (await limits.cautiousState()).cautious) ? 'checking' : 'published')
      : result.decision === 'queue' ? 'flagged' : 'checking';

    const { rows } = await pool.query(
      `INSERT INTO e_material (author_id, kind, series_id, title, body, spoiler, lang, state, submitted_at, matches)
       VALUES ($1, 'topic', $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, version`,
      [
        userId, seriesId, heading, text, spoiler, detectLang(text), state, at,
        JSON.stringify((result.matched ?? []).map((item) => ({
          word: item.word, list: item.list ?? null, category: item.category ?? null,
        }))),
      ],
    );
    return { ok: true, state, id: Number(rows[0].id), version: Number(rows[0].version) };
  }

  /**
   * Ответ в тему.
   *
   * @param {object} input
   * @returns {Promise<object>}
   */
  async function reply({
    userId, topicId, body, spoiler = false, dictionary, at = new Date(),
  }) {
    const text = String(body ?? '').trim();
    if (!text || text.length > UGC.commentMaxChars) {
      return { ok: false, reason: text ? 'long' : 'empty' };
    }
    const { rows: [head] } = await pool.query(
      `SELECT id, series_id, state FROM e_material WHERE id = $1 AND kind = 'topic'`,
      [topicId],
    );
    if (!head) return { ok: false, reason: 'not_found' };
    if (!VISIBLE.has(head.state)) return { ok: false, reason: 'not_found' };

    const blocked = await blockedBy(userId, at);
    if (blocked) return blocked;
    const burst = await limits && (await limits.submissionsInMinute(userId, at))
      >= MODERATION.submissionRatePerMin;
    if (burst) return { ok: false, reason: 'rate', retryAfterSec: 60 };

    const result = checkMaterial({ body: text, dictionary });
    if (result.decision === 'reject') return { ok: false, reason: 'empty' };

    const state = result.decision === 'publish'
      ? ((await limits && (await limits.cautiousState()).cautious) ? 'checking' : 'published')
      : result.decision === 'queue' ? 'flagged' : 'checking';

    const { rows } = await pool.query(
      `INSERT INTO e_material (author_id, kind, series_id, parent_id, body, spoiler, lang, state, submitted_at, matches)
       VALUES ($1, 'post', $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, version`,
      [
        userId, head.series_id, topicId, text, spoiler, detectLang(text), state, at,
        JSON.stringify((result.matched ?? []).map((item) => ({
          word: item.word, list: item.list ?? null, category: item.category ?? null,
        }))),
      ],
    );
    return { ok: true, state, id: Number(rows[0].id), version: Number(rows[0].version) };
  }

  /**
   * Закрепить пост (только редактор — проверка на маршруте).
   *
   * @param {{materialId: number, byId: number}} input
   * @returns {Promise<boolean>}
   */
  async function pin({ materialId, byId = null }) {
    const { rowCount } = await pool.query(
      `UPDATE e_material SET pinned = TRUE WHERE id = $1 AND kind = 'post'`,
      [materialId],
    );
    return rowCount > 0;
  }

  /**
   * Комментарии к отзыву.
   *
   * @param {number} reviewId
   * @param {{page?: number, perPage?: number}} [options]
   * @returns {Promise<object[]>}
   */
  async function comments(reviewId, { page = 1, perPage = 50 } = {}) {
    const { rows } = await pool.query(
      `SELECT m.id, m.body, m.spoiler, m.created_at, m.state,
              u.nickname, u.id AS author_id
         FROM e_material m
         JOIN e_user u ON u.id = m.author_id
        WHERE m.kind = 'comment' AND m.parent_id = $1
          AND m.state = ANY($2::text[])
        ORDER BY m.created_at ASC
        LIMIT $3 OFFSET $4`,
      [reviewId, [...VISIBLE], perPage, (Math.max(1, page) - 1) * perPage],
    );
    return rows.map((row) => ({
      id: row.id,
      body: row.body,
      spoiler: row.spoiler,
      createdAt: row.created_at,
      author: row.nickname,
      authorId: row.author_id,
    }));
  }

  /**
   * Комментарий к отзыву.
   *
   * @param {object} input
   * @returns {Promise<object>}
   */
  async function addComment({
    userId, reviewId, body, spoiler = false, dictionary, at = new Date(),
  }) {
    const text = String(body ?? '').trim();
    if (!text || text.length > UGC.commentMaxChars) {
      return { ok: false, reason: text ? 'long' : 'empty' };
    }
    // У комментария есть цель — сериал, а привязка к отзыву — это родитель:
    // ограничение схемы требует цели у каждого комментария.
    const { rows: [review] } = await pool.query(
      `SELECT id, series_id FROM e_material WHERE id = $1 AND kind = 'review'`,
      [reviewId],
    );
    if (!review) return { ok: false, reason: 'not_found' };

    const blocked = await blockedBy(userId, at);
    if (blocked) return blocked;
    const burst = await limits && (await limits.submissionsInMinute(userId, at))
      >= MODERATION.submissionRatePerMin;
    if (burst) return { ok: false, reason: 'rate', retryAfterSec: 60 };

    const result = checkMaterial({ body: text, dictionary });
    if (result.decision === 'reject') return { ok: false, reason: 'empty' };

    const state = result.decision === 'publish'
      ? ((await limits && (await limits.cautiousState()).cautious) ? 'checking' : 'published')
      : result.decision === 'queue' ? 'flagged' : 'checking';

    const { rows } = await pool.query(
      `INSERT INTO e_material (author_id, kind, series_id, parent_id, body, spoiler, lang, state, submitted_at, matches)
       VALUES ($1, 'comment', $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, version`,
      [
        userId, review.series_id, reviewId, text, spoiler, detectLang(text), state, at,
        JSON.stringify((result.matched ?? []).map((item) => ({
          word: item.word, list: item.list ?? null, category: item.category ?? null,
        }))),
      ],
    );
    return { ok: true, state, id: Number(rows[0].id), version: Number(rows[0].version) };
  }

  /**
   * Редактор ли человек.
   *
   * @param {number|null} userId
   * @returns {Promise<boolean>}
   */
  async function isEditorOf(userId) {
    if (!userId) return false;
    const { rows } = await pool.query(
      `SELECT 1 FROM e_role_assignment
        WHERE user_id = $1 AND role IN ('admin', 'moderator') LIMIT 1`,
      [userId],
    );
    return rows.length > 0;
  }

  /**
   * Чем ограничен пользователь.
   *
   * @param {number} userId
   * @param {Date} at
   * @returns {Promise<object|null>}
   */
  async function blockedBy(userId, at) {
    if (!restrictions) return null;
    const active = await restrictions.active(userId, at);
    if (!active) return null;
    return { ok: false, reason: 'muted', until: active.expiresAt ?? null };
  }

  /**
   * Сколько тем у сериала.
   *
   * @param {number} seriesId
   * @returns {Promise<number>}
   */
  async function countTopics(seriesId) {
    const { rows: [row] } = await pool.query(
      `SELECT count(*)::int AS n FROM e_material
        WHERE kind = 'topic' AND series_id = $1 AND state = ANY($2::text[])`,
      [seriesId, [...VISIBLE]],
    );
    return Number(row.n);
  }

  return {
    listForSeries, topic, createTopic, reply, pin, comments, addComment,
  };
}

/**
 * Тема для разметки.
 *
 * @param {object} row
 * @returns {object}
 */
function decorateTopic(row) {
  return {
    id: row.id,
    title: row.title ?? '',
    body: row.body,
    spoiler: row.spoiler,
    createdAt: row.created_at,
    author: row.nickname,
    authorId: row.author_id,
    posts: Number(row.posts ?? 0),
    pinned: Number(row.pinned ?? 0) > 0,
  };
}

/**
 * Язык текста по буквам: кириллица — русский, латиница — английский.
 *
 * @param {string} text
 * @returns {'ru'|'en'}
 */
function detectLang(text) {
  return /[а-яё]/i.test(text) ? 'ru' : 'en';
}
