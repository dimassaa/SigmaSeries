// Загрузка изображений в студии (F-10-04).
//
// Загруженный файл проходит тот же путь, что и картинка из импорта: тип
// определяется по содержимому, а не по заголовку, файл перекодируется без
// метаданных, варианты делаются по ширинам, имя файла не хранится вовсе —
// байты лежат в базе (R-SEC-17, C-04).
//
// Пропорции: постер 2:3, фон 16:9. Если пропорция отличается больше чем на
// три процента, кадр обрезается сам по фокальной точке, и админ видит
// предупреждение (EC-C5).

import sharp from 'sharp';

import {
  checkImage, LIMITS, prepareImage, saveImage, sniffType,
} from '../import/images.js';

/** Требования к роли: минимальный размер и пропорция. */
const REQUIREMENTS = {
  poster: { minWidth: 500, minHeight: 750, ratio: 2 / 3 },
  backdrop: { minWidth: 1920, minHeight: 1080, ratio: 16 / 9 },
  banner: { minWidth: 1920, minHeight: 1080, ratio: 16 / 9 },
  splash: { minWidth: 1920, minHeight: 1080, ratio: 16 / 9 },
};

/** Насколько пропорция может отличаться, прежде чем кадр режется сам. */
const RATIO_TOLERANCE = 0.03;

/** Точка по умолчанию: две трети и одна треть (H-33). */
const DEFAULT_FOCAL = { x: 0.667, y: 0.333 };

/**
 * Загрузка изображений сериала.
 *
 * @param {import('pg').Pool} pool
 */
export function pgStudioImages(pool) {
  /**
   * Загрузить изображение.
   *
   * @param {object} input
   * @param {number} input.seriesId
   * @param {'poster'|'backdrop'|'banner'|'splash'} input.role
   * @param {Buffer} input.buffer содержимое файла
   * @param {boolean} [input.hasText] на изображении есть текст
   * @param {number|null} [input.byId] кто загрузил
   * @returns {Promise<{ok: boolean, reason?: string, imageId?: number, cropped?: boolean,
   *   changed?: boolean, width?: number, height?: number}>}
   */
  async function upload({ seriesId, role, buffer, hasText = false, byId = null }) {
    const rules = REQUIREMENTS[role];
    if (!rules) return { ok: false, reason: 'role' };
    if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, reason: 'empty' };

    // Тип по содержимому: заголовок «image/png» ничего не значит (R-SEC-17).
    if (!sniffType(buffer)) return { ok: false, reason: 'type' };
    try {
      checkImage(buffer, { maxBytes: LIMITS.maxBytes });
    } catch {
      return { ok: false, reason: 'size' };
    }

    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    if (!meta.width || !meta.height) return { ok: false, reason: 'type' };

    let cropped = false;
    let source = buffer;
    const current = meta.width / meta.height;
    if (Math.abs(current - rules.ratio) / rules.ratio > RATIO_TOLERANCE) {
      // Обрезка по фокальной точке: кадр режется сам, но админ должен знать
      // об этом (EC-C5).
      const box = cropBox(meta.width, meta.height, rules.ratio, DEFAULT_FOCAL);
      source = await sharp(buffer, { failOn: 'none' })
        .extract(box)
        .toBuffer();
      cropped = true;
    }

    const size = await sharp(source, { failOn: 'none' }).metadata();
    if (size.width < rules.minWidth || size.height < rules.minHeight) {
      return { ok: false, reason: 'small', width: size.width, height: size.height };
    }

    const prepared = await prepareImage(source, role);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const saved = await saveImage({
        client,
        seriesId,
        role,
        source: 'manual',
        sourcePath: null,
        prepared,
      });
      // Метка «на изображении есть текст» — по ней фон не годится для
      // баннера и заставки (H-34).
      await client.query(
        `UPDATE e_image SET alt = $2 WHERE id = $1`,
        [saved.imageId, hasText ? 'has-text' : null],
      );
      await client.query('COMMIT');
      await recomputeReasons(seriesId);
      return { ok: true, imageId: saved.imageId, cropped, changed: saved.changed };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Убрать изображение.
   *
   * @param {{imageId: number, byId: number|null}} input
   * @returns {Promise<boolean>}
   */
  async function remove({ imageId, byId = null }) {
    const { rowCount } = await pool.query('DELETE FROM e_image WHERE id = $1', [imageId]);
    return rowCount > 0;
  }

  /**
   * Пересчитать причины неполноты после смены изображений.
   *
   * @param {number} id
   * @returns {Promise<void>}
   */
  async function recomputeReasons(id) {
    const { rows } = await pool.query(
      `SELECT s.reasons,
              (SELECT count(*)::int FROM e_image i
                WHERE i.series_id = s.id AND i.role = 'poster') AS posters,
              (SELECT count(*)::int FROM e_image i
                WHERE i.series_id = s.id AND i.role = 'backdrop') AS backdrops
         FROM e_series s WHERE s.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return;

    const reasons = new Set(row.reasons ?? []);
    if (row.posters > 0) reasons.delete('no_poster');
    else reasons.add('no_poster');
    if (row.backdrops > 0) reasons.delete('no_backdrop');
    else reasons.add('no_backdrop');

    const list = [...reasons];
    const minimum = !list.includes('no_genre');
    const displayable = minimum && row.posters > 0
      && !list.includes('no_overview') && !list.includes('no_overview_ru');
    const full = displayable && row.backdrops > 0 && !list.includes('no_overview_ru');

    await pool.query(
      'UPDATE e_series SET reasons = $2, level = $3 WHERE id = $1',
      [id, list, full ? 'full' : displayable ? 'displayable' : 'minimum'],
    );
  }

  return { upload, remove };
}

/**
 * Прямоугольник обрезки по пропорции и точке.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} ratio нужное отношение ширины к высоте
 * @param {{x: number, y: number}} focal точка в долях
 * @returns {{left: number, top: number, width: number, height: number}}
 */
function cropBox(width, height, ratio, focal) {
  let cropWidth = width;
  let cropHeight = height;
  if (width / height > ratio) {
    cropWidth = Math.round(height * ratio);
  } else {
    cropHeight = Math.round(width / ratio);
  }
  const left = Math.max(0, Math.min(width - cropWidth, Math.round(width * focal.x - cropWidth / 2)));
  const top = Math.max(0, Math.min(height - cropHeight, Math.round(height * focal.y - cropHeight / 2)));
  return { left, top, width: cropWidth, height: cropHeight };
}
