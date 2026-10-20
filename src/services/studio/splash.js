// Кадры заставки (F-10-09, S-79).
//
// Заставка — вступительный экран: 12–16 узнаваемых кадров сменяются
// один за другим. Кадры берутся из годных фонов сериалов (без текста,
// шириной от 1920, H-34), и порядок задаёт админ.
//
// Смена кадров не должна «мигать»: разница средней яркости соседних кадров
// держится в пределах 20% (F-10-09 §4, WCAG 2.3.1). Проверка считается по
// размытым копиям — их человек и видит на заставке.

import sharp from 'sharp';

/** Сколько кадров нужно заставке. */
export const MIN_FRAMES = 12;

/** Сколько кадров заставка вмещает. */
export const MAX_FRAMES = 16;

/** Насколько соседние кадры могут отличаться по яркости. */
export const MAX_BRIGHTNESS_DIFF = 0.2;

/** Ширина размытой копии: её и показывает заставка. */
const BLURRED_WIDTH = 32;

/**
 * Кадры заставки.
 *
 * @param {import('pg').Pool} pool
 */
export function pgStudioSplash(pool) {
  /**
   * Кадры по порядку.
   *
   * @returns {Promise<object[]>}
   */
  async function frames() {
    const { rows } = await pool.query(
      `SELECT f.id, f.ordinal, f.active, f.image_id,
              s.id AS series_id, s.slug AS series_slug,
              coalesce(s.title_ru, s.title_original) AS series_title,
              i.width, i.height, i.focal_x, i.focal_y
         FROM e_splash_frame f
         JOIN e_image i ON i.id = f.image_id
         LEFT JOIN e_series s ON s.id = f.series_id
        ORDER BY f.ordinal, f.id`,
    );
    const list = rows.map((row) => ({
      id: Number(row.id),
      ordinal: Number(row.ordinal),
      active: Boolean(row.active),
      imageId: Number(row.image_id),
      seriesId: row.series_id === null ? null : Number(row.series_id),
      seriesSlug: row.series_slug,
      seriesTitle: row.series_title,
      width: Number(row.width),
      height: Number(row.height),
      focalX: Math.round(Number(row.focal_x) * 100),
      focalY: Math.round(Number(row.focal_y) * 100),
    }));

    // Яркость считается по размытым копиям: заставка показывает их.
    for (const frame of list) {
      frame.brightness = await brightnessOf(frame.imageId);
    }
    const warnings = [];
    for (let i = 1; i < list.length; i += 1) {
      const before = list[i - 1].brightness;
      const after = list[i].brightness;
      if (before === null || after === null) continue;
      const diff = Math.abs(before - after);
      if (diff > MAX_BRIGHTNESS_DIFF) {
        warnings.push({
          from: list[i - 1].id,
          to: list[i].id,
          diff: Math.round(diff * 100) / 100,
        });
      }
    }
    return { frames: list, warnings, ready: list.length >= MIN_FRAMES };
  }

  /**
   * Сериалы, у которых есть годный фон.
   *
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async function candidates({ limit = 60 } = {}) {
    const { rows } = await pool.query(
      `SELECT s.id, s.slug, coalesce(s.title_ru, s.title_original) AS title,
              i.id AS image_id, i.width, i.height, i.focal_x, i.focal_y
         FROM e_series s
         JOIN e_image i ON i.series_id = s.id AND i.role = 'backdrop'
        WHERE s.archived_at IS NULL
          AND s.publication_state = 'published'
          AND i.width >= 1920
          AND (s.reasons @> ARRAY['no_backdrop']) = false
        ORDER BY s.year_start DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      seriesId: Number(row.id),
      slug: row.slug,
      title: row.title,
      imageId: Number(row.image_id),
      width: Number(row.width),
      height: Number(row.height),
      focalX: Math.round(Number(row.focal_x) * 100),
      focalY: Math.round(Number(row.focal_y) * 100),
    }));
  }

  /**
   * Добавить кадр.
   *
   * @param {{imageId: number, seriesId: number|null, byId: number|null}} input
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function add({ imageId, seriesId = null, byId = null }) {
    const count = await pool.query(
      'SELECT count(*)::int AS n FROM e_splash_frame WHERE active',
    );
    if (count.rows[0].n >= MAX_FRAMES) return { ok: false, reason: 'too_many' };

    const { rows: [image] } = await pool.query(
      `SELECT id, width, height FROM e_image WHERE id = $1 AND role = 'backdrop'`,
      [imageId],
    );
    if (!image) return { ok: false, reason: 'no_image' };
    if (Number(image.width) < 1920) return { ok: false, reason: 'too_small' };

    const { rows: [last] } = await pool.query(
      'SELECT max(ordinal) AS n FROM e_splash_frame',
    );
    const ordinal = Number(last?.n ?? 0) + 1;
    await pool.query(
      `INSERT INTO e_splash_frame (series_id, image_id, ordinal, active)
       VALUES ($1, $2, $3, TRUE)`,
      [seriesId, imageId, ordinal],
    );
    // Размытая копия делается сразу: заставка показывает кадры размытыми, и
    // фильтр на большой картинке стоит дорого (R-PERF-13).
    await ensureBlurred(imageId);
    return { ok: true };
  }

  /**
   * Убрать кадр.
   *
   * @param {{frameId: number, byId: number|null}} input
   * @returns {Promise<boolean>}
   */
  async function remove({ frameId, byId = null }) {
    const { rowCount } = await pool.query(
      'DELETE FROM e_splash_frame WHERE id = $1', [frameId],
    );
    await renumber();
    return rowCount > 0;
  }

  /**
   * Переставить кадр.
   *
   * @param {{frameId: number, where: string}} input
   * @returns {Promise<boolean>}
   */
  async function reorder({ frameId, where = 'up' }) {
    const { rows } = await pool.query(
      'SELECT id, ordinal FROM e_splash_frame ORDER BY ordinal, id',
    );
    const items = rows.map((row) => ({ id: Number(row.id), ordinal: Number(row.ordinal) }));
    const index = items.findIndex((item) => item.id === Number(frameId));
    if (index < 0) return false;
    let target = index;
    if (where === 'up') target = index - 1;
    else if (where === 'down') target = index + 1;
    else if (where === 'first') target = 0;
    else if (where === 'last') target = items.length - 1;
    if (target < 0 || target >= items.length || target === index) return false;
    const moved = items.splice(index, 1)[0];
    items.splice(target, 0, moved);
    for (let i = 0; i < items.length; i += 1) {
      await pool.query('UPDATE e_splash_frame SET ordinal = $2 WHERE id = $1', [items[i].id, i]);
    }
    return true;
  }

  /**
   * Средняя яркость кадра по его размытой копии.
   *
   * @param {number} imageId
   * @returns {Promise<number|null>}
   */
  async function brightnessOf(imageId) {
    const { rows } = await pool.query(
      `SELECT v.file FROM e_image_variant v
        WHERE v.image_id = $1 AND v.blurred
        ORDER BY v.width LIMIT 1`,
      [imageId],
    );
    if (!rows.length) return null;
    try {
      const stats = await sharp(rows[0].file).stats();
      // Средняя яркость: среднее по трём каналам, приведённое к 0–1.
      const mean = (stats.channels.reduce((sum, channel) => sum + channel.mean, 0)
        / stats.channels.length) / 255;
      return Math.round(mean * 1000) / 1000;
    } catch {
      return null;
    }
  }

  /**
   * Сделать размытую копию кадра, если её нет.
   *
   * @param {number} imageId
   * @returns {Promise<void>}
   */
  async function ensureBlurred(imageId) {
    const { rows: [full] } = await pool.query(
      `SELECT file FROM e_image_variant
        WHERE image_id = $1 ORDER BY width DESC LIMIT 1`,
      [imageId],
    );
    if (!full) return;
    const { rows: [exists] } = await pool.query(
      'SELECT 1 FROM e_image_variant WHERE image_id = $1 AND blurred LIMIT 1', [imageId],
    );
    if (exists) return;
    try {
      const { data, info } = await sharp(full.file)
        .resize({ width: BLURRED_WIDTH, withoutEnlargement: true })
        .blur(6)
        .webp({ quality: 70 })
        .toBuffer({ resolveWithObject: true });
      const { sha256 } = await import('../import/images.js');
      await pool.query(
        `INSERT INTO e_image_variant (image_id, width, height, file, mime, bytes, blurred, checksum)
         VALUES ($1, $2, $3, $4, 'image/webp', $5, TRUE, $6)
         ON CONFLICT (image_id, width) DO NOTHING`,
        [imageId, info.width, info.height, data, info.size, sha256(data)],
      );
    } catch {
      // Копию сделать не удалось — заставка покажет кадр без размытия. Это
      // хуже, но не повод не показывать кадр вовсе.
    }
  }

  /**
   * Перенумеровать кадры после удаления.
   *
   * @returns {Promise<void>}
   */
  async function renumber() {
    const { rows } = await pool.query(
      'SELECT id FROM e_splash_frame ORDER BY ordinal, id',
    );
    for (let i = 0; i < rows.length; i += 1) {
      await pool.query('UPDATE e_splash_frame SET ordinal = $2 WHERE id = $1', [rows[i].id, i]);
    }
  }

  return { frames, candidates, add, remove, reorder, brightnessOf };
}
