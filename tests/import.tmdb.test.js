// F-12-02 «Сопоставление с TMDB». Тесты клиента и проверки пары.
// Спецификация: docs/01-product/features/M12-import.md, §4–§9; H-28; EC-D1, EC-D2, EC-I3, EC-I14.
//
// Настоящий API в тестах не вызывается никогда: `npm test` должен проходить
// без сети и без ключа, иначе прогон зелёный или красный по погоде, а не по
// коду. Проверка на живом API — это отдельный запуск `npm run import:match`.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  createTmdbClient,
  verifyPair,
  pickCandidate,
  yearOf,
  TmdbError,
} from '../src/services/import/tmdb.js';
import { IMPORT_SETTINGS } from '../src/config/settings.js';

// ─── Проверка пары (H-28) ──────────────────────────────────────────────────────

const details = (extra = {}) => ({
  id: 1396,
  name: 'Breaking Bad',
  first_air_date: '2008-01-20',
  external_ids: { imdb_id: 'tt0903747', tvdb_id: 81189 },
  ...extra,
});

test('пара подтверждается обратным идентификатором и годом', () => {
  const result = verifyPair({ tconst: 'tt0903747', startYear: 2008, details: details() });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'ok');
});

test('разница в годе до одного года — совпадение', () => {
  // Источники округляют по-разному: TMDB иногда ставит 2008, IMDb 2009.
  assert.equal(verifyPair({ tconst: 'tt1', startYear: 2009, details: details({ external_ids: { imdb_id: 'tt1' } }) }).ok, true);
});

test('расхождение года больше одного — сомнительная пара (EC-D2)', () => {
  // Разрыв ровно в два года — не абстрактный: так отбился «The Chosen» на
  // живом прогоне (IMDb 2017, TMDB 2019). Допуск в два года протащил бы его,
  // а вместе с ним любой сериал, у которого IMDb отсчитал год от пилота.
  const chosen = verifyPair({
    tconst: 'tt5622316',
    startYear: 2017,
    details: details({ first_air_date: '2019-04-21', external_ids: { imdb_id: 'tt5622316' } }),
  });
  assert.equal(chosen.ok, false);
  assert.equal(chosen.outcome, 'pair_doubt');
  assert.equal(chosen.reason, 'year_mismatch');

  const wide = verifyPair({
    tconst: 'tt0903747',
    startYear: 2008,
    details: details({ first_air_date: '2013-01-20' }),
  });
  assert.equal(wide.outcome, 'pair_doubt');
  assert.equal(wide.reason, 'year_mismatch');
});

test('обратный идентификатор указывает на другой tconst — данные не применяются (EC-I3)', () => {
  const result = verifyPair({
    tconst: 'tt0903747',
    startYear: 2008,
    details: details({ external_ids: { imdb_id: 'tt0000999' } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'pair_doubt');
  assert.equal(result.reason, 'reverse_id_mismatch');
});

test('отсутствие обратного идентификатора — сомнительная пара, а не «наверное подходит»', () => {
  const result = verifyPair({ tconst: 'tt1', startYear: 2008, details: details({ external_ids: {} }) });
  assert.equal(result.outcome, 'pair_doubt');
  assert.equal(result.reason, 'no_reverse_id');
});

test('название не участвует в проверке (H-28)', () => {
  // Два «расхождения» в спайке оказались разными локализациями: название
  // сверять нельзя, иначе параллельные и переименованные сериалы отсеивались
  // бы напрасно.
  const result = verifyPair({
    tconst: 'tt0903747',
    startYear: 2008,
    details: details({ name: 'Breaking Bad (сериал)' }),
  });
  assert.equal(result.ok, true);
});

test('год берётся из first_air_date, а не из года завершения', () => {
  assert.equal(yearOf('2008-01-20'), 2008);
  assert.equal(yearOf(''), null);
  assert.equal(yearOf(undefined), null);
});

test('без года IMDb проверка года не выполняется, но идентификатора достаточно', () => {
  const result = verifyPair({
    tconst: 'tt1',
    startYear: null,
    details: details({ external_ids: { imdb_id: 'tt1' }, first_air_date: null }),
  });
  assert.equal(result.ok, true);
});

// ─── Выбор кандидата из нескольких (§5) ───────────────────────────────────────

test('при единственном результате он и есть кандидат', async () => {
  const picked = await pickCandidate({ results: [{ id: 7, media_type: 'tv' }], getDetails: async () => ({}) });
  assert.equal(picked.tmdbId, 7);
  assert.equal(picked.outcome, 'ok');
});

test('из нескольких берётся тот, чей обратный идентификатор совпал', async () => {
  const answers = {
    7: { external_ids: { imdb_id: 'tt_other' } },
    8: { external_ids: { imdb_id: 'tt_wanted' } },
    9: { external_ids: { imdb_id: 'tt_third' } },
  };
  const picked = await pickCandidate({
    tconst: 'tt_wanted',
    results: [{ id: 7, media_type: 'tv' }, { id: 8, media_type: 'tv' }, { id: 9, media_type: 'tv' }],
    getDetails: async (id) => answers[id],
  });
  assert.equal(picked.tmdbId, 8);
  assert.equal(picked.outcome, 'ok');
});

test('если ни один обратный идентификатор не совпал — pair_doubt', async () => {
  const picked = await pickCandidate({
    tconst: 'tt_wanted',
    results: [{ id: 7, media_type: 'tv' }, { id: 8, media_type: 'tv' }],
    getDetails: async (id) => ({ external_ids: { imdb_id: `tt_${id}` } }),
  });
  assert.equal(picked.tmdbId, null);
  assert.equal(picked.outcome, 'pair_doubt');
  assert.equal(picked.reason, 'ambiguous');
});

test('кино и люди из ответа /find игнорируются', async () => {
  const picked = await pickCandidate({
    results: [
      { id: 1, media_type: 'movie' },
      { id: 2, media_type: 'person' },
      { id: 3, media_type: 'tv' },
    ],
    getDetails: async () => ({ external_ids: { imdb_id: 'tt1' } }),
  });
  assert.equal(picked.tmdbId, 3);
});

test('пустой ответ — это no_tmdb, а не сомнение (EC-D1)', async () => {
  const picked = await pickCandidate({ results: [], getDetails: async () => ({}) });
  assert.equal(picked.outcome, 'no_tmdb');
  assert.equal(picked.tmdbId, null);
});

// ─── Клиент: адрес, авторизация, коды ответа ──────────────────────────────────

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/** Клиент с выключенными паузами: тесты не должны ждать реальные секунды. */
const client = (baseUrl, extra = {}) => createTmdbClient({
  baseUrl,
  token: 'токен',
  sleep: async () => {},
  rps: 1000,
  ...extra,
});

test('поиск идёт по адресу /find с внешним источником imdb_id', async () => {
  let seen = null;
  const { server, baseUrl } = await serve((req, res) => {
    seen = req.url;
    json(res, 200, { tv_results: [] });
  });
  try {
    // Длинный токен — v4: ключ уходит в заголовок, и в адресе остаётся
    // ровно один параметр. Иначе сюда подмешался бы ещё и api_key.
    const api = client(baseUrl, { token: `ey${'a'.repeat(200)}` });
    await api.findByImdbId('tt0903747');
    assert.match(seen, /^\/find\/tt0903747\?external_source=imdb_id$/);
  } finally {
    server.close();
  }
});

test('ключ длинный (v4) идёт в заголовке Bearer, короткий (v3) — в параметре', async () => {
  const seen = [];
  const { server, baseUrl } = await serve((req, res) => {
    seen.push({ auth: req.headers.authorization ?? null, url: req.url });
    json(res, 200, { tv_results: [] });
  });
  try {
    await client(baseUrl, { token: `ey${'a'.repeat(200)}` }).findByImdbId('tt1');
    assert.match(seen[0].auth, /^Bearer /);
    await client(baseUrl, { token: 'a'.repeat(32) }).findByImdbId('tt1');
    assert.equal(seen[1].auth, null);
    assert.match(seen[1].url, /api_key=/);
  } finally {
    server.close();
  }
});

test('401 прерывает запуск сразу: ключ неверный (F-12-09 §3)', async () => {
  let hits = 0;
  const { server, baseUrl } = await serve((_req, res) => {
    hits += 1;
    json(res, 401, { status_message: 'Invalid API key' });
  });
  try {
    const api = client(baseUrl);
    await assert.rejects(() => api.findByImdbId('tt1'), /неверный ключ|401/);
    assert.equal(hits, 1, 'повторов быть не должно: ключ не станет вернее от попытки');
  } finally {
    server.close();
  }
});

test('404 на /find — это no_tmdb, а не сбой (EC-D1)', async () => {
  const { server, baseUrl } = await serve((_req, res) => json(res, 404, { status_message: 'not found' }));
  try {
    const api = client(baseUrl);
    const found = await api.findByImdbId('tt_missing');
    assert.deepEqual(found.tvResults, []);
    assert.equal(found.notFound, true);
  } finally {
    server.close();
  }
});

test('429 ждёт Retry-After и повторяет (F-12-09 §3)', async () => {
  const waits = [];
  let hits = 0;
  const { server, baseUrl } = await serve((_req, res) => {
    hits += 1;
    if (hits === 1) return json(res, 429, { status_message: 'slow down' }, { 'retry-after': '3' });
    return json(res, 200, { tv_results: [{ id: 1, media_type: 'tv' }] });
  });
  try {
    const api = client(baseUrl, { sleep: async (ms) => waits.push(ms) });
    const found = await api.findByImdbId('tt1');
    assert.equal(hits, 2);
    assert.deepEqual(waits, [3250], 'Retry-After в секундах плюс 250 мс');
    assert.equal(found.tvResults.length, 1);
  } finally {
    server.close();
  }
});

test('5xx повторяется с задержкой по расписанию 1, 2, 4, 8, 16 с', async () => {
  const waits = [];
  let hits = 0;
  const { server, baseUrl } = await serve((_req, res) => {
    hits += 1;
    if (hits <= 3) return json(res, 503, { status_message: 'busy' });
    return json(res, 200, { tv_results: [] });
  });
  try {
    const api = client(baseUrl, { sleep: async (ms) => waits.push(ms) });
    await api.findByImdbId('tt1');
    assert.equal(hits, 4);
    assert.deepEqual(waits, [1000, 2000, 4000]);
  } finally {
    server.close();
  }
});

test('пять попыток — и сдача: дальше ошибка (F-12-09 §9)', async () => {
  let hits = 0;
  const { server, baseUrl } = await serve((_req, res) => {
    hits += 1;
    json(res, 500, { status_message: 'down' });
  });
  try {
    await assert.rejects(() => client(baseUrl).findByImdbId('tt1'), TmdbError);
    assert.equal(hits, 5);
  } finally {
    server.close();
  }
});

test('детали сериала запрашиваются вместе с внешними идентификаторами', async () => {
  let seen = null;
  const { server, baseUrl } = await serve((req, res) => {
    seen = req.url;
    json(res, 200, { id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20', external_ids: { imdb_id: 'tt0903747' } });
  });
  try {
    const card = await client(baseUrl).getDetails(1396);
    assert.match(seen, /^\/tv\/1396\?/);
    assert.match(seen, /append_to_response=external_ids/);
    assert.equal(card.external_ids.imdb_id, 'tt0903747');
  } finally {
    server.close();
  }
});

test('пауза между запросами держит import.rps', async () => {
  const waits = [];
  const { server, baseUrl } = await serve((_req, res) => json(res, 200, { tv_results: [] }));
  try {
    const api = client(baseUrl, { rps: IMPORT_SETTINGS.rps, sleep: async (ms) => waits.push(ms) });
    await api.findByImdbId('tt1');
    await api.findByImdbId('tt2');
    await api.findByImdbId('tt3');
    // Перед первым запросом паузы нет: задерживать старт незачем.
    assert.equal(waits.length, 2, 'пауза между запросами, а не перед каждым');
    assert.ok(waits.every((ms) => Math.abs(ms - 100) < 20), `ожидалось около 100 мс, получено ${waits}`);
  } finally {
    server.close();
  }
});