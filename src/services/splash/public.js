// Заставка на первом открытии сайта (M0, F-00-06).
//
// Оверлей поверх уже загруженной страницы: счёт от 1 до 25 со скоростью,
// рассчитанной так, чтобы уложиться в `splash.max_duration_ms`, затем кадры
// с наложенным блюром по кругу. Пропуск — любое нажатие, клавиша или `Esc`.
//
// Показывается не чаще раза в сутки на устройство и только если человек не
// досмотрел до конца хотя бы один раз (F-00-06 §3).

import pg from 'pg';

import { SPLASH } from '../../config/settings.js';

/**
 * Кадры заставки для показа.
 *
 * @param {pg.Pool} pool
 */
export function pgSplash(pool) {
  /**
   * Кадры, готовые к показу.
   *
   * @returns {Promise<object[]>}
   */
  async function frames() {
    const { rows } = await pool.query(
      `SELECT f.id, f.ordinal, f.image_id, f.focal_x, f.focal_y, f.series_id,
              coalesce(s.title_ru, s.title_original) AS series_title,
              s.slug AS series_slug, s.archived_at AS series_archived,
              i.width, i.height
         FROM e_splash_frame f
         JOIN e_image i ON i.id = f.image_id
         LEFT JOIN e_series s ON s.id = f.series_id
        WHERE f.active
        ORDER BY f.ordinal, f.id`,
    );
    const list = rows.map((row) => ({
      id: Number(row.id),
      ordinal: Number(row.ordinal),
      imageId: Number(row.image_id),
      width: Number(row.width),
      height: Number(row.height),
      focalX: Math.round(Number(row.focal_x) * 100),
      focalY: Math.round(Number(row.focal_y) * 100),
      seriesId: row.series_id === null ? null : Number(row.series_id),
      seriesSlug: row.series_slug,
      seriesTitle: row.series_title,
      // Кадр из архивного сериала в заставку не годится: сериал убрали с
      // главной и из карточек, а кадр остался бы на экране (F-10-09 §5).
      disabled: row.series_archived !== null && row.series_archived !== undefined,
    }));
    return list.filter((frame) => !frame.disabled);
  }

  /**
   * Данные заставки для первого открытия.
   *
   * @returns {Promise<{frames: object[], counterFrom: number, counterTo: number,
   *   maxDurationMs: number, fadeMs: number}>}
   */
  async function data() {
    const list = await frames();
    return {
      frames: list,
      counterFrom: SPLASH.counterFrom,
      counterTo: SPLASH.counterTo,
      maxDurationMs: SPLASH.maxDurationMs,
      fadeMs: SPLASH.fadeMs,
      // Кадров меньше порога — заставка выключается, показывается только счёт.
      enough: list.length >= SPLASH.framesMin,
    };
  }

  return { frames, data };
}
