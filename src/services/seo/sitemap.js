// Карта сайта (F-02-11, R-SEO-05).
//
// В карту попадают только индексируемые адреса — те, у которых страница сама
// не отдаёт `noindex`. Поэтому пороги повторяют решения маршрутов: жанр — от
// шести сериалов, человек — от двух, серия — с описанием и прошедшей датой,
// сериал — опубликованный и неархивный. Расхождение здесь означало бы карту,
// которая зовёт робота на страницу, закрытую от индекса.
//
// Адреса в карте абсолютные, а разметка — строкой: это XML, а не HTML-вид, и
// шаблонизатор с экранированием тут только мешает.

/** Предел адресов в одном файле карты — требование протокола. */
export const SHARD_LIMIT = 50_000;

/** Виды страниц в порядке индекса. */
export const SITEMAP_KINDS = [
  'pages', 'series', 'seasons', 'episodes', 'genres', 'collections', 'people',
];

/** Статические адреса: их наличие не зависит от данных. */
const STATIC_PATHS = ['/', '/series', '/calendar', '/collections', '/guides', '/about', '/rules', '/privacy'];

/** Экранирование текста для XML. */
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Условия индексируемости, общие для выборки и для счётчика.
 *
 * Счётчик и выборка обязаны совпадать, иначе индекс пообещает файл, которого
 * нет, или наоборот.
 */
const SERIES_LIVE = `s.publication_state = 'published' AND s.archived_at IS NULL`;

/** Серия индексируется с описанием и прошедшей датой выхода (H-35). */
const EPISODE_LIVE = `btrim(coalesce(e.description_ru, e.description_en, '')) <> ''
  AND r.release_date IS NOT NULL AND r.release_date <= $1::date`;

/** Пара «сериал — серия» с ближайшей датой выхода: так же, как на странице сезона. */
const EPISODE_DATE = `LEFT JOIN LATERAL (
    SELECT rl.release_date
      FROM e_release rl JOIN e_release_episode rle ON rle.release_id = rl.id
     WHERE rle.episode_id = e.id
     ORDER BY rl.release_date
     LIMIT 1
  ) r ON true`;

/**
 * @param {import('pg').Pool} pool
 * @returns {any}
 */
export function pgSitemap(pool) {
  /**
   * Сколько адресов каждого вида.
   *
   * @param {{today: string}} options
   * @returns {Promise<Record<string, number>>}
   */
  async function counts({ today }) {
    const [pages, series, seasons, episodes, genres, collections, people] = await Promise.all([
      Promise.resolve(STATIC_PATHS.length),
      pool.query(`SELECT count(*)::int AS n FROM e_series s WHERE ${SERIES_LIVE}`),
      pool.query(
        `SELECT count(*)::int AS n FROM e_season se JOIN e_series s ON s.id = se.series_id
          WHERE ${SERIES_LIVE}`,
      ),
      pool.query(
        `SELECT count(*)::int AS n
           FROM e_episode e
           JOIN e_season se ON se.id = e.season_id
           JOIN e_series s ON s.id = se.series_id
           ${EPISODE_DATE}
          WHERE ${SERIES_LIVE} AND ${EPISODE_LIVE}`,
        [today],
      ),
      pool.query(
        `SELECT count(*)::int AS n FROM (
           SELECT g.code
             FROM e_genre g
             JOIN e_series_genre sg ON sg.genre_code = g.code
             JOIN e_series s ON s.id = sg.series_id
            WHERE g.active AND NOT g.is_raw AND ${SERIES_LIVE}
            GROUP BY g.code
           HAVING count(*) >= 6
         ) live`,
      ),
      pool.query('SELECT count(*)::int AS n FROM e_collection c WHERE c.active'),
      pool.query(
        `SELECT count(*)::int AS n FROM (
           SELECT p.slug
             FROM e_person p
             JOIN e_series_person sp ON sp.person_id = p.id
             JOIN e_series s ON s.id = sp.series_id
            WHERE ${SERIES_LIVE}
            GROUP BY p.slug
           HAVING count(DISTINCT s.id) >= 2
         ) live`,
      ),
    ]);
    return {
      pages: pages,
      series: series.rows[0].n,
      seasons: seasons.rows[0].n,
      episodes: episodes.rows[0].n,
      genres: genres.rows[0].n,
      collections: collections.rows[0].n,
      people: people.rows[0].n,
    };
  }

  /**
   * Адреса одной страницы файла.
   *
   * @param {string} kind
   * @param {number} page номер файла с единицы
   * @param {{today: string}} options
   * @returns {Promise<Array<{path: string, lastmod?: string, hasEn?: boolean}>>}
   */
  async function urls(kind, page, { today }) {
    const offset = (page - 1) * SHARD_LIMIT;

    if (kind === 'pages') {
      if (page > 1) return [];
      return STATIC_PATHS.map((path) => ({ path, hasEn: true }));
    }

    if (kind === 'series') {
      const { rows } = await pool.query(
        `SELECT s.slug, to_char(s.updated_at, 'YYYY-MM-DD') AS lastmod,
                btrim(coalesce(s.title_en, '')) <> '' AND btrim(coalesce(s.description_en, '')) <> '' AS has_en
           FROM e_series s
          WHERE ${SERIES_LIVE}
          ORDER BY s.id
          LIMIT $1 OFFSET $2`,
        [SHARD_LIMIT, offset],
      );
      return rows.map((row) => ({
        path: `/series/${row.slug}`, lastmod: row.lastmod, hasEn: row.has_en,
      }));
    }

    if (kind === 'seasons') {
      const { rows } = await pool.query(
        `SELECT s.slug, se.number, to_char(s.updated_at, 'YYYY-MM-DD') AS lastmod,
                btrim(coalesce(s.title_original, '')) <> '' AS has_en
           FROM e_season se JOIN e_series s ON s.id = se.series_id
          WHERE ${SERIES_LIVE}
          ORDER BY se.id
          LIMIT $1 OFFSET $2`,
        [SHARD_LIMIT, offset],
      );
      return rows.map((row) => ({
        path: `/series/${row.slug}/seasons/${row.number}`, lastmod: row.lastmod, hasEn: row.has_en,
      }));
    }

    if (kind === 'episodes') {
      const { rows } = await pool.query(
        `SELECT s.slug, se.number AS season, e.number AS episode,
                to_char(s.updated_at, 'YYYY-MM-DD') AS lastmod,
                btrim(coalesce(s.title_original, '')) <> '' AS has_en
           FROM e_episode e
           JOIN e_season se ON se.id = e.season_id
           JOIN e_series s ON s.id = se.series_id
           ${EPISODE_DATE}
          WHERE ${SERIES_LIVE} AND ${EPISODE_LIVE}
          ORDER BY e.id
          LIMIT $2 OFFSET $3`,
        [today, SHARD_LIMIT, offset],
      );
      return rows.map((row) => ({
        path: `/series/${row.slug}/seasons/${row.season}/episodes/${row.episode}`,
        lastmod: row.lastmod,
        hasEn: row.has_en,
      }));
    }

    if (kind === 'genres') {
      const { rows } = await pool.query(
        `SELECT g.code
           FROM e_genre g
           JOIN e_series_genre sg ON sg.genre_code = g.code
           JOIN e_series s ON s.id = sg.series_id
          WHERE g.active AND NOT g.is_raw AND ${SERIES_LIVE}
          GROUP BY g.code
         HAVING count(*) >= 6
          ORDER BY g.code
          LIMIT $1 OFFSET $2`,
        [SHARD_LIMIT, offset],
      );
      // EN-страница жанра — тот же справочник на двух языках, поэтому адрес
      // английской версии существует и индексируется.
      return rows.map((row) => ({ path: `/genres/${row.code}`, hasEn: true }));
    }

    if (kind === 'collections') {
      const { rows } = await pool.query(
        `SELECT c.slug FROM e_collection c WHERE c.active
          ORDER BY c.id LIMIT $1 OFFSET $2`,
        [SHARD_LIMIT, offset],
      );
      // EN-страница подборки закрыта от индекса (noindex в маршруте), поэтому
      // альтернативного языка в записи нет.
      return rows.map((row) => ({ path: `/collections/${row.slug}`, hasEn: false }));
    }

    if (kind === 'people') {
      const { rows } = await pool.query(
        `SELECT p.slug
           FROM e_person p
           JOIN e_series_person sp ON sp.person_id = p.id
           JOIN e_series s ON s.id = sp.series_id
          WHERE ${SERIES_LIVE}
          GROUP BY p.slug
         HAVING count(DISTINCT s.id) >= 2
          ORDER BY p.slug
          LIMIT $1 OFFSET $2`,
        [SHARD_LIMIT, offset],
      );
      return rows.map((row) => ({ path: `/people/${row.slug}`, hasEn: false }));
    }

    throw new Error(`unknown sitemap kind: ${kind}`);
  }

  /**
   * Файлы карты: вид, номер и дата последнего изменения содержимого.
   *
   * `lastmod` есть только там, где база знает дату правки. «Свежая» дата у
   * статических страниц или жанров была бы выдумкой и приучала бы робота не
   * верить полю (R-SEO-05).
   *
   * @param {{today: string}} options
   * @returns {Promise<Array<{kind: string, page: number, lastmod: string|null}>>}
   */
  async function shards({ today }) {
    const [sizes, stamps] = await Promise.all([
      counts({ today }),
      pool.query(
        `SELECT to_char(max(s.updated_at), 'YYYY-MM-DD') AS lastmod
           FROM e_series s WHERE ${SERIES_LIVE}`,
      ),
    ]);
    const seriesLastmod = stamps.rows[0].lastmod ?? null;

    const files = [];
    for (const kind of SITEMAP_KINDS) {
      const total = sizes[kind] ?? 0;
      const pages = Math.ceil(total / SHARD_LIMIT);
      for (let page = 1; page <= pages; page++) {
        files.push({
          kind,
          page,
          lastmod: kind === 'series' || kind === 'seasons' || kind === 'episodes'
            ? seriesLastmod
            : null,
        });
      }
    }
    return files;
  }

  return { counts, urls, shards };
}

/**
 * Индекс карты: перечень файлов.
 *
 * @param {Array<{kind: string, page: number, lastmod: string|null}>} files
 * @param {string} baseUrl
 * @returns {string}
 */
export function sitemapIndexXml(files, baseUrl) {
  const entries = files.map((file) => {
    const loc = `${baseUrl}/sitemap-${file.kind}-${file.page}.xml`;
    return `  <sitemap>\n    <loc>${esc(loc)}</loc>${
      file.lastmod ? `\n    <lastmod>${esc(file.lastmod)}</lastmod>` : ''
    }\n  </sitemap>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + `${entries.join('\n')}\n</sitemapindex>\n`;
}

/**
 * Файл карты: адреса одного вида.
 *
 * Альтернативные языки — только у записей, у которых английская страница
 * индексируется: `hreflang` на закрытую страницу зовёт робота на дубль
 * русского текста (R-SEO-04).
 *
 * @param {Array<{path: string, lastmod?: string, hasEn?: boolean}>} entries
 * @param {string} baseUrl
 * @returns {string}
 */
export function sitemapUrlsetXml(entries, baseUrl) {
  const withAlternates = entries.some((entry) => entry.hasEn);
  const ns = withAlternates
    ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"'
    : '';

  const urls = entries.map((entry) => {
    const ru = `${baseUrl}/ru${entry.path === '/' ? '/' : entry.path}`;
    const lines = [`    <loc>${esc(ru)}</loc>`];
    if (entry.lastmod) lines.push(`    <lastmod>${esc(entry.lastmod)}</lastmod>`);
    if (entry.hasEn) {
      const en = `${baseUrl}/en${entry.path === '/' ? '/' : entry.path}`;
      lines.push(`    <xhtml:link rel="alternate" hreflang="ru" href="${esc(ru)}"/>`);
      lines.push(`    <xhtml:link rel="alternate" hreflang="en" href="${esc(en)}"/>`);
      lines.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${esc(ru)}"/>`);
    }
    return `  <url>\n${lines.join('\n')}\n  </url>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${ns}>\n`
    + `${urls.join('\n')}\n</urlset>\n`;
}
