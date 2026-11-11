// Отдача карты сайта (F-02-11, R-SEO-05).
//
// Генерация читает несколько таблиц и на большом каталоге стоит секунды, а
// спрашивают карту роботы — часто и пачками. Поэтому ответ кэшируется на час:
// «пересчёт после импорта и ежедневно» превращается в «не дольше часа после
// изменения», а лишних таблиц для очереди пересчёта не нужно.
//
// Ошибка генерации не должна отдавать роботу пустую карту: пустая карта хуже
// отсутствующей, потому что выглядит как «страниц нет». Поэтому при сбое
// отдаётся последняя удачная копия, а если её нет — 503.

import express from 'express';

import { HOUR } from '../config/settings.js';
import { SITEMAP_KINDS, sitemapIndexXml, sitemapUrlsetXml } from '../services/seo/sitemap.js';

/** Адрес без локали: карта собирает локализованные адреса сама. */
const MAX_PAGE = 999;

/**
 * @param {object} deps
 * @param {any} deps.sitemap источник адресов (`pgSitemap`)
 * @param {string} [deps.baseUrl] адрес приложения без слэша на конце
 * @param {() => string} [deps.today] сегодняшняя дата `YYYY-MM-DD`
 * @param {() => number} [deps.now] часы
 * @returns {import('express').Router}
 */
export function createSitemapRoutes({ sitemap, baseUrl = '', today = todayIso, now = () => Date.now() }) {
  const router = express.Router();
  const cache = new Map();

  /** Кэш с запасной копией: сбой генерации не делает карту пустой. */
  async function cached(key, build) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < HOUR) return hit.xml;
    try {
      const xml = await build();
      cache.set(key, { at: now(), xml });
      return xml;
    } catch (error) {
      if (hit) {
        console.error('[sitemap] генерация не удалась, отдана прошлая карта:', error?.message ?? error);
        return hit.xml;
      }
      throw error;
    }
  }

  const sendXml = (res, xml) => res
    .status(200)
    .type('application/xml; charset=utf-8')
    .set('Cache-Control', 'public, max-age=3600')
    .send(xml);

  router.get('/sitemap.xml', async (req, res, next) => {
    try {
      const xml = await cached('index', async () => {
        const files = await sitemap.shards({ today: today() });
        return sitemapIndexXml(files, baseUrl);
      });
      return sendXml(res, xml);
    } catch (error) {
      return next(error);
    }
  });

  /** Файл вида: номер страницы в адресе необязателен. */
  const shard = async (req, res, next) => {
    const { kind } = req.params;
    const page = Number(req.params.page ?? 1);
    if (!SITEMAP_KINDS.includes(kind)) return next('route');
    if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) return next('route');

    try {
      const xml = await cached(`${kind}-${page}`, async () => {
        const entries = await sitemap.urls(kind, page, { today: today() });
        if (entries.length === 0) return null;
        return sitemapUrlsetXml(entries, baseUrl);
      });
      // Пустой файл — это отсутствие файла, а не карта без адресов.
      if (!xml) return res.status(404).type('text/plain; charset=utf-8').send('not found');
      return sendXml(res, xml);
    } catch (error) {
      return next(error);
    }
  };

  // Более длинный шаблон регистрируется первым: иначе `series-1` попал бы в
  // `kind` короткого шаблона.
  router.get('/sitemap-:kind-:page.xml', shard);
  router.get('/sitemap-:kind.xml', shard);

  return router;
}

/** Дата по UTC: карта не привязана к часовому поясу человека. */
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
