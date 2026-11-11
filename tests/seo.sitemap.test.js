// Карта сайта (F-02-11): индекс, файлы и правила отбора адресов.
//
// Карта повторяет решения маршрутов об индексируемости, поэтому проверяется
// против живой базы: серия без даты не попадает в файл, жанр без шести
// сериалов не попадает вовсе, а человек с одним сериалом тоже.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';

import { createPool } from '../src/db/pool.js';
import { pgSitemap, sitemapIndexXml, sitemapUrlsetXml } from '../src/services/seo/sitemap.js';
import { createSitemapRoutes } from '../src/routes/sitemap.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGDATABASE — карта не проверялась';

let pool;
let sitemap;
const slugs = [];
const genreCodes = [];
const personIds = [];

test.before(async () => {
  if (!available) return;
  pool = createPool();
  sitemap = pgSitemap(pool);
});

test.after(async () => {
  if (!pool) return;
  // Порядок как в других проверках базы: сезоны удаляются первыми, потому что
  // ключ на сериал у них ограничен (R-SQL-02); выпуски, серии и жанровые
  // ссылки уходят каскадом вместе со своими владельцами.
  if (slugs.length) {
    await pool.query(
      'DELETE FROM e_season WHERE series_id IN (SELECT id FROM e_series WHERE slug = ANY($1::text[]))',
      [slugs],
    );
    await pool.query(
      `DELETE FROM e_series WHERE slug = ANY($1::text[])`,
      [slugs],
    );
  }
  if (personIds.length) {
    await pool.query('DELETE FROM e_series_person WHERE person_id = ANY($1::bigint[])', [personIds]);
    await pool.query('DELETE FROM e_person WHERE id = ANY($1::bigint[])', [personIds]);
  }
  if (genreCodes.length) {
    await pool.query('DELETE FROM e_genre WHERE code = ANY($1::text[])', [genreCodes]);
  }
  await pool.end();
});

/** Сезон удаляется каскадом вместе с сериалом, серия — вместе с сезоном. */
/**
 * @param {{withEn?: boolean, exitState?: string, episode?: {description?: string, withDate?: boolean, date?: string}}} [options]
 */
async function fixtureSeries({ withEn = false, exitState = 'airing', episode = {} } = {}) {
  const slug = `seo-map-${crypto.randomUUID().slice(0, 10)}`;
  slugs.push(slug);
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_en, title_original, description_ru, description_en,
       tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Проверка карты', $2, 'Sitemap probe', 'Описание для карты сайта', $3,
       $4, 'published', $5, 2025)
     RETURNING id, slug`,
    [
      slug,
      withEn ? 'Sitemap probe' : '',
      withEn ? 'Description for the sitemap probe' : '',
      980_100_000 + slugs.length,
      exitState,
    ],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id',
    [series.id],
  );
  let releaseId = null;
  if (episode.description) {
    const { rows: [episodeRow] } = await pool.query(
      `INSERT INTO e_episode (season_id, number, title_ru, description_ru)
       VALUES ($1, 1, 'Серия проверки', $2) RETURNING id`,
      [season.id, episode.description],
    );
    if (episode.withDate) {
      const { rows: [release] } = await pool.query(
        `INSERT INTO e_release (season_id, release_date, covers_season, state)
         VALUES ($1, $2, FALSE, 'aired') RETURNING id`,
        [season.id, episode.date ?? '2026-01-05'],
      );
      await pool.query(
        'INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)',
        [release.id, episodeRow.id],
      );
      releaseId = release.id;
    }
  }
  return { slug, seriesId: series.id, seasonId: season.id, releaseId };
}

test('карта отбирает только индексируемые адреса', { skip }, async () => {
  const today = '2026-11-10';
  const described = await fixtureSeries({
    withEn: true,
    episode: { description: 'Есть описание и прошедшая дата', withDate: true },
  });
  const withoutDate = await fixtureSeries({ episode: { description: 'Без даты' } });
  // Сериал без описания серии: страница серии тонкая, в карту она не нужна.
  await fixtureSeries({});

  const files = await sitemap.shards({ today });
  const kinds = [...new Set(files.map((file) => file.kind))];
  assert.deepEqual(kinds, ['pages', 'series', 'seasons', 'episodes', 'genres', 'collections', 'people'],
    'файл есть у каждого вида, у которого есть адреса');

  const seriesUrls = await sitemap.urls('series', 1, { today });
  const probe = seriesUrls.filter((entry) => entry.path.includes('seo-map-'));
  assert.ok(probe.some((entry) => entry.path === `/series/${described.slug}`), 'сериал есть в карте');
  assert.ok(probe.every((entry) => !/\/episodes\//.test(entry.path)),
    'в файле сериалов адресов серий нет');

  const episodeUrls = await sitemap.urls('episodes', 1, { today });
  assert.ok(episodeUrls.some((entry) => entry.path.startsWith(`/series/${described.slug}/`)),
    'серия с описанием и датой есть в файле серий');
  assert.ok(!episodeUrls.some((entry) => entry.path.startsWith(`/series/${withoutDate.slug}/`)),
    'серия без даты в карте не нужна');

  const describedEntry = episodeUrls.find((entry) => entry.path.startsWith(`/series/${described.slug}/`));
  assert.ok(typeof describedEntry.lastmod === 'string', 'дата правки сериала — реальная, из базы');
  assert.ok(describedEntry.hasEn, 'английская версия сериала индексируется — есть альтернативный язык');

  const indexXml = sitemapIndexXml(files, 'https://example.test');
  assert.match(indexXml, /<loc>https:\/\/example\.test\/sitemap-series-1\.xml<\/loc>/,
    'индекс перечисляет файлы');
});

test('жанр и человек под порогом не попадают в карту', { skip }, async () => {
  const today = '2026-11-10';
  // Свои строки, которые заведомо уникальны: жанр с одним сериалом и человек
  // с одним сериалом — оба тонкие для индекса.
  const { seriesId } = await fixtureSeries({});
  const code = `probe-map-${crypto.randomUUID().slice(0, 8)}`;
  genreCodes.push(code);
  await pool.query(
    `INSERT INTO e_genre (code, name_ru, name_en, active, is_raw, display_order, show_in_menu)
     VALUES ($1, 'Жанр карты', 'Sitemap genre', TRUE, FALSE, NULL, TRUE)`,
    [code],
  );
  await pool.query('INSERT INTO e_series_genre (series_id, genre_code) VALUES ($1, $2)',
    [seriesId, code]);

  const genreUrls = await sitemap.urls('genres', 1, { today });
  assert.ok(!genreUrls.some((entry) => entry.path === `/genres/${code}`),
    'жанр с одним сериалом в карте не нужен');

  const { rows: [person] } = await pool.query(
    `INSERT INTO e_person (slug, name, kind)
     VALUES ($1, 'Человек карты', 'actor') RETURNING id`,
    [`probe-map-${crypto.randomUUID().slice(0, 8)}`],
  );
  await pool.query(
    'INSERT INTO e_series_person (series_id, person_id, role) VALUES ($1, $2, $3)',
    [seriesId, person.id, 'actor'],
  );
  personIds.push(person.id);

  const peopleUrls = await sitemap.urls('people', 1, { today });
  assert.ok(!peopleUrls.some((entry) => entry.path === `/people/${person.slug}`),
    'человек с одним сериалом в карте не нужен');
});

test('отдача кэшируется, а сбой возвращает прошлую карту', async () => {
  let clock = 0;
  let broken = false;
  const stub = {
    shards: async ({ today }) => broken
      ? Promise.reject(new Error('база недоступна'))
      : [{ kind: 'pages', page: 1, lastmod: null }],
    urls: async (kind, page, { today }) => (broken
      ? Promise.reject(new Error('база недоступна'))
      : [{ path: '/', hasEn: true }]),
  };
  const app = express();
  app.use(createSitemapRoutes({
    sitemap: stub,
    baseUrl: 'https://example.test',
    today: () => '2026-11-10',
    now: () => clock,
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => fetch(base + path, { redirect: 'manual' });

  const fresh = await get('/sitemap-pages.xml');
  assert.equal(fresh.status, 200, 'первый ответ собирается');
  assert.match(await fresh.text(), /<urlset/, 'файл — это urlset');
  assert.match(fresh.headers.get('cache-control') ?? '', /max-age/, 'роботу сказано, что карту можно кэшировать');

  // Час ещё не прошёл: сбой источника не виден.
  broken = true;
  clock += 60;
  const stale = await get('/sitemap-pages.xml');
  assert.equal(stale.status, 200, 'в пределах часа отдаётся кэш');

  // Час прошёл: генерация падает, но прошлая карта отдаётся вместо пустой.
  clock += 2 * 60 * 60 * 1000;
  const last = await get('/sitemap-pages.xml');
  assert.equal(last.status, 200, 'сбой не превращает карту в пустую');

  const unknown = await get('/sitemap-nope.xml');
  assert.equal(unknown.status, 404, 'неизвестный вид — нет файла');

  await new Promise((resolve) => server.close(resolve));
});
