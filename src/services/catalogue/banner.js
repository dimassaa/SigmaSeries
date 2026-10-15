// Баннер подборки (F-02-05 §3).
//
// Правило одно: картинка админа (`e_collection.banner_image_id`), а если её нет
// — фон первого видимого сериала подборки. Оно живёт здесь, потому что его
// спрашивают двое: источник данных страницы (нужна ширина и точка кадрирования
// для раскладки) и маршрут картинок (нужны байты). Две реализации этого
// правила разошлись бы на первом же админском баннере: страница показала бы
// одну картинку, а по адресу отдалась бы другая.

import pg from 'pg';

/** Ширина, к которой подбирается вариант. */
const WANTED_WIDTH = 1280;

/**
 * Баннер подборки.
 *
 * Точка кадрирования не приходит сюда: `F-02-05` §6 задаёт для баннера правило
 * третей, а не фокус конкретной картинки. Плюс `object-position` в разметке
 * пришлось бы передавать инлайновым стилем, а `style-src 'self'` его не пустит.
 *
 * @param {pg.Pool} pool
 * @param {string} slug
 * @returns {Promise<{imageId: number, width: number, source: 'admin'|'first-series'}|null>}
 */
export async function bannerOf(pool, slug) {
  const { rows } = await pool.query(
    `SELECT id, banner_image_id FROM e_collection
      WHERE slug = $1 AND active AND NOT is_demo`,
    [slug],
  );
  const collection = rows[0];
  if (!collection) return null;

  if (collection.banner_image_id) {
    const found = await variantOf(pool, collection.banner_image_id);
    return found && { ...found, source: 'admin' };
  }

  // Фон первого видимого сериала: «первый» — это порядок админа, а не год
  // выхода. Порядок просмотра и порядок показа — один и тот же.
  const { rows: fallback } = await pool.query(
    `SELECT i.id
       FROM e_collection_item ci
       JOIN e_series s ON s.id = ci.series_id
       JOIN e_image i ON i.series_id = s.id AND i.role = 'backdrop'
      WHERE ci.collection_id = $1
        AND s.publication_state = 'published' AND s.archived_at IS NULL
      ORDER BY ci.ordinal, s.id, i.focal_x
      LIMIT 1`,
    [collection.id],
  );
  if (!fallback.length) return null;

  const found = await variantOf(pool, fallback[0].id);
  return found && { ...found, source: 'first-series' };
}

/**
 * Вариант нужной ширины и точка кадрирования.
 *
 * Ширина выбирается та, что не больше нужной и самая большая из таких: на
 * маленьком экране большой файл всё равно не покажут, а грузить придётся. Если
 * все варианты шире — берётся самый маленький, потому что без картинки баннер
 * не показался бы вовсе.
 *
 * @param {pg.Pool} pool
 * @param {number} imageId
 * @returns {Promise<{imageId: number, width: number}|null>}
 */
export async function variantOf(pool, imageId) {
  const { rows } = await pool.query(
    `SELECT iv.width
       FROM e_image i
       JOIN e_image_variant iv ON iv.image_id = i.id
      WHERE i.id = $1
      ORDER BY iv.width`,
    [imageId],
  );
  if (!rows.length) return null;

  const widths = rows.map((row) => row.width);
  const width = widths.filter((value) => value <= WANTED_WIDTH).sort((a, b) => b - a)[0]
    ?? widths[0];

  return { imageId, width };
}