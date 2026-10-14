// Прогон сопоставления: что происходит с тысячей кандидатов (F-12-02 §4, §5).
//
// Проверяется не сам API, а разбор его ответов: сколько запросов уходит на
// позицию, что попадает в исход и что теряется по дороге. Сбойный ответ
// изолируется — иначе одна неудача уносит весь прогон (F-12-09 §3: «сбой
// одного не останавливает остальных»).

import test from 'node:test';
import assert from 'node:assert/strict';

import { matchCandidates } from '../src/services/import/match.js';
import { IMPORT_SETTINGS } from '../src/config/settings.js';

const item = (tconst, startYear = 2008) => ({ tconst, startYear, title: 'X' });

/** Карточка TMDB с внешним идентификатором. */
const card = (imdbId, firstAirDate = '2008-01-20') => ({
  id: 1,
  first_air_date: firstAirDate,
  external_ids: { imdb_id: imdbId },
});

/** Заглушка клиента: по tconst отдаёт заранее заданный ответ. */
function fakeTmdb(answers) {
  const calls = [];
  return {
    calls,
    async findByImdbId(tconst) {
      calls.push(`find:${tconst}`);
      const answer = answers[tconst];
      if (!answer) return { tvResults: [], notFound: true };
      if (answer.fail) throw new Error(answer.fail);
      return { tvResults: answer.tv ?? [{ id: answer.id ?? 1, media_type: 'tv' }], notFound: false };
    },
    async getDetails(id) {
      calls.push(`details:${id}`);
      const answer = Object.values(answers).find((a) => (a.id ?? 1) === id);
      if (!answer) throw new Error(`нет заглушки для ${id}`);
      return answer.details;
    },
  };
}

test('пара находится и сохраняется', async () => {
  const tmdb = fakeTmdb({
    tt1: { id: 42, details: card('tt1') },
  });
  const results = await matchCandidates({ items: [item('tt1')], tmdb });
  assert.deepEqual(results, [{
    tconst: 'tt1',
    tmdbId: 42,
    outcome: 'ok',
    reasons: [],
  }]);
  assert.deepEqual(tmdb.calls, ['find:tt1', 'details:42'], 'детали запрашиваются один раз');
});

test('сериала нет в TMDB — исход no_tmdb, а не ошибка (EC-D1)', async () => {
  const results = await matchCandidates({ items: [item('tt_missing')], tmdb: fakeTmdb({}) });
  assert.equal(results[0].outcome, 'no_tmdb');
  assert.equal(results[0].tmdbId, null);
});

test('чужой обратный идентификатор — pair_doubt, tmdb_id не сохраняется (EC-I3)', async () => {
  const tmdb = fakeTmdb({ tt1: { id: 42, details: card('tt_other') } });
  const results = await matchCandidates({ items: [item('tt1')], tmdb });
  assert.equal(results[0].outcome, 'pair_doubt');
  assert.equal(results[0].tmdbId, null, 'сомнительный идентификатор сохранять нельзя');
  assert.deepEqual(results[0].reasons, ['reverse_id_mismatch']);
});

test('расхождение года больше одного года — pair_doubt (EC-D2)', async () => {
  const tmdb = fakeTmdb({ tt1: { id: 42, details: card('tt1', '2020-01-01') } });
  const results = await matchCandidates({ items: [item('tt1', 2008)], tmdb });
  assert.equal(results[0].outcome, 'pair_doubt');
  assert.deepEqual(results[0].reasons, ['year_mismatch']);
});

test('несколько сериалов в ответе /find выбирается по обратному идентификатору', async () => {
  const tmdb = fakeTmdb({
    tt1: {
      tv: [{ id: 10, media_type: 'tv' }, { id: 11, media_type: 'tv' }],
      details: undefined,
    },
  });
  // Детали для каждого кандидата задаются по id.
  tmdb.getDetails = async (id) => card(id === 11 ? 'tt1' : 'tt_other', id === 11 ? '2008-01-20' : '2015-01-01');

  const results = await matchCandidates({ items: [item('tt1')], tmdb });
  assert.equal(results[0].tmdbId, 11);
  assert.equal(results[0].outcome, 'ok');
});

test('ошибка сети на одной позиции не роняет прогон (F-12-09 §3)', async () => {
  const tmdb = fakeTmdb({
    tt_bad: { fail: 'сеть недоступна' },
    tt_good: { id: 7, details: card('tt_good') },
  });
  const results = await matchCandidates({ items: [item('tt_bad'), item('tt_good')], tmdb });
  assert.equal(results[0].outcome, 'error');
  assert.equal(results[1].outcome, 'ok');
  assert.equal(results[1].tmdbId, 7);
});

test('порядок результатов совпадает с порядком кандидатов', async () => {
  const many = Array.from({ length: 25 }, (_, i) => `tt${String(i).padStart(3, '0')}`);
  const answers = Object.fromEntries(many.map((t) => [t, { id: Number(t.slice(2)) + 1, details: card(t) }]));
  const results = await matchCandidates({
    items: many.map((t) => item(t)),
    tmdb: fakeTmdb(answers),
  });
  assert.deepEqual(results.map((r) => r.tconst), many);
});

test('одновременных запросов не больше import.api_concurrency', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `tt${String(i).padStart(3, '0')}`);
  const answers = Object.fromEntries(many.map((t) => [t, { id: 1, details: card(t) }]));
  const tmdb = fakeTmdb(answers);

  let inFlight = 0;
  let peak = 0;
  const wrap = async (call) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      return await call();
    } finally {
      inFlight -= 1;
    }
  };
  // Оригиналы берёмся до подмены: иначе обёртка вызывала бы саму себя.
  const realFind = tmdb.findByImdbId.bind(tmdb);
  const realDetails = tmdb.getDetails.bind(tmdb);
  tmdb.findByImdbId = (t) => wrap(() => realFind(t));
  tmdb.getDetails = (id) => wrap(() => realDetails(id));

  await matchCandidates({ items: many.map((t) => item(t)), tmdb });
  assert.ok(peak <= IMPORT_SETTINGS.apiConcurrency, `пик ${peak} при потолке ${IMPORT_SETTINGS.apiConcurrency}`);
  assert.ok(peak > 1, 'а параллельность вообще должна быть, иначе ограничение ничего не значит');
});

test('пустой список — пустой результат, без запросов', async () => {
  const tmdb = fakeTmdb({});
  assert.deepEqual(await matchCandidates({ items: [], tmdb }), []);
  assert.deepEqual(tmdb.calls, []);
});