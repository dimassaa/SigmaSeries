// HTTP-слой каталога (F-02-03, S-02).
//
// Проверяется то, что видит человек и что видит поисковик: код ответа,
// канонический адрес, настоящие ссылки постраничности и то, что при неудачных
// фильтрах страница честно помечает себя `noindex`, а не отдаёт пустую 200.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { pgCatalogueList } from '../src/services/catalogue/list.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE или TEST_DATABASE_URL — каталог не проверялся';

let pool;
let server;
let baseUrl;
let queries = 0;

function stubData() {
  return {
    banners: async () => [],
    fresh: async () => [],
    collections: async () => [],
    genres: async () => [],
  };
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  // Счётчик запросов — измерение 14: «запросов к БД ≤ 15» на страницу.
  const counted = {
    query: (...args) => {
      queries += 1;
      return pool.query(...args);
    },
    end: () => pool.end(),
  };
  const app = createApp({ data: stubData(), catalogue: pgCatalogueList(counted) });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
});

const get = (path) => fetch(`${baseUrl}${path}`, { redirect: 'manual' });

test('каталог открывается и отдаёт карточки', { skip }, async () => {
  queries = 0;
  const response = await get('/ru/series');
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /<link rel="canonical" href="\/ru\/series">/,
    'канонический адрес — базовый список, фильтры в него не попадают (R-SEO-02)');
  assert.ok(!/<meta name="robots"/.test(body),
    'непустой каталог индексируется: запрета индексации на нём нет');
  assert.match(body, /href="\/ru\/series\/[a-z0-9-]+"/, 'в выдаче есть карточки сериалов');

  assert.ok(queries <= 15, `к БД ${queries} запросов на страницу, бюджет 15`);
});

test('канонический адрес не меняется от фильтров', { skip }, async () => {
  const body = await (await get('/ru/series?genre=drama&sort=rating&page=2')).text();
  assert.match(body, /<link rel="canonical" href="\/ru\/series">/);
  // Заголовок — по шаблону SEO §2: середина страницы и бренд.
  assert.match(await (await get('/ru/series')).text(), /<title>Каталог сериалов · SigmaSeries<\/title>/);
});

test('постраничность — настоящие ссылки', { skip }, async () => {
  const body = await (await get('/ru/series')).text();

  assert.match(body, /href="\/ru\/series\?[^"]*page=2"/, 'есть ссылка на вторую страницу');
  assert.match(body, /href="\/ru\/series"/, 'есть ссылка на первую страницу без фильтров');
  const links = [...body.matchAll(/href="(\/ru\/series\?[^"]*)"/g)].map((match) => match[1]);
  assert.ok(links.length >= 2, `ссылок постраничности мало: ${links.join(', ')}`);
  // Текущая страница названа значением атрибута, а не экранированной строкой
  // — иначе слух слышит «"page"» вместе с кавычками (#168).
  assert.match(body, /class="pagination__item"[^>]*aria-current="page"/,
    'текущая страница названа для скринридера');
  assert.match(body, /class="sorts__item"[^>]*aria-current="true"/,
    'активная сортировка названа для скринридера');
});

test('страница за концом списка перенаправляется на последнюю', { skip }, async () => {
  const first = await (await get('/ru/series')).text();
  const total = Number(first.match(/data-total="(\d+)"/)?.[1] ?? 0);
  assert.ok(total > 24, 'в базе больше одной страницы, иначе проверка ничего не значит');

  const response = await get('/ru/series?page=99999');
  assert.equal(response.status, 301);
  assert.match(response.headers.get('location') ?? '', /\/ru\/series\?page=\d+$/);
});

test('недопустимая страница показывается как первая, а не как ошибка', { skip }, async () => {
  for (const value of ['0', 'abc', '-3', '1.5']) {
    const response = await get(`/ru/series?page=${value}`);
    assert.equal(response.status, 200, `page=${value}`);
    assert.match(await response.text(), /data-total="\d+"/);
  }
});

test('пустая выдача — noindex, «Сбросить» и подсказка', { skip }, async () => {
  const response = await get('/ru/series?genre=drama&state=cancelled&rating=9.9');
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /<meta name="robots" content="noindex, follow">/,
    'пустая выдача не индексируется (R-SEO-02)');
  assert.match(body, /\/ru\/series"/, 'есть ссылка «Сбросить» — базовый список');
  assert.match(body, /ratingFrom|rating/, 'подсказка называет фильтр, который стоит убрать');
});

test('мусор в адресе не попадает в страницу', { skip }, async () => {
  const response = await get('/ru/series?sort=%3Cscript%3Ealert(1)%3C%2Fscript%3E&genre=%3Cimg%20src=x%3E');
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.ok(!body.includes('<script>alert(1)'), 'значение сортировки не отражено как разметка');
  assert.ok(!body.includes('<img src=x'), 'значение жанра не отражено как разметка');
});

test('английский адрес отдаёт английские подписи', { skip }, async () => {
  const ruResponse = await get('/ru/series');
  const enResponse = await get('/en/series');
  const ru = await ruResponse.text();
  const en = await enResponse.text();

  assert.equal(enResponse.status, 200);
  assert.match(ru, /Найдено: \d+/, 'русская страница говорит по-русски');
  assert.match(en, /Found: \d+/, 'английская страница говорит по-английски');
});