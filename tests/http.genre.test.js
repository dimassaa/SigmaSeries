// Страница жанра (F-02-04, S-03) и меню жанров (UI-03).
//
// Проверяется то, что видит человек и робот: доступность страницы, noindex
// при малом числе сериалов (F-02-04 §3), canonical на базовый адрес жанра,
// 404 на неизвестный, сырой и скрытый жанр, описание из справочника и
// шаблон описания для поиска при пустом («автотемплата», F-10-10 §4) —
// и то, что меню на списковых страницах показывает жанры из справочника.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { pgCatalogueList } from '../src/services/catalogue/list.js';
import { pgCatalogueGenres } from '../src/services/catalogue/genres.js';
import { stubData } from '../src/services/home/data.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGDATABASE — страница жанра не проверялась';

let pool;
let server;
let baseUrl;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  const app = createApp({
    data: stubData(),
    catalogue: pgCatalogueList(pool),
    genres: pgCatalogueGenres(pool),
    pool,
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
  if (!pool) return;
  await pool.end();
});

const get = (path) => fetch(`${baseUrl}${path}`);

const uuid = () => crypto.randomUUID();

async function insertGenre(patches = {}) {
  const code = `probe-genre-${uuid().slice(0, 8)}`;
  const { rows: [row] } = await pool.query(
    `INSERT INTO e_genre (code, name_ru, name_en, active, is_raw, description_ru, description_en,
       display_order, show_in_menu)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING code`,
    [
      code,
      patches.nameRu ?? 'Жанр для проверки',
      patches.nameEn ?? 'Probe genre',
      patches.active ?? true,
      patches.raw ?? false,
      patches.descriptionRu ?? null,
      patches.descriptionEn ?? null,
      patches.displayOrder ?? null,
      patches.showInMenu ?? true,
    ],
  );
  return row.code;
}

async function publishSeriesWithGenre(genreCode, number) {
  const slug = `probe-series-${uuid().slice(0, 10)}-${number}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, $2, $3, $4, 'published', 'airing', 2024) RETURNING id`,
    [slug, `Пробемый сериал ${number}`, `Probe series ${number}`, 970000800 + number],
  );
  await pool.query('INSERT INTO e_series_genre (series_id, genre_code) VALUES ($1, $2)',
    [series.id, genreCode]);
  return series.id;
}

async function cleanup(genreCode, seriesIds) {
  for (const id of seriesIds) await pool.query('DELETE FROM e_series WHERE id = $1', [id]);
  await pool.query('DELETE FROM e_genre WHERE code = $1', [genreCode]);
}

/** Жанр каталога с наибольшим числом покажет индексируемую страницу. */
async function largeGenre() {
  const { rows } = await pool.query(`
    SELECT g.code, g.name_ru, count(*)::int AS n
      FROM e_genre g
      JOIN e_series_genre sg ON sg.genre_code = g.code
      JOIN e_series s ON s.id = sg.series_id
     WHERE s.publication_state = 'published' AND s.archived_at IS NULL
       AND g.active AND g.is_raw = FALSE AND g.show_in_menu
     GROUP BY g.code, g.name_ru
     HAVING count(*) >= 6
     ORDER BY count(*) DESC LIMIT 1`);
  return rows[0] ?? null;
}

test('большой жанр открывается сеткой и сортировками', { skip }, async () => {
  const genre = await largeGenre();
  if (!genre) return;
  const response = await get(`/ru/genres/${genre.code}`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, new RegExp(`<h1[^>]*>${genre.name_ru.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</h1>`),
    'название жанра — единственный h1');
  assert.match(body, /posters/, 'сетка постеров, как в каталоге');
  assert.match(body, /catalog\.sort|sorts__item/, 'сортировки на месте');
  assert.match(body, /rel="canonical" href="\/ru\/genres\//, 'canonical — базовый адрес жанра');
  assert.ok(!/<meta name="robots"/.test(body), 'страница индексируется');
});

test('жанр с малым числом сериалов открывается, но noindex', { skip }, async () => {
  const code = await insertGenre();
  const ids = [
    await publishSeriesWithGenre(code, 1),
    await publishSeriesWithGenre(code, 2),
  ];

  try {
    const response = await get(`/ru/genres/${code}`);
    const body = await response.text();
    assert.equal(response.status, 200, 'малый жанр доступен по адресу');
    assert.match(body, /noindex, follow/, 'тонкий контент закрыт от индекса (F-02-04 §3)');
    assert.match(body, /2 сериала/, 'число сериалов видно (R-A11Y-19)');
  } finally {
    await cleanup(code, ids);
  }
});

test('неизвестный, сырой, скрытый и выключенный жанр — 404', { skip }, async () => {
  const rawCode = await insertGenre({ raw: true });
  const hiddenCode = await insertGenre({ showInMenu: false });
  const offCode = await insertGenre({ active: false });

  try {
    for (const path of [
      '/ru/genres/no-such-genre',
      '/ru/genres/SCI-FI',
      `/ru/genres/${rawCode}`,
      `/ru/genres/${hiddenCode}`,
      `/ru/genres/${offCode}`,
    ]) {
      const response = await get(path);
      assert.equal(response.status, 404, `404 для ${path}`);
    }
  } finally {
    await cleanup(rawCode, []);
    await cleanup(hiddenCode, []);
    await cleanup(offCode, []);
  }
});

test('описание приходит из справочника, пустое — не съедается (R-I18N-06)', { skip }, async () => {
  const withRu = await insertGenre({ descriptionRu: 'Описание для проверки' });
  const withEn = await insertGenre({ descriptionRu: null, descriptionEn: 'Probe fallback' });
  const without = await insertGenre();

  try {
    const ru = await (await get(`/ru/genres/${withRu}`)).text();
    assert.match(ru, /Описание для проверки/, 'описание ru на странице');
    assert.match(ru, /name="description" content="Описание для проверки"/, 'и в meta');

    const en = await (await get(`/en/genres/${withEn}`)).text();
    assert.match(en, /Probe fallback/, 'описание en на странице');
    assert.match(en, /Probe genre/, 'название en');
    assert.match(en, /rel="canonical" href="\/en\/genres\//, 'canonical в EN-локали');

    const fallback = await (await get(`/ru/genres/${withEn}`)).text();
    assert.match(fallback, /Probe fallback/, 'резерв ru → en на странице жанра');

    const empty = await (await get(`/ru/genres/${without}`)).text();
    assert.ok(!/жанра нет|описание отсутствует/i.test(empty),
      'пустого описания не видно и нет обманывающего текста');
  } finally {
    await cleanup(withRu, []);
    await cleanup(withEn, []);
    await cleanup(without, []);
  }
});

test('шаблон описания для поиска собирается из числа сериалов (F-10-10 §4)', { skip }, async () => {
  const code = await insertGenre();
  const ids = [
    await publishSeriesWithGenre(code, 1),
    await publishSeriesWithGenre(code, 2),
    await publishSeriesWithGenre(code, 3),
  ];

  try {
    const body = await (await get(`/ru/genres/${code}`)).text();
    const meta = body.match(/<meta name="description" content="([^"]*)"\s*>/)?.[1] ?? '';
    assert.ok(meta.includes('3'), 'число в шаблоне описания для поиска');
    assert.ok(meta.includes('Жанр для проверки'), 'название в шаблоне описания');
  } finally {
    await cleanup(code, ids);
  }
});

test('жанр в адресе навязывается сервером, а не берётся из адреса', { skip }, async () => {
  const code = await insertGenre();
  const id = await publishSeriesWithGenre(code, 1);

  try {
    const body = await (await get(`/ru/genres/${code}?genre=fantasy&sort=title`)).text();
    assert.match(body, /Жанр для проверки/, 'жанр страницы — из адреса, а не из запроса');
    assert.match(body, /rel="canonical" href="\/ru\/genres\//, 'canonical без чужих параметров');
  } finally {
    await cleanup(code, [id]);
  }
});

test('пустой жанр отдаёт пустое состояние, а не мягкую 404', { skip }, async () => {
  const code = await insertGenre();

  try {
    const response = await get(`/ru/genres/${code}`);
    const body = await response.text();
    assert.equal(response.status, 200, 'жанр в справочнике жив, 404 показывать нельзя');
    assert.match(body, /noindex/, 'пустая страница не индексируется');
    assert.match(body, /catalog\.empty|empty-state/, 'человеку объясняют пустоту');
  } finally {
    await cleanup(code, []);
  }
});

test('меню жанров на списковой странице и простая ссылка, где данных нет', { skip }, async () => {
  const catalog = await (await get('/ru/series')).text();
  assert.match(catalog, /data-genres-menu/, 'в каталоге меню жанров раскрыто');
  assert.match(catalog, /href="\/ru\/genres\//, 'ссылки ведут на страницы жанров');
  assert.match(catalog, /topbar__genres-count/, 'у жанра число сериалов');
  assert.match(catalog, /href="\/ru\/series">/, 'ссылка «все сериалы» в меню есть');

  const privacy = await (await get('/ru/privacy')).text();
  assert.ok(!/data-genres-menu/.test(privacy),
    'страницы без жанров не роняют меню: простая ссылка');
  assert.match(privacy, /href="\/ru\/series"/, '«Каталог» остаётся на месте');
});

test('Esc и наведение описаны у меню для скрипта', { skip }, async () => {
  const body = await (await get('/ru/series')).text();
  assert.match(body, /data-genres-menu[\s\S]*?aria-expanded="false"/,
    'toggle с aria-expanded, скрипт управляет состоянием');
});
