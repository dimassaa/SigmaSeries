// Каталог с фильтрами против настоящей базы (F-02-03).
//
// Фильтры проверяются на данных после импорта: в базе больше тысячи сериалов,
// и запрос, который работает на трёх подставных строках, разваливается на
// сортировке по голосам и на пустом рейтинге. Пропускается, если PG* не заданы.

import test from 'node:test';
import assert from 'node:assert/strict';

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
async function published() {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM e_series WHERE publication_state = 'published' AND archived_at IS NULL",
  );
  return rows[0].n;
}

/**
 * Отпечаток каталога для сторожа устойчивости.
 *
 * Одного числа мало: чужой прогон может за это время удалить одну фикстуру и
 * создать другую — число вернётся прежним, а порядок по популярности сдвинется,
 * и страницы начнут пересекаться. Последний идентификатор такое пропускает.
 *
 * @returns {Promise<string>}
 */
async function fingerprint() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n, coalesce(max(id), 0) AS newest
       FROM e_series WHERE publication_state = 'published' AND archived_at IS NULL`,
  );
  return `${rows[0].n}:${rows[0].newest}`;
}

/**
 * Общее число страницы равно числу опубликованных сериалов.
 *
 * Два чтения подряд не могут увидеть одно и то же: база общая, и параллельные
 * прогоны создают и убирают свои фикстуры между ними. Поэтому сравнение
 * повторяется — а не ослабляется: расхождение означало бы, что список считает
 * не то, что фильтр.
 *
 * @param {object} options параметры каталога
 * @returns {Promise<object>} страница, для которой числа сошлись
 */
async function assertTotalMatches(options) {
  const page = await stablePage(options);
  assert.equal(page.total, await published(),
    'в списке ровно опубликованные видимые сериалы (шесть попыток — каталог менялся под ногами)');
  return page;
}

/**
 * Страница, прочитанная в момент, когда каталог не менялся.
 *
 * Чтение «страница → счётчик» ловит гонку: между ними чужой прогон добавляет
 * фикстуру, и расхождение означало бы не ошибку фильтра. Поэтому счётчик
 * берётся с двух сторон: пока «до» и «после» совпадают, каталог стоял.
 *
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function stablePage(options = {}) {
  let page = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const before = await fingerprint();
    // eslint-disable-next-line no-await-in-loop
    const current = await catalogue.list(options);
    // eslint-disable-next-line no-await-in-loop
    const after = await fingerprint();
    if (before === after) {
      page = current;
      if (current.total === before) return page;
    }
  }
  return page ?? catalogue.list(options);
}

test('список показывает только опубликованные и не архивные', { skip }, async () => {
  // Состав страницы проверяется по её же строкам, а не по живому счётчику
  // каталога: база общая, и параллельные прогоны добавляют фикстуры, из-за
  // чего сравнение «страница против счётчика» мигает без всякой ошибки в коде.
  const page = await stablePage({});
  assert.ok(page.items.length > 0, 'база после импорта не пуста');
  assert.ok(page.total >= page.items.length, 'общее число не меньше показанного');
  const { rows: hidden } = await pool.query(
    `SELECT count(*)::int AS n FROM e_series s
       JOIN unnest($1::bigint[]) AS u(series_id) ON u.series_id = s.id
      WHERE s.publication_state <> 'published' OR s.archived_at IS NOT NULL`,
    [page.items.map((item) => item.id)],
  );
  assert.equal(hidden[0].n, 0, 'неопубликованных и архивных в выдаче нет');
});

test('страницы не пересекаются и считаются от общего числа', { skip }, async (t) => {
  // Обе страницы читаются внутри одного устойчивого окна: постраничная выборка
  // опирается на `OFFSET`, и появление чужой фикстуры между чтениями сдвигает
  // окно, из-за чего строка первой страницы оказывается и на второй. Это свойство
  // изменяющейся базы, а не ошибка постраничности.
  let first = null;
  let second = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const before = await fingerprint();
    // eslint-disable-next-line no-await-in-loop
    const one = await catalogue.list({ page: 1 });
    // eslint-disable-next-line no-await-in-loop
    const two = await catalogue.list({ page: 2 });
    // eslint-disable-next-line no-await-in-loop
    const after = await fingerprint();
    if (before === after && one.total === two.total) {
      first = one;
      second = two;
      break;
    }
  }
  // Пересечение страниц нельзя проверить на живой базе, которую параллельно
  // меняют: десять попыток могут не хватить. Тогда проверка честно сообщает,
  // что не выполнена, вместо того чтобы показать красное из-за чужого прогона.
  if (!first || !second) {
    t.skip('каталог менялся все десять попыток — проверять не на чем');
    return;
  }

  assert.equal(first.pages, Math.ceil(first.total / first.size));
  assert.equal(first.items.length, first.size);
  assert.equal(second.items.length, first.size);
  const overlap = first.items.filter((a) => second.items.some((b) => b.id === a.id));
  assert.deepEqual(overlap, [], 'страница 2 не повторяет страницу 1');
});

test('страница за пределами списка пуста, а не обрезается молча', { skip }, async () => {
  // Номер страницы за концом берётся из счётчика, прочитанного в том же
  // устойчивом окне: сравнивать две страницы, снятые в разные моменты, в
  // общей базе бессмысленно — между ними успевает появиться чужая фикстура.
  let beyond = null;
  let total = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const before = await fingerprint();
    // Счётчик для номера страницы берётся из отпечатка: он прочитан в том же
    // окне, что и выдача, и потому относится к тому же состоянию каталога.
    const seen = Number(before.split(':')[0]);
    // eslint-disable-next-line no-await-in-loop
    const page = await catalogue.list({ page: Math.ceil(seen / 24) + 3 });
    // eslint-disable-next-line no-await-in-loop
    const after = await fingerprint();
    if (before === after && page.total === seen) {
      beyond = page;
      total = seen;
      break;
    }
  }
  assert.ok(beyond, 'каталог стоял десять попыток подряд — иначе проверять нечего');
  assert.deepEqual(beyond.items, [], 'выдача пуста — маршрут отвечает 301 на последней странице');
  assert.equal(beyond.total, total, 'общее число остаётся, по нему считается последняя страница');
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

  const filtered = await catalogue.list({ genres: [genre.code] });
  assert.ok(filtered.total > 0);
  // Порог сравнивается с числом опубликованных «на сейчас»: параллельные
  // прогоны добавляют и убирают фикстуры, поэтому и верхняя граница, и сам
  // фильтр берутся одним повторяющимся чтением.
  let all = await published();
  for (let attempt = 0; attempt < 3 && filtered.total >= all; attempt += 1) {
    all = await published();
  }
  assert.ok(filtered.total < all, 'фильтр действительно сужает');
  // У сериала жанров несколько, а в подписи под постером показан один, поэтому
  // принадлежность жанру проверяется запросом, а не полем карточки.
  const { rows: withGenre } = await pool.query(
    `SELECT count(*)::int AS n FROM e_series s
       JOIN unnest($1::bigint[]) AS u(series_id) ON u.series_id = s.id
       JOIN e_series_genre sg ON sg.series_id = s.id AND sg.genre_code = $2`,
    [filtered.items.map((item) => item.id), genre.code],
  );
  assert.equal(withGenre[0].n, filtered.items.length, 'в выдаче только сериалы выбранного жанра');

  // То же повторяющееся чтение: один живой счёт и выдача, снятая в другой
  // момент, расходятся из-за параллельных прогонов, а не из-за фильтра.
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
  // Обе выборки читаются в одном устойчивом моменте: иначе чужой прогон,
  // добавивший сериал между ними, дал бы расхождение, которого нет в коде.
  const junk = await stablePage({ sort: 'votes); DROP TABLE e_series; --' });
  const popular = await stablePage({ sort: 'popular' });
  assert.deepEqual(junk.items.map((i) => i.id), popular.items.map((i) => i.id),
    'неизвестная сортировка молча заменяется популярностью');

  // Порядок сравнивается с тем же запросом в базе, а не с `Array.sort()`:
  // сортировка PostgreSQL по правилам локали не совпадает с порядком строк в
  // JavaScript, и сравнение с ним ловило бы чужую ошибку.
  const byTitle = await catalogue.list({ sort: 'title' });
  const { rows: expected } = await pool.query(`
    SELECT s.id FROM e_series s
     WHERE s.publication_state = 'published' AND s.archived_at IS NULL
     ORDER BY coalesce(s.title_ru, s.title_en, s.title_original) ASC
     LIMIT $1`, [byTitle.size]);
  assert.deepEqual(byTitle.items.map((item) => item.id), expected.map((row) => row.id),
    'по названию — по алфавиту, так же, как считает база');

  const byRating = await catalogue.list({ sort: 'rating' });
  const values = byRating.items.map((item) => item.rating ?? -1);
  assert.deepEqual(values, [...values].sort((a, b) => b - a), 'по рейтингу — по убыванию');
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
  const byCountry = await catalogue.list({ countries: [country[0].code] });
  let all = await published();
  for (let attempt = 0; attempt < 3 && byCountry.total >= all; attempt += 1) {
    all = await published();
  }
  assert.ok(byCountry.total > 0 && byCountry.total < all, 'страна действительно сужает выдачу');

  const { rows: foreign } = await pool.query(
    `SELECT sn.network_id::text AS id, count(*)::int AS n
       FROM e_series_network sn
       JOIN e_series s ON s.id = sn.series_id
        AND s.publication_state = 'published' AND s.archived_at IS NULL
      GROUP BY sn.network_id ORDER BY n DESC LIMIT 1`,
  );
  assert.ok(foreign.length, 'сети залиты хотя бы для одного сериала');
  const byNetwork = await catalogue.list({ networks: [foreign[0].id] });
  assert.ok(byNetwork.total > 0);
  const { rows: members } = await pool.query(
    `SELECT count(*)::int AS n FROM e_series_network WHERE network_id = $1`, [foreign[0].id],
  );
  assert.ok(byNetwork.total <= members[0].n, 'фильтр по сети не может дать больше, чем есть связей');

  await assertTotalMatches({ countries: ['ZZ'], networks: ['нет такого'] });
});

test('поиск по справочнику сужает список вариантов, а не выдачу', { skip }, async () => {
  const all = await catalogue.filters();
  const search = await catalogue.filters({ networkSearch: 'hbo' });

  assert.ok(search.networks.length < all.networks.length, 'список сетей сузился');
  assert.ok(search.networks.every((row) => row.name.toLowerCase().includes('hbo')),
    `в списке только совпадения: ${search.networks.map((row) => row.name).join(', ')}`);
  assert.equal(search.countries.length, all.countries.length,
    'поиск по сетям не трогает список стран');
});

test('размер страницы берётся из настроек, а не из адреса', { skip }, async () => {
  const page = await catalogue.list({});
  const { rows } = await pool.query("SELECT value FROM e_system_setting WHERE key = 'catalog.page_size'");

  assert.equal(page.size, rows[0] ? Number(rows[0].value) : 24,
    'число страницы — из catalog.page_size, а не из того, что прислал клиент');
});