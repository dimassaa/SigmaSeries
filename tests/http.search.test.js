// Страница результатов поиска и подсказки (F-02-06, S-17).
//
// Проверяется то, что видит человек: код ответа, `noindex` (страница поиска в
// индексе не нужна — это `SCREENS`), экранирование запроса и то, что при
// неудачном запросе страница предлагает, а не молчит.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { pgSearch } from '../src/services/search/service.js';
import { searchSettings } from '../src/services/search/limits.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — HTTP-слой поиска не проверялся';

let pool;
let server;
let baseUrl;

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
  // Лимит берётся из настроек, как в `server.js`: иначе проверка лимита
  // проверяла бы число из кода, а не то, что поставил бы админ.
  const { ratePerIp } = await searchSettings(pool);
  const app = createApp({ data: stubData(), search: pgSearch(pool), searchRatePerIp: ratePerIp });
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

const get = (path) => fetch(`${baseUrl}${path}`);

async function anyTitle() {
  const { rows } = await pool.query(
    "SELECT title_ru FROM e_series WHERE publication_state = 'published' AND title_ru IS NOT NULL LIMIT 1",
  );
  return rows[0].title_ru;
}

test('страница поиска не индексируется и отвечает 200', { skip }, async () => {
  const response = await get('/ru/search');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<meta name="robots" content="noindex, follow">/,
    'пустой запрос не должен попасть в индекс (SCREENS §9)');
});

test('найденный сериал показан и ведёт на свою карточку', { skip }, async () => {
  const title = await anyTitle();
  const response = await get(`/ru/search?q=${encodeURIComponent(title)}`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.ok(/href="\/ru\/series\/[^"]+"/.test(body), 'в выдаче есть ссылка на карточку');
  assert.ok(body.includes(title.split(' ')[0].slice(0, 6)),
    `название «${title}» должно быть в выдаче`);
});

test('запрос не находит — страница предлагает, а не молчит (EC-K10)', { skip }, async () => {
  const response = await get('/ru/search?q=%D0%BA%D0%B2%D0%B0%D0%BD%D1%82%D0%BE%D0%B2%D0%B0%D1%8F%20%D1%84%D0%B8%D0%B7%D0%B8%D0%BA%D0%B0');
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /empty-state/, 'есть пустое состояние');
  assert.match(body, /catalog\.empty|search\.empty|genres/, 'подсказка названа или предложены жанры');
});

test('мусор в запросе не исполняется и не отражается как разметка', { skip }, async () => {
  const response = await get('/ru/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.ok(!body.includes('<script>alert(1)'), 'запрос не стал разметкой');
});

test('подсказки отдаются данными, а не разметкой (R-PERF, XHR)', { skip }, async () => {
  const title = await anyTitle();
  const response = await get(`/ru/search/suggest?q=${encodeURIComponent(title.slice(0, 4))}`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const data = await response.json();
  assert.ok(Array.isArray(data.series));
  assert.ok(Array.isArray(data.people));
  assert.ok(Array.isArray(data.collections));
});

test('один символ подсказок не возвращает (§2)', { skip }, async () => {
  const response = await get('/ru/search/suggest?q=а');
  const data = await response.json();

  assert.deepEqual(data.series, []);
  assert.deepEqual(data.people, []);
});

test('лимит частоты поиска отвечает 429, а не кладёт базу (R-SEC-31)', { skip }, async () => {
  const { ratePerIp: limit } = await searchSettings(pool);
  assert.ok(limit > 0);

  let limited = false;
  for (let i = 0; i < limit + 5; i += 1) {
    const response = await get('/ru/search?q=test');
    if (response.status === 429) {
      limited = true;
      assert.ok(response.headers.get('retry-after'), '429 обязан говорить, когда повторить');
      break;
    }
  }
  assert.ok(limited, `после ${limit} запросов должен появиться 429`);
});
// ─── Найденное, показанное и продолжение (#120, #121) ─────────────────────────

test('счётчик обещает больше, чем показано, и группа листается', { skip }, async () => {
  // Свой сервер: общий уже исчерпан проверкой лимита частоты, и листание
  // упало бы не на «показать ещё», а на 429.
  const app = createApp({
    data: stubData(),
    search: pgSearch(pool),
    searchRatePerIp: 1000,
  });
  const own = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const ownBase = `http://127.0.0.1:${own.address().port}`;
  const ownGet = (path) => fetch(`${ownBase}${path}`);

  // Фикстур больше, чем страница поиска (24): иначе ссылка «показать ещё» не
  // появилась бы и проверка прошла бы на пустом месте.
  const word = `проверкапоиска${crypto.randomUUID().slice(0, 8)}`;
  const { rows } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     SELECT 'sr-' || i || '-' || substr(md5(random()::text), 1, 8),
            $1 || ' ' || i, 'Shared ' || i, $2 + i, 'published', 'airing', 2023
       FROM generate_series(1, 26) AS i
     RETURNING id`,
    [word, 988_000_000],
  );
  const ids = rows.map((row) => row.id);

  try {
    const first = await (await ownGet(`/ru/search?q=${encodeURIComponent(word)}`)).text();

    assert.match(first, /Найдено: 26/, 'счётчик считает найденное, а не показанное');
    assert.equal((first.match(/class="posters__item"/g) ?? []).length, 24,
      'показана ровно страница, а не всё найденное');

    const more = /href="([^"]+)"\s+data-more="series"/.exec(first);
    assert.ok(more, 'у группы сериалов есть ссылка «показать ещё»');
    // Ссылка приходит HTML-экранированной (`&amp;`), поэтому сперва приводится
    // к тому виду, в котором её увидит адресная строка.
    const href = more[1].replaceAll('&amp;', '&');
    // Двоеточие в ссылке экранируется — браузер и человек видят одно и то же,
    // поэтому проверка принимает обе записи.
    assert.match(href, /from=series(?::|%3A)24/, 'смещение в адресе: страницу можно переслать');

    const second = await (await ownGet(`/ru/search?q=${encodeURIComponent(word)}&from=series:24`)).text();
    assert.match(second, /Найдено: 26/, 'счётчик остаётся тем же — он про найденное');
    assert.equal((second.match(/class="posters__item"/g) ?? []).length, 2,
      'на второй странице осталось две записи');

    const last = await (await ownGet(`/ru/search?q=${encodeURIComponent(word)}&from=series:25`)).text();
    assert.equal((last.match(/class="posters__item"/g) ?? []).length, 1, 'последняя запись показана');
    assert.ok(!/data-more="series"/.test(last),
      'на последней записи ссылки «показать ещё» нет — она вела бы в пустоту');

    const junk = await (await ownGet(`/ru/search?q=${encodeURIComponent(word)}&from=series:abc&from=people:-5`)).text();
    assert.match(junk, /Найдено: 26/, 'мусор в смещении не ломает выдачу и не обнуляет её');
  } finally {
    await pool.query('DELETE FROM e_series WHERE id = ANY($1::bigint[])', [ids]);
    await new Promise((resolve) => own.close(resolve));
  }
});
