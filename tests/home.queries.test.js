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
    'e_collection.slug', 'e_collection.title', 'e_collection.active',
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