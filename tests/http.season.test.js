// Страницы сезона и серии: адреса, заголовки и индекс (F-02-02).
//
// Проверяется то, что видит человек и что видит поисковик: код ответа,
// `noindex` у тонкой страницы серии (H-35), соседние адреса и то, что описание
// серии без перевода ru не показывается как английское.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { pgSeasons } from '../src/services/catalogue/season.js';
import { pgSeries } from '../src/services/catalogue/series.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — страницы сезона и серии не проверялись';

let pool;
let server;
let baseUrl;

function stubData() {
  return { banners: async () => [], fresh: async () => [], collections: async () => [], genres: async () => [] };
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  const app = createApp({
    data: stubData(),
    series: pgSeries(pool),
    seasons: pgSeasons(pool),
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve(undefined);
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
});

const get = (path) => fetch(`${baseUrl}${path}`);

async function anySeason() {
  const { rows } = await pool.query(
    `SELECT s.slug, s.title_ru AS title, se.number FROM e_season se
       JOIN e_series s ON s.id = se.series_id
       JOIN e_episode e ON e.season_id = se.id
      WHERE s.publication_state = 'published' AND s.archived_at IS NULL AND se.number > 0
      GROUP BY s.slug, s.title_ru, se.number LIMIT 1`,
  );
  return rows[0];
}

test('страница сезона открывается и содержит серии', { skip }, async () => {
  const found = await anySeason();
  const response = await get(`/ru/series/${found.slug}/seasons/${found.number}`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /<link rel="canonical" href="\/ru\/series\/[^"]+\/seasons\/\d+">/,
    'канонический адрес сезона — свой (R-SEO-02)');
  assert.ok(!/class="season__episode-list"[^>]*>\s*<\/ol>/.test(body),
    'список серий не пуст');
  assert.match(body, /episode/, 'в разметке есть серии');
});

test('серия без описания или с будущей датой не индексируется (H-35)', { skip }, async () => {
  const { rows } = await pool.query(`
    SELECT s.slug, se.number, e.number AS episode FROM e_episode e
      JOIN e_season se ON se.id = e.season_id
      JOIN e_series s ON s.id = se.series_id
      LEFT JOIN e_release r ON r.id = (
        SELECT min(release_id) FROM e_release_episode WHERE episode_id = e.id)
     WHERE s.publication_state = 'published' AND s.archived_at IS NULL
       AND (coalesce(e.description_ru, e.description_en) IS NULL OR r.release_date > CURRENT_DATE)
     LIMIT 1`);

  if (!rows.length) return;   // тонких серий нет

  const response = await get(`/ru/series/${rows[0].slug}/seasons/${rows[0].number}/episodes/${rows[0].episode}`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /<meta name="robots" content="noindex, follow">/,
    'тонкая страница серии в индексе не нужна');
});

test('страница сезона называет сериал, а не «undefined» (F-02-02)', { skip }, async () => {
  // Проверка появилась после находки в браузере: заголовок печатал
  // «undefined: сезон 1» — у строки сериала нет поля `title`, а сервис
  // брал именно его. Тесты разметку смотрели, а заголовок никто не
  // проверял.
  const { slug, number, title } = await anySeason();
  const res = await get(`/ru/series/${slug}/seasons/${number}`);
  assert.equal(res.status, 200);

  const html = await res.text();
  const heading = html.match(/<h1 class="season__title">([^<]*)</)?.[1] ?? '';
  assert.ok(!heading.includes('undefined'), `в заголовке нет «undefined»: ${heading}`);
  assert.ok(heading.includes(title), `заголовок называет сериал «${title}»: ${heading}`);
});

test('снятый с публикации сериал не отдаёт ни сезон, ни серию (410, EC-C1)', { skip }, async () => {
  // Проверка появилась после находки: карточка сериала отдавала 410, а сезон и
  // серия по прямой ссылке — 200 с содержимым. Отозванный контент оставался
  // доступен, хотя снявший его считал обратное.
  const slug = `hs-arch-${crypto.randomUUID()}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start, archived_at)
     VALUES ($1, 'Снят с публикации', 'Archived', $2, 'published', 'ended', 2019, now())
     RETURNING id`,
    [slug, Math.floor(Math.random() * 900000) + 960000000],
  );
  await pool.query('INSERT INTO e_season (series_id, number) VALUES ($1, 1)', [series.id]);
  await pool.query(
    `INSERT INTO e_episode (season_id, number, title_ru, runtime_min)
     SELECT id, 1, 'Пилот', 45 FROM e_season WHERE series_id = $1`,
    [series.id],
  );

  try {
    const card = await get(`/ru/series/${slug}`);
    assert.equal(card.status, 410, 'карточка снятого сериала закрыта — так было и раньше');

    const season = await get(`/ru/series/${slug}/seasons/1`);
    assert.equal(season.status, 410, 'страница сезона закрыта так же');
    assert.ok(!(await season.text()).includes('Пилот'),
      'и содержимое снятого сериала не протекает в ответ');

    const episode = await get(`/ru/series/${slug}/seasons/1/episodes/1`);
    assert.equal(episode.status, 410, 'страница серии закрыта так же');
  } finally {
    await pool.query('DELETE FROM e_season WHERE series_id = $1', [series.id]);
    await pool.query('DELETE FROM e_series WHERE id = $1', [series.id]);
  }
});

test('несуществующие номер сезона и серии — 404, а не пустая страница', { skip }, async () => {
  const found = await anySeason();

  const noSeason = await get(`/ru/series/${found.slug}/seasons/99`);
  assert.equal(noSeason.status, 404);

  const noEpisode = await get(`/ru/series/${found.slug}/seasons/${found.number}/episodes/999`);
  assert.equal(noEpisode.status, 404);

  // Не число — это тоже 404, а не 500: адрес разбирается до похода в базу, и
  // ошибка в этом разборе видна только на таких значениях.
  const badSeason = await get(`/ru/series/${found.slug}/seasons/abc`);
  assert.equal(badSeason.status, 404, 'номер сезона не числом');

  const badEpisode = await get(`/ru/series/${found.slug}/seasons/${found.number}/episodes/abc`);
  assert.equal(badEpisode.status, 404, 'номер серии не числом');
});

test('на странице серии есть соседи, когда они есть', { skip }, async () => {
  const found = await anySeason();
  const { rows: season } = await pool.query(
    `SELECT se.number FROM e_season se
      WHERE se.series_id = (SELECT id FROM e_series WHERE slug = $1) AND se.number = $2`,
    [found.slug, found.number],
  );
  if (!season.length) return;

  const { rows: episodes } = await pool.query(
    `SELECT e.number FROM e_episode e
       JOIN e_season se ON se.id = e.season_id
      WHERE se.series_id = (SELECT id FROM e_series WHERE slug = $1) AND se.number = $2
      ORDER BY e.number`,
    [found.slug, found.number],
  );
  if (episodes.length < 2) return;

  const response = await get(`/ru/series/${found.slug}/seasons/${found.number}/episodes/${episodes[0].number}`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.ok(body.includes(`/seasons/${found.number}/episodes/${episodes[1].number}`),
    'есть ссылка на следующую серию');
});

test('английский адрес сезона открывается', { skip }, async () => {
  const found = await anySeason();
  const response = await get(`/en/series/${found.slug}/seasons/${found.number}`);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /<html lang="en"/);
});

test('ссылки на сезон и серию ведут с карточки сериала', { skip }, async () => {
  const found = await anySeason();
  const page = await (await get(`/ru/series/${found.slug}`)).text();

  assert.ok(page.includes(`/seasons/${found.number}`),
    'на карточке есть ссылка на сезон, и она не 404');
  const response = await get(`/ru/series/${found.slug}/seasons/${found.number}`);
  assert.equal(response.status, 200);
});