// Руководства: список, статья, подача (F-05-06, S-11, S-12).
//
// Руководство — материал того же вида, что отзыв: та же проверка словаря, тот
// же конвейер. Тело статьи структурированное, а не HTML: строки, начинающиеся
// с «## », — заголовки разделов, всё остальное — текст раздела (R-SEC-11).
//
// Заголовок и адрес лежат в `sections` материала: отдельных колонок для них
// в схеме нет, это отмечено в журнале находок (№199).

import { checkMaterial } from '../moderation/check.js';

/** Состояния, в которых материал виден читателю. */
const VISIBLE = new Set(['published', 'approved']);

/** Нижняя граница длины статьи (ugc.guide_min_chars). */
const MIN_CHARS = 500;

/** Верхняя граница длины статьи (ugc.guide_max_chars). */
const MAX_CHARS = 50_000;

/** Больше тридцати разделов статья не читается (F-05-06 §9). */
const MAX_SECTIONS = 30;

/**
 * Руководства.
 *
 * @param {import('pg').Pool} pool
 * @param {object} [deps]
 * @param {object} [deps.limits] бюджет модерации
 * @param {object} [deps.restrictions] ограничения пользователя
 */
export function pgGuides(pool, { limits = null, restrictions = null } = {}) {
  /**
   * Список руководств.
   *
   * @param {{seriesId?: number|null, page?: number, perPage?: number}} [options]
   * @returns {Promise<{rows: object[], total: number}>}
   */
  async function list({ seriesId = null, page = 1, perPage = 20 } = {}) {
    const { rows } = await pool.query(
      `SELECT m.id, m.body, m.spoiler, m.created_at, m.title, m.sections, m.series_id,
              s.slug AS series_slug, coalesce(s.title_ru, s.title_original) AS series_title,
              u.nickname
         FROM e_material m
         JOIN e_user u ON u.id = m.author_id
         LEFT JOIN e_series s ON s.id = m.series_id
        WHERE m.kind = 'guide' AND m.state = ANY($1::text[])
          AND ($2::bigint IS NULL OR m.series_id = $2)
        ORDER BY m.created_at DESC
        LIMIT $3 OFFSET $4`,
      [[...VISIBLE], seriesId, perPage, (Math.max(1, page) - 1) * perPage],
    );
    const { rows: [total] } = await pool.query(
      `SELECT count(*)::int AS n FROM e_material
        WHERE kind = 'guide' AND state = ANY($1::text[])
          AND ($2::bigint IS NULL OR series_id = $2)`,
      [[...VISIBLE], seriesId],
    );
    return {
      rows: rows.map((row) => decorate(row)),
      total: Number(total.n),
    };
  }

  /**
   * Статья по адресу.
   *
   * @param {string} slug
   * @returns {Promise<object|null>}
   */
  async function one(slug) {
    const { rows } = await pool.query(
      `SELECT m.id, m.body, m.spoiler, m.created_at, m.title, m.sections, m.series_id,
              s.slug AS series_slug, coalesce(s.title_ru, s.title_original) AS series_title,
              u.nickname
         FROM e_material m
         JOIN e_user u ON u.id = m.author_id
         LEFT JOIN e_series s ON s.id = m.series_id
        WHERE m.kind = 'guide' AND m.state = ANY($2::text[])
          AND m.slug = $1`,
      [slug, [...VISIBLE]],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...decorate(row),
      sections: sectionsOf(row),
    };
  }

  /**
   * Подать руководство на проверку.
   *
   * @param {object} input
   * @returns {Promise<{ok: boolean, reason?: string, id?: number}>}
   */
  async function submit({
    userId, seriesId = null, title, text, spoiler = false, dictionary, at = new Date(),
  }) {
    const heading = String(title ?? '').trim();
    if (heading.length < 3 || heading.length > 100) return { ok: false, reason: 'title' };
    const body = String(text ?? '').trim();
    if (body.length < MIN_CHARS) return { ok: false, reason: 'short' };
    if (body.length > MAX_CHARS) return { ok: false, reason: 'long' };

    const sections = parseSections(body);
    // Раздел без заголовка — это просто текст: статья читается блоками, и
    // блок без названия не помогает читателю (F-05-06 §5).
    if (!sections.some((section) => section.heading)) {
      return { ok: false, reason: 'sections' };
    }
    if (sections.length > MAX_SECTIONS) return { ok: false, reason: 'too_many' };

    if (restrictions) {
      const active = await restrictions.active(userId, at);
      if (active) return { ok: false, reason: 'muted' };
    }
    if (limits && (await limits.submissionsInMinute(userId, at)) >= 5) {
      return { ok: false, reason: 'rate', retryAfterSec: 60 };
    }

    const result = checkMaterial({ body, dictionary });
    if (result.decision === 'reject') return { ok: false, reason: 'empty' };

    const state = result.decision === 'publish'
      ? ((await limits && (await limits.cautiousState()).cautious) ? 'checking' : 'published')
      : result.decision === 'queue' ? 'flagged' : 'checking';

    const slug = `${slugify(heading)}-${crypto.randomUUID().slice(0, 6)}`;
    const { rows } = await pool.query(
      `INSERT INTO e_material
         (author_id, kind, series_id, title, slug, body, spoiler, lang, state, submitted_at, matches, sections)
       VALUES ($1, 'guide', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        userId, seriesId, heading, slug, body, spoiler,
        /[а-яё]/i.test(body) ? 'ru' : 'en', state, at,
        JSON.stringify((result.matched ?? []).map((item) => ({
          word: item.word, list: item.list ?? null, category: item.category ?? null,
        }))),
        JSON.stringify({ sections }),
      ],
    );
    return { ok: true, state, id: Number(rows[0].id), slug };
  }

  return { list, one, submit };
}

/**
 * Строка списка для разметки.
 *
 * @param {object} row
 * @returns {object}
 */
function decorate(row) {
  return {
    id: Number(row.id),
    slug: row.slug ?? row.sections?.slug ?? '',
    title: row.title ?? row.sections?.title ?? '',
    excerpt: String(row.body ?? '').slice(0, 200),
    spoiler: Boolean(row.spoiler),
    createdAt: row.created_at,
    author: row.nickname,
    seriesId: row.series_id,
    seriesSlug: row.series_slug,
    seriesTitle: row.series_title,
  };
}

/**
 * Разделы статьи из тела.
 *
 * @param {object} row
 * @returns {{heading: string, text: string}[]}
 */
function sectionsOf(row) {
  const stored = row.sections?.sections;
  if (Array.isArray(stored) && stored.length) return stored;
  return parseSections(String(row.body ?? ''));
}

/**
 * Разбор тела на разделы.
 *
 * Строка, начинающаяся с «## », — заголовок раздела; всё остальное — текст
 * раздела. HTML в теле быть не может (R-SEC-11).
 *
 * @param {string} body
 * @returns {{heading: string, text: string}[]}
 */
export function parseSections(body) {
  const sections = [];
  let heading = '';
  let text = [];
  for (const line of String(body ?? '').split('\n')) {
    if (line.trim().startsWith('## ')) {
      if (heading || text.join('\n').trim()) {
        sections.push({ heading, text: text.join('\n').trim() });
      }
      heading = line.trim().slice(3).trim();
      text = [];
      continue;
    }
    text.push(line);
  }
  if (heading || text.join('\n').trim()) {
    sections.push({ heading, text: text.join('\n').trim() });
  }
  return sections.filter((section) => section.heading || section.text);
}

/**
 * Адрес из названия.
 *
 * @param {string} title
 * @returns {string}
 */
function slugify(title) {
  const translit = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
    й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
    ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  const base = String(title ?? '').toLowerCase()
    .split('').map((letter) => translit[letter] ?? letter).join('');
  return base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
