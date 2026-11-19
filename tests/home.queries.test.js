// Запросы главной против живой схемы.
//
// Отдельный файл не для удобства, а потому что предыдущие тесты HTTP
// работают на заглушке и проверяют только маршруты и разметку. Три ошибки
// в SQL — несуществующее поле archived_at, отсутствующая связь
// e_image.series_id, забытый GROUP BY — прошли все проверки и всплыли
// только при первом запуске против базы.
//
// Тест пропускается без базы, как и проверки схемы.

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { pgData } from '../src/services/home/data.js';

const CONN = process.env.PGHOST && process.env.PGDATABASE
  ? {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER,
      database: process.env.PGDATABASE,
    }
  : process.env.TEST_DATABASE_URL
    ? { connectionString: process.env.TEST_DATABASE_URL }
    : null;

const skip = CONN ? false : 'нет подключения к базе — запросы главной не проверялись';

let pool;
let data;

test.before(async () => {
  if (!CONN) return;
  pool = new pg.Pool(CONN);
  await pool.query('select 1');
  data = pgData(pool);
});

test.after(async () => {
  if (pool) await pool.end();
});

/**
 * Запрос выполняется один раз и проверяется на структуру результата, а не
 * на содержимое: база может быть пустой, и это нормальное состояние.
 */
const methods = ['banners', 'fresh', 'collections', 'genres'];

for (const name of methods) {
  test(`запрос ${name} выполняется против настоящей схемы`, { skip }, async () => {
    const rows = await data[name]('ru');
    assert.ok(Array.isArray(rows), `${name} должен возвращать массив`);
  });
}

test('запросы используют только поля, существующие в схеме', { skip }, async () => {
  // Список колонок, на которые опирается разметка. Пока он совпадает с
  // DDL, опечатка в запросе не дойдёт до отрисовки.
  const res = await pool.query(`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('e_banner','e_series','e_image','e_image_variant',
                          'e_external_rating','e_release','e_season',
                          'e_collection','e_genre','e_series_genre')`);
  const have = new Set(res.rows.map((r) => `${r.table_name}.${r.column_name}`));

  const needed = [
    'e_banner.kind', 'e_banner.show_on', 'e_banner.active',
    'e_series.slug', 'e_series.title_ru', 'e_series.title_original',
    'e_series.year_start', 'e_series.year_end', 'e_series.exit_state',
    'e_series.archived_at',
    // Без этой связи постер и фон не принадлежат ни к чему.
    'e_image.series_id', 'e_image.role',
    'e_image_variant.file', 'e_image_variant.width',
    'e_external_rating.platform', 'e_external_rating.value',
    'e_release.release_date', 'e_season.number',
    'e_collection.slug', 'e_collection.title_ru', 'e_collection.active',
    'e_genre.code', 'e_genre.name_ru', 'e_genre.active',
    'e_series_genre.genre_code',
  ];
  const absent = needed.filter((c) => !have.has(c));
  assert.deepEqual(absent, [], `в схеме нет: ${absent.join(', ')}`);
});

test('гость получает популярное, а вошедший — свой ряд (F-06-06 §18)', { skip }, async () => {
  const guest = await data.forYou(null);
  assert.equal(guest.personalized, false, 'гость получает популярное');
  assert.ok(guest.items.length <= 6, 'не больше шести постеров');

  // Свой ряд: человек с оценкой сериала получает похожие жанры.
  // Пользователь создаётся через хранилище: адрес в базе вслепую, вручную его
  // не вставить.
  const { pgAuthStore } = await import('../src/services/auth/store.js');
  const name = `foryou-${crypto.randomUUID().slice(0, 8)}`;
  const account = await pgAuthStore(pool).createUser({
    email: `${name}@example.com`,
    nickname: name,
    passwordHash: 'x',
    tokenHash: crypto.randomUUID(),
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  const user = { id: account.id };
  // Сериал с жанром: без жанра ряд не собрать — по жанрам и подбирается.
  const { rows: [series] } = await pool.query(
    `SELECT s.id FROM e_series s
       JOIN e_series_genre sg ON sg.series_id = s.id
      WHERE s.publication_state = 'published' AND s.archived_at IS NULL
      GROUP BY s.id LIMIT 1`,
  );
  await pool.query(
    `INSERT INTO e_rating (user_id, object_type, series_id, value, counted)
     VALUES ($1, 'series', $2, 9, TRUE) ON CONFLICT DO NOTHING`,
    [user.id, series.id],
  );

  const own = await data.forYou(user.id);
  assert.equal(own.personalized, true, 'вошедший получает свой ряд');
  assert.ok(own.items.length > 0, 'ряд не пуст');

  await pool.query('DELETE FROM e_rating WHERE user_id = $1', [user.id]);
  await pool.query('DELETE FROM e_user WHERE id = $1', [user.id]);
});

test('пустой каталог даёт пустые массивы, а не ошибку', { skip }, async () => {
  // Свежая установка без импорта — обычное состояние, и главная обязана
  // открываться: иначе первый запуск упирается в 500.
  const empty = await pool.query(`
    SELECT (SELECT count(*) FROM e_banner) AS b,
           (SELECT count(*) FROM e_series WHERE archived_at IS NULL) AS s,
           (SELECT count(*) FROM e_collection) AS c,
           (SELECT count(*) FROM e_genre WHERE active) AS g`);
  const r = empty.rows[0];
  if (Number(r.s) === 0 && Number(r.b) === 0) {
    assert.deepEqual(await data.banners(), []);
    assert.deepEqual(await data.fresh('ru'), []);
  }
});
test('лента свежего и популярное отдают переводы названий (№270)', { skip }, async () => {
  const slug = `home-en-${crypto.randomUUID().slice(0, 8)}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, imdb_key, title_ru, title_en, title_original, publication_state, exit_state, year_start)
     VALUES ($1, $2, 'Северный ветер', 'North Wind', 'Northwind', 'published', 'airing', 2020) RETURNING id`,
    [slug, `tt${crypto.randomUUID().slice(2, 12)}`],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [series.id],
  );
  const { rows: [episode] } = await pool.query(
    "INSERT INTO e_episode (season_id, number, title_ru) VALUES ($1, 1, 'Серия') RETURNING id", [season.id],
  );
  const { rows: [release] } = await pool.query(
    `INSERT INTO e_release (season_id, release_date, precision, state, covers_season)
     VALUES ($1, CURRENT_DATE, 'date', 'scheduled', TRUE) RETURNING id`, [season.id],
  );
  await pool.query(
    'INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)',
    [release.id, episode.id],
  );
  // Популярное у гостя — по рейтингу: без оценки фикстура не попала бы в шесть.
  await pool.query(
    `INSERT INTO e_external_rating (series_id, platform, value, votes, measured_on)
     VALUES ($1, 'imdb', 9.9, 9000000, CURRENT_DATE)`, [series.id],
  );

  try {
    const fresh = (await data.fresh('en')).flat().find((item) => item.slug === slug);
    assert.ok(fresh, 'фикстура попала в ленту свежего');
    assert.equal(fresh.titleEn, 'North Wind', 'лента отдаёт перевод названия');
    assert.equal(fresh.titleRu, 'Северный ветер');

    const guest = await data.forYou(null);
    const popular = guest.items.find((item) => item.slug === slug);
    assert.ok(popular, 'фикстура попала в популярное');
    assert.equal(popular.titleEn, 'North Wind', 'популярное отдаёт перевод названия');
  } finally {
    await pool.query('DELETE FROM e_season WHERE series_id = $1', [series.id]);
    await pool.query('DELETE FROM e_series WHERE id = $1', [series.id]);
  }
});

test('жанровые плитки главной переводятся (№270)', { skip }, async () => {
  // Самый наполненный жанр гарантированно попадает в плитки: список режется
  // по числу сериалов.
  const { rows: [genre] } = await pool.query(`
    SELECT g.code, g.name_ru, g.name_en
      FROM e_genre g
      JOIN e_series_genre sg ON sg.genre_code = g.code
      JOIN e_series s ON s.id = sg.series_id AND s.archived_at IS NULL
     WHERE g.active AND g.is_raw = FALSE
     GROUP BY g.code, g.name_ru, g.name_en
    HAVING count(sg.series_id) > 0
     ORDER BY count(sg.series_id) DESC
     LIMIT 1`);
  if (!genre?.name_en) return; // перевода в справочнике нет — проверять нечего

  const en = await data.genres('en');
  assert.equal(en.find((row) => row.code === genre.code)?.title, genre.name_en,
    'EN-плитки называют жанр переводом');
  const ru = await data.genres('ru');
  assert.equal(ru.find((row) => row.code === genre.code)?.title, genre.name_ru,
    'русские плитки не изменились');
});

test('неопубликованный сериал не попадает на главную (ни в «Новинки», ни в баннеры)', { skip }, async () => {
  // Импорт пишет каталог в состоянии `imported`: сериал виден только в студии.
  // Его постер отдавать некому (маршрут картинок не serving импорт), поэтому
  // на главной такая карточка — серая рамка без постера.
  const slug = `home-imported-${crypto.randomUUID().slice(0, 8)}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, imdb_key, title_ru, title_en, title_original, publication_state, exit_state, year_start)
     VALUES ($1, $2, 'Черновик', 'Draft', 'Draft', 'imported', 'airing', 2020) RETURNING id`,
    [slug, `tt${crypto.randomUUID().slice(2, 12)}`],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [series.id],
  );
  const { rows: [episode] } = await pool.query(
    "INSERT INTO e_episode (season_id, number, title_ru) VALUES ($1, 1, 'Серия') RETURNING id", [season.id],
  );
  const { rows: [release] } = await pool.query(
    `INSERT INTO e_release (season_id, release_date, precision, state, covers_season)
     VALUES ($1, CURRENT_DATE, 'date', 'scheduled', TRUE) RETURNING id`, [season.id],
  );
  await pool.query(
    'INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)',
    [release.id, episode.id],
  );
  await pool.query(
    `INSERT INTO e_banner (series_id, kind, show_on, active) VALUES ($1, 'editorial', CURRENT_DATE, TRUE)
     ON CONFLICT (kind, show_on) DO NOTHING`, [series.id],
  );

  try {
    const fresh = (await data.fresh('ru')).flat();
    assert.ok(!fresh.some((item) => item.slug === slug),
      'импортированный сериал не занимает «Новинки»');

    const banners = await data.banners('ru');
    assert.ok(!banners.some((item) => item.seriesSlug === slug),
      'импортированный сериал не попадает в баннеры');
  } finally {
    await pool.query('DELETE FROM e_banner WHERE series_id = $1', [series.id]);
    await pool.query('DELETE FROM e_season WHERE series_id = $1', [series.id]);
    await pool.query('DELETE FROM e_series WHERE id = $1', [series.id]);
  }
});

test('сериал с несколькими выходами в окне занимает в «Новинках» одну карточку', { skip }, async () => {
  const slug = `home-twice-${crypto.randomUUID().slice(0, 8)}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, imdb_key, title_ru, title_en, title_original, publication_state, exit_state, year_start)
     VALUES ($1, $2, 'Двойной выход', 'Double Release', 'Double Release', 'published', 'airing', 2020)
     RETURNING id`,
    [slug, `tt${crypto.randomUUID().slice(2, 12)}`],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [series.id],
  );
  const { rows: [episode] } = await pool.query(
    "INSERT INTO e_episode (season_id, number, title_ru) VALUES ($1, 1, 'Серия') RETURNING id", [season.id],
  );
  // Два выхода в окне: пара эпизодов вышла в разные дни — карточка одна.
  for (const days of [0, 1]) {
    const { rows: [release] } = await pool.query(
      `INSERT INTO e_release (season_id, release_date, precision, state, covers_season)
       VALUES ($1, CURRENT_DATE - $2::int, 'date', 'aired', FALSE) RETURNING id`,
      [season.id, days],
    );
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      'INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)',
      [release.id, episode.id],
    );
  }

  try {
    const fresh = (await data.fresh('ru')).flat();
    assert.ok(fresh.some((item) => item.slug === slug), 'фикстура попала в ленту');
    assert.equal(fresh.filter((item) => item.slug === slug).length, 1,
      'одна карточка на сериал, а не по карточке на каждый выход');
  } finally {
    await pool.query('DELETE FROM e_season WHERE series_id = $1', [series.id]);
    await pool.query('DELETE FROM e_series WHERE id = $1', [series.id]);
  }
});
