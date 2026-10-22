// Отдача картинок из базы.
//
// Изображения лежат в PostgreSQL (требование Бланка 3.3.1), поэтому их нужно
// кто-то отдавать. Кэша на диске здесь нет и не будет: адрес содержит хэш
// содержимого, а `checksum` и есть валидатор кэша — неизменившееся изображение
// отдаётся прямо из базы, `ETag` позволяет браузеру не качать его повторно.

import express from 'express';

import { bannerOf } from '../services/catalogue/banner.js';
import { isLocale } from '../i18n/strings.js';

/** Куда идти за картинкой: роль, сериал и нужная ширина. */
const IMAGE_SQL = `
  SELECT iv.file, iv.mime, iv.bytes, iv.checksum, iv.width
    FROM e_image i
    JOIN e_image_variant iv ON iv.image_id = i.id
   WHERE i.series_id = $1 AND i.role = $2`;

/**
 * Маршруты картинок.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @returns {import('express').Router}
 */
export function createImageRoutes({ pool }) {
  const router = express.Router({ strict: true });

  /**
   * Картинка сериала по роли и ширине.
   *
   * Браузент просит конкретную ширину, но база хранит набор вариантов. Если
   * точной нет, берётся ближайший **не меньший** — иначе маленький экран
   * получил бы размытую картинку, которой можно не заметить, а большой —
   * увеличенную, которую видно сразу.
   */
  router.get('/:locale/images/:series/:role-:width.webp', async (req, res, next) => {
    const { series, role, width, locale } = req.params;
    const wanted = Number(width);

    if (!/^\d+$/.test(String(width)) || wanted < 1 || wanted > 4000) return next('route');
    if (!['poster', 'backdrop', 'banner'].includes(role)) return next('route');

    try {
      const { rows: seriesRows } = await pool.query(
        'SELECT id FROM e_series WHERE slug = $1 AND publication_state <> $2',
        [series, 'imported'],
      );
      if (!seriesRows.length) return notFound(res);

      const { rows } = await pool.query(
        `${IMAGE_SQL}
           AND iv.width >= $3
         ORDER BY iv.width
         LIMIT 1`,
        [seriesRows[0].id, role, wanted],
      );
      const variant = rows[0];
      if (!variant) return notFound(res);

      res.set('ETag', `"${variant.checksum}"`);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.type(variant.mime);
      return res.status(200).send(variant.file);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/**
 * Маршруты картинок заставки.
 *
 * Кадр заставки — не картинка сериала: у кадра своя картинка и своё
 * размытие, по которому кадры идут по кругу. Отдельный адрес нужен ещё и
 * потому, что у кадра может не быть сериала вовсе.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @returns {import('express').Router}
 */
export function createSplashImageRoutes({ pool }) {
  const router = express.Router({ strict: true });

  router.get('/:locale/splash/:frameId-:width.webp', async (req, res, next) => {
    const { frameId, width, locale } = req.params;
    const wanted = Number(width);

    if (!/^\d+$/.test(String(frameId)) || !/^\d+$/.test(String(width))) return next('route');
    if (wanted < 1 || wanted > 4000) return next('route');

    try {
      const { rows } = await pool.query(
        `SELECT iv.file, iv.mime, iv.bytes, iv.checksum, iv.width
           FROM e_splash_frame f
           JOIN e_image_variant iv ON iv.image_id = f.image_id
          WHERE f.id = $1 AND f.active
            AND iv.width >= $2
          ORDER BY iv.blurred DESC, iv.width
          LIMIT 1`,
        [Number(frameId), wanted],
      );
      const variant = rows[0];
      if (!variant) return notFound(res);

      res.set('ETag', `"${variant.checksum}"`);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.type(variant.mime);
      return res.status(200).send(variant.file);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/**
 * Маршруты картинок подборки.
 *
 * Отдельный адрес нужен потому, что у баннера подборки может не быть сериала:
 * картинка администратора лежит в `e_image` с пустым `series_id`, и по адресу
 * вида `/{locale}/images/{сериал}/...` она недостижима. Правило выбора — своя
 * картинка, иначе фон первого сериала — живёт в `services/catalogue/banner.js`:
 * страница и этот маршрут обязаны показывать одну и ту же картинку.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @returns {import('express').Router}
 */
export function createCollectionImageRoutes({ pool }) {
  const router = express.Router({ strict: true });

  router.get('/:locale/collections/:slug/banner-:width.webp', async (req, res, next) => {
    const { slug, width, locale } = req.params;
    const wanted = Number(width);

    if (!/^\d+$/.test(String(width)) || wanted < 1 || wanted > 4000) return next('route');
    if (!isLocale(locale)) return next('route');

    try {
      const banner = await bannerOf(pool, slug);
      if (!banner) return notFound(res);

      const { rows } = await pool.query(
        `SELECT iv.file, iv.mime, iv.checksum
           FROM e_image_variant iv
          WHERE iv.image_id = $1 AND iv.width >= $2
          ORDER BY iv.width
          LIMIT 1`,
        [banner.imageId, wanted],
      );
      const variant = rows[0];
      if (!variant) return notFound(res);

      res.set('ETag', `"${variant.checksum}"`);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.type(variant.mime);
      return res.status(200).send(variant.file);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/**
 * Отсутствующая картинка — пустой ответ, а не страница.
 *
 * Битая картинка в интерфейсе видна как рамка, и подставлять туда HTML со
 * словами «не найдено» значит показать чужой текст внутри чужого блока.
 * `locale` в адресе оставлен ради единого правила (ADR-003): адрес без языка
 * отдавать нельзя.
 */
function notFound(res) {
  res.set('Cache-Control', 'no-store');
  return res.status(404).end();
}