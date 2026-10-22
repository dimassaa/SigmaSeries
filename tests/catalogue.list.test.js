// Каталог с фильтрами против настоящей базы (F-02-03).
//
// Фильтры проверяются на данных после импорта: в базе больше тысячи сериалов,
// и запрос, который работает на трёх подставных строках, разваливается на
// сортировке по голосам и на пустом рейтинге. Пропускается, если PG* не заданы.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgCatalogueList } from '../src/services/catalogue/list.js';
import { acquireImportLock } from './helpers/import-lock.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE или TEST_DATABASE_URL — каталог не проверялся';

let pool;
let catalogue;
let unlockImport;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  // Размер страницы и порог рейтинга лежат в общих настройках: без блокировки
  // соседняя проверка порога пересчитала бы этот каталог под своим числом.
  unlockImport = await acquireImportLock(pool);
  catalogue = pgCatalogueList(pool);
});

test.after(async () => {
  if (!pool) return;
  await unlockImport?.();
  await pool.end();
});

/** Сколько опубликованных сериалов в базе — эталон для «всех». */
async function published(runner = pool) {
  const { rows } = await runner.query(
    "SELECT count(*)::int AS n FROM e_series WHERE publication_state = 'published' AND archived_at IS NULL",
  );
  return rows[0].n;
}

/**
 * Читает каталог в одном снимке базы (`REPEATABLE READ`).
 *
 * Отпечаток «до и после» видел только число и последний id: мгновенный
 * переворот видимости или правка ключа сортировки сдвигает окно `OFFSET`,
 * оставляя отпечаток прежним, и честные страницы выглядели пересекающимися —
 * ложное красное (№156). В снимке все чтения видят одно состояние каталога,
 * поэтому сравнения стали строгими, а сторожить больше нечего.
 *
 * @param {(runner: any, frozen: any) => Promise<*>} read
 * @returns {Promise<*>}
 */
async function inSnapshot(read) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const runner = { query: (text, values) => client.query(text, values) };
    return await read(runner, pgCatalogueList(runner));
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/**
 * Общее число страницы равно числу опубликованных сериалов.
 *
 * Число и страница читаются в одном снимке: сравнение со свежим `count(*)`
 * после чтения расходилось бы из-за параллельного прогона, добавившего или
 * убравшего фикстуру, — ложное красное на общей базе без ошибки в коде
 * (так и случилось 18.10 при прогоне F-04-02: 1067 против 1068).
 *
 * @param {any} options параметры каталога
 * @returns {Promise<any>} страница, для которой числа сошлись
 */
async function assertTotalMatches(options) {
  return inSnapshot(async (runner, frozen) => {
    const seen = await published(runner);
    const page = await frozen.list(options);
    assert.equal(page.total, seen, 'в списке ровно опубликованные видимые сериалы');
    return page;
  });
}

/**
 * Страницы каталога, прочитанные в одном снимке.
 *
 * @param {any[]} optionsList параметры каждой страницы
 * @returns {Promise<any[]>} страницы в том же порядке
 */
async function snapshotPages(optionsList) {
  return inSnapshot(
    (runner, frozen) => Promise.all(optionsList.map((options) => frozen.list(options))),
  );
}

/**
 * Страница, прочитанная в снимке, — для проверок без пар.
 *
 * @param {any} [options]
 * @returns {Promise<any>}
 */
async function stablePage(options = {}) {
  return inSnapshot((runner, frozen) => frozen.list(options));
}

test('список показывает только опубликованные и не архивные', { skip }, async () => {
  // Страница и проверка её строк — в одном снимке: иначе параллельный прогон
  // скрывает сериал из выдачи между чтениями, и проверка краснеет на верном
  // коде. Состав страницы проверяется по её же строкам, а не по живому
  // счётчику каталога: база общая.
  await inSnapshot(async (runner, frozen) => {
    const page = await frozen.list({});
    assert.ok(page.items.length > 0, 'база после импорта не пуста');
    assert.ok(page.total >= page.items.length, 'общее число не меньше показанного');
    const { rows: hidden } = await runner.query(
      `SELECT count(*)::int AS n FROM e_series s
         JOIN unnest($1::bigint[]) AS u(series_id) ON u.series_id = s.id
        WHERE s.publication_state <> 'published' OR s.archived_at IS NOT NULL`,
      [page.items.map((item) => item.id)],
    );
    assert.equal(hidden[0].n, 0, 'неопубликованных и архивных в выдаче нет');
  });
});

test('страницы не пересекаются и считаются от общего числа', { skip }, async () => {
  // Обе страницы — из одного снимка: постраничная выборка опирается на
  // `OFFSET`, и чужое изменение между чтениями сдвигало окно так, что строка
  // первой страницы оказывалась и на второй (№156); в снимке пересечение —
  // уже настоящий дефект, и проверка сравнивает строго.
  const [first, second] = await snapshotPages([{ page: 1 }, { page: 2 }]);

  assert.equal(first.pages, Math.ceil(first.total / first.size));
  assert.equal(first.items.length, first.size);
  assert.equal(second.items.length, first.size);
  assert.equal(second.total, first.total, 'обе страницы считают от одного каталога');
  const overlap = first.items.filter((a) => second.items.some((b) => b.id === a.id));
  assert.deepEqual(overlap, [], 'страница 2 не повторяет страницу 1');
});

test('страница за пределами списка пуста, а не обрезается молча', { skip }, async () => {
  // Номер «за концом» берётся из счётчика того же снимка: сравнивать числа,
  // снятые в разные моменты, на общей базе бессмысленно — между ними
  // успевает появиться чужая фикстура.
  await inSnapshot(async (runner, frozen) => {
    const seen = await published(runner);
    const beyond = await frozen.list({ page: Math.ceil(seen / 24) + 3 });

    assert.deepEqual(beyond.items, [], 'выдача пуста — маршрут отвечает 301 на последней странице');
    assert.equal(beyond.total, seen, 'общее число остаётся, по нему считается последняя страница');
  });
});

test('жанр сужает выдачу, а незнакомый жанр игнорируется', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT g.code, count(*)::int AS n
       FROM e_series_genre sg
       JOIN e_series s ON s.id = sg.series_id AND s.publication_state = 'published' AND s.archived_at IS NULL
       JOIN e_genre g ON g.code = sg.genre_code
      GROUP BY g.code HAVING count(*) > 0 ORDER BY n DESC LIMIT 1`,
  );
  const genre = rows[0];
  assert.ok(genre, 'в базе есть опубликованные сериалы хотя бы одного жанра');

  // Выдача, счётчик и сверка строк — в одном снимке: между чтениями чужой
  // прогон успевает добавить или убрать фикстуру, и проверка краснеет на
  // верном коде (№156).
  const { page, withGenre } = await inSnapshot(async (runner, frozen) => {
    const filtered = await frozen.list({ genres: [genre.code] });
    // У сериала жанров несколько, а в подписи под постером показан один,
    // поэтому принадлежность жанру проверяется запросом, а не полем карточки.
    const { rows: counted } = await runner.query(
      `SELECT count(*)::int AS n FROM e_series s
         JOIN unnest($1::bigint[]) AS u(series_id) ON u.series_id = s.id
         JOIN e_series_genre sg ON sg.series_id = s.id AND sg.genre_code = $2`,
      [filtered.items.map((item) => item.id), genre.code],
    );
    return { page: filtered, withGenre: counted[0].n };
  });
  assert.ok(page.total > 0);
  const all = await published();
  assert.ok(page.total < all, 'фильтр действительно сужает');
  assert.equal(withGenre, page.items.length, 'в выдаче только сериалы выбранного жанра');

  // То же в снимке: живой счёт и выдача, снятая в другой момент, расходятся
  // из-за параллельных прогонов, а не из-за фильтра.
  await assertTotalMatches({ genres: ['такого-жанра-нет'] });
});

test('диапазон годов и рейтинг отсекают по значениям', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT year_start FROM e_series
      WHERE publication_state = 'published' AND archived_at IS NULL AND year_start IS NOT NULL
      ORDER BY year_start LIMIT 1`,
  );
  const oldest = rows[0].year_start;

  const recent = await catalogue.list({ yearFrom: oldest + 10 });
  assert.ok(recent.items.every((item) => item.yearStart >= oldest + 10),
    'в выдаче нет сериалов старше нижней границы');

  const rated = await catalogue.list({ ratingFrom: 9 });
  assert.ok(rated.items.every((item) => item.rating === null || item.rating >= 9),
    'рейтинг ниже порога не попадает');
});

test('состояние выхода — из белого списка', { skip }, async () => {
  const airing = await catalogue.list({ states: ['airing'] });
  assert.ok(airing.items.every((item) => item.exitState === 'airing'));

  const junk = await stablePage({ states: ["airing'; DROP TABLE e_series; --"] });
  assert.ok(junk.total > 0, 'мусор в адресе не сужает выдачу и не ломает базу');
});

test('сортировка выбирается из белого списка', { skip }, async () => {
  // Выборки и сверка с базой — в одном снимке: иначе чужой прогон, изменивший
  // сериал между чтениями, дал бы расхождение, которого нет в коде (№156).
  const [junk, popular] = await snapshotPages([
    { sort: 'votes); DROP TABLE e_series; --' },
    { sort: 'popular' },
  ]);
  assert.deepEqual(junk.items.map((i) => i.id), popular.items.map((i) => i.id),
    'неизвестная сортировка молча заменяется популярностью');

  const { page: byTitle, expected } = await inSnapshot(async (runner, frozen) => {
    const page = await frozen.list({ sort: 'title' });
    // Порядок сравнивается с тем же запросом в базе, а не с `Array.sort()`:
    // сортировка PostgreSQL по правилам локали не совпадает с порядком строк в
    // JavaScript, и сравнение с ним ловило бы чужую ошибку.
    const { rows } = await runner.query(`
      SELECT s.id FROM e_series s
       WHERE s.publication_state = 'published' AND s.archived_at IS NULL
       ORDER BY coalesce(s.title_ru, s.title_en, s.title_original) ASC
       LIMIT $1`, [page.size]);
    return { page, expected: rows };
  });
  assert.deepEqual(byTitle.items.map((item) => item.id), expected.map((row) => row.id),
    'по названию — по алфавиту, так же, как считает база');

  const byRating = await stablePage({ sort: 'rating' });
  const values = byRating.items.map((item) => item.rating ?? -1);
  assert.deepEqual(values, [...values].sort((a, b) => b - a), 'по рейтингу — по убыванию');
});

test('сырые жанры импорта не попадают в публичный фильтр', { skip }, async () => {
  const code = `imdb:test-${crypto.randomUUID()}`;
  const { rows: [series] } = await pool.query(
    "SELECT id FROM e_series WHERE publication_state = 'published' AND archived_at IS NULL LIMIT 1",
  );
  await pool.query(
    `INSERT INTO e_genre (code, name_ru, name_en, active, is_raw)
     VALUES ($1, $1, $1, true, true)`,
    [code],
  );
  await pool.query(
    'INSERT INTO e_series_genre (series_id, genre_code) VALUES ($1, $2)',
    [series.id, code],
  );

  try {
    const filters = await catalogue.filters();
    assert.ok(!filters.genres.some((genre) => genre.code === code),
      'жанр без перевода остаётся в импорте, но человеку в фильтре не показывается');
  } finally {
    await pool.query('DELETE FROM e_series_genre WHERE series_id = $1 AND genre_code = $2',
      [series.id, code]);
    await pool.query('DELETE FROM e_genre WHERE code = $1', [code]);
  }
});

test('границы фильтров берутся из данных', { skip }, async () => {
  const filters = await catalogue.filters();

  assert.ok(filters.genres.length > 0, 'жанры для фильтра есть');
  assert.ok(filters.genres.every((genre) => genre.count > 0), 'жанр без сериалов в фильтр не попадает');
  assert.ok(filters.yearMin < filters.yearMax, 'диапазон годов не вырожден');
  assert.ok(filters.ratingMax > 0 && filters.ratingMin <= filters.ratingMax, 'шкала рейтинга осмысленна');
  assert.deepEqual(
    filters.states.map((state) => state.key),
    ['airing', 'waiting', 'announced', 'ended', 'cancelled'],
    'состояния в порядке, в котором человек о них думает, а не как в базе',
  );
});

test('страна сужает выдачу, а серия — по каналу', { skip }, async () => {
  const { rows: country } = await pool.query(
    `SELECT sc.country_code AS code, count(*)::int AS n
       FROM e_series_country sc
       JOIN e_series s ON s.id = sc.series_id
        AND s.publication_state = 'published' AND s.archived_at IS NULL
      GROUP BY sc.country_code ORDER BY n DESC LIMIT 1`,
  );
  assert.ok(country.length, 'страны залиты хотя бы для одного сериала');
  // Выдача и счётчик — в одном снимке: между чтениями чужой прогон добавляет
  // и убирает фикстуры, и сравнение врёт на верном коде (№156).
  const byCountry = await inSnapshot(async (runner, frozen) => {
    const page = await frozen.list({ countries: [country[0].code] });
    return { page, all: await published(runner) };
  });
  assert.ok(byCountry.page.total > 0 && byCountry.page.total < byCountry.all,
    'страна действительно сужает выдачу');

  const { rows: foreign } = await pool.query(
    `SELECT sn.network_id::text AS id, count(*)::int AS n
       FROM e_series_network sn
       JOIN e_series s ON s.id = sn.series_id
        AND s.publication_state = 'published' AND s.archived_at IS NULL
      GROUP BY sn.network_id ORDER BY n DESC LIMIT 1`,
  );
  assert.ok(foreign.length, 'сети залиты хотя бы для одного сериала');
  const byNetwork = await inSnapshot(async (runner, frozen) => {
    const page = await frozen.list({ networks: [foreign[0].id] });
    const { rows } = await runner.query(
      'SELECT count(*)::int AS n FROM e_series_network WHERE network_id = $1', [foreign[0].id],
    );
    return { page, members: rows[0].n };
  });
  assert.ok(byNetwork.page.total > 0);
  assert.ok(byNetwork.page.total <= byNetwork.members, 'фильтр по сети не может дать больше, чем есть связей');

  await assertTotalMatches({ countries: ['ZZ'], networks: ['нет такого'] });
});

test('поиск по справочнику сужает список вариантов, а не выдачу', { skip }, async () => {
  // Оба среза справочника — из одного снимка: сравнение двух живых чтений
  // расходится от чужого прогона, а не от поиска.
  const [all, search] = await inSnapshot((runner, frozen) => Promise.all([
    frozen.filters(),
    frozen.filters({ networkSearch: 'hbo' }),
  ]));

  assert.ok(search.networks.length < all.networks.length, 'список сетей сузился');
  assert.ok(search.networks.every((row) => row.name.toLowerCase().includes('hbo')),
    `в списке только совпадения: ${search.networks.map((row) => row.name).join(', ')}`);
  assert.equal(search.countries.length, all.countries.length,
    'поиск по сетям не трогает список стран');
});

test('размер страницы берётся из настроек, а не из адреса', { skip }, async () => {
  // Страница и настройка — в одном снимке: иначе чужая правка настройки между
  // чтениями выглядела бы ошибкой сервиса.
  const { size, configured } = await inSnapshot(async (runner, frozen) => {
    const page = await frozen.list({});
    const { rows } = await runner.query(
      "SELECT value FROM e_system_setting WHERE key = 'catalog.page_size'",
    );
    return { size: page.size, configured: rows[0] ? Number(rows[0].value) : 24 };
  });
  assert.equal(size, configured, 'число страницы — из catalog.page_size, а не из того, что прислал клиент');
});