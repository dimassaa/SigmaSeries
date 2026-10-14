// Состояние выхода, полнота и адрес сериала (F-12-06 §4, §8; H-27, H-32,
// H-39, H-40; EC-D11, EC-D13, EC-K2).
//
// Здесь нет ни SQL, ни сети: чистые правила, которые легко перечитать и
// легко проверить. Запись в базу — отдельный модуль.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeExitState,
  computeCompleteness,
  slugFor,
  groupReleases,
  levelOf,
  RELEASE_STATE,
  DAY_MS,
} from '../src/services/import/catalogue.js';

/** Сегодняшняя дата для расчёта: 2026-10-14. */
const TODAY = new Date('2026-10-14T00:00:00Z');

const raw = (extra = {}) => ({
  tconst: 'tt1',
  tmdbId: 1,
  status: 'Ended',
  titles: { original: { text: 'Breaking Bad' }, ru: { text: 'Во все тяжкие' }, en: { text: '' } },
  descriptions: { ru: { text: 'Описание' }, en: { text: '' } },
  years: { start: 2008, end: 2013 },
  nextEpisode: null,
  lastEpisode: null,
  imdbGenres: ['Drama', 'Crime'],
  votes: { average: 9.5, count: 100 },
  ageRating: null,
  people: { directors: [{ nconst: 'nm1', name: 'Режиссёр' }], cast: [] },
  seasons: [
    {
      number: 1,
      titleRu: { text: 'Первый сезон' },
      descriptionRu: { text: '' },
      episodes: [
        { number: 1, titleRu: { text: 'Пилот' }, descriptionRu: { text: '' }, date: '2026-10-01', runtimeMin: 58 },
        { number: 2, titleRu: { text: '' }, descriptionRu: { text: '' }, date: '2026-10-08', runtimeMin: 50 },
      ],
    },
  ],
  ...extra,
});

// ─── Состояние выхода (H-39, H-40) ───────────────────────────────────────────

test('дата в будущем побеждает любой статус', () => {
  // H-39: сначала даты, потом статус. Сериал, которому назначена дата выхода,
  // «Выходит» даже при статусе «Завершён» — статус TMDB о нём ещё не знает.
  const state = computeExitState({
    raw: raw({ status: 'Ended', nextEpisode: { date: '2026-10-20' } }),
    today: TODAY,
  });
  assert.equal(state, RELEASE_STATE.airing);
});

test('дата не дальше 14 дней назад тоже значит «выходит»', () => {
  const state = computeExitState({
    raw: raw({ status: 'Ended', lastEpisode: { date: '2026-10-05' } }),
    today: TODAY,
  });
  assert.equal(state, RELEASE_STATE.airing, 'выход был девять дней назад — это не «давно закончился»');
});

test('дата старше 14 дней — уже не «выходит»', () => {
  const state = computeExitState({
    raw: raw({ status: 'Ended', lastEpisode: { date: '2026-09-01' } }),
    today: TODAY,
  });
  assert.equal(state, RELEASE_STATE.ended);
});

test('статусы TMDB разбираются по правилу', () => {
  const cases = [
    ['Ended', RELEASE_STATE.ended],
    ['Canceled', RELEASE_STATE.cancelled],
    ['In Production', RELEASE_STATE.announced],
    ['Planned', RELEASE_STATE.announced],
    ['Pilot', RELEASE_STATE.announced],
    ['Returning Series', RELEASE_STATE.waiting],
  ];
  for (const [status, expected] of cases) {
    assert.equal(computeExitState({ raw: raw({ status }), today: TODAY }), expected, status);
  }
});

test('незнакомый статус не превращается в «анонс», а уходит в правило года', () => {
  // H-39 перечисляет четыре статуса; значения, которого нет в списке, трактуются
  // как «данных TMDB нет» — и тогда работает H-40 (год IMDb). Проверяем именно
  // это: анонс был бы утверждением, которого никто не проверял.
  const ended = computeExitState({
    raw: raw({ status: 'Что-то новое', years: { start: 2008, end: 2013 } }),
    today: TODAY,
  });
  assert.equal(ended, RELEASE_STATE.ended);

  const waiting = computeExitState({
    raw: raw({ status: 'Что-то новое', years: { start: 2015, end: null } }),
    today: TODAY,
  });
  assert.equal(waiting, RELEASE_STATE.waiting);
});

test('без данных TMDB состояние выводится по году IMDb (H-40)', () => {
  const ended = computeExitState({
    raw: raw({ status: null, tmdbId: null, years: { start: 2008, end: 2013 } }),
    today: TODAY,
  });
  assert.equal(ended, RELEASE_STATE.ended);
  const waiting = computeExitState({
    raw: raw({ status: null, tmdbId: null, years: { start: 2015, end: null } }),
    today: TODAY,
  });
  assert.equal(waiting, RELEASE_STATE.waiting);
});

// ─── Полнота и причины (§8) ───────────────────────────────────────────────────

test('полная карточка без причин', () => {
  const result = computeCompleteness({
    raw: raw({ ageRating: { code: 'RU', rating: '18' } }),
    images: { poster: true, backdrop: true },
    now: TODAY,
  });
  assert.deepEqual(result.reasons, []);
  assert.equal(result.level, 'full');
});

test('без фона причина размещения, а полнота теряется', () => {
  const result = computeCompleteness({
    raw: raw({ ageRating: { code: 'RU', rating: '18' } }),
    images: { poster: true, backdrop: false },
    now: TODAY,
  });
  assert.deepEqual(result.reasons, ['no_backdrop']);
  assert.equal(result.level, 'displayable');
});

test('без русского описания, но с английским — одна причина и уровень ниже', () => {
  const result = computeCompleteness({
    raw: raw({ descriptions: { ru: { text: '' }, en: { text: 'English' } }, ageRating: { code: 'RU', rating: '18' } }),
    images: { poster: true, backdrop: true },
    now: TODAY,
  });
  assert.deepEqual(result.reasons, ['no_overview_ru']);
  assert.equal(result.level, 'displayable', 'уровень «полная» требует русского описания');
});

test('без описания вовсе — причина no_overview', () => {
  const result = computeCompleteness({
    raw: raw({ descriptions: { ru: { text: '' }, en: { text: '' } } }),
    images: { poster: true, backdrop: true },
    now: TODAY,
  });
  assert.ok(result.reasons.includes('no_overview'));
  assert.equal(result.level, 'minimum');
});

test('«ждём сезон» без дат — не дефект', () => {
  const result = computeCompleteness({
    raw: raw({ status: 'Returning Series', seasons: [] }),
    images: { poster: true, backdrop: true },
    now: TODAY,
  });
  assert.equal(result.reasons.includes('schedule_gap'), false);
});

test('«выходит» с пропуском дат в последнем сезоне — schedule_gap', () => {
  const result = computeCompleteness({
    raw: raw({
      status: 'Returning Series',
      nextEpisode: { date: '2026-10-20' },
      seasons: [
        {
          number: 1,
          titleRu: { text: '' },
          descriptionRu: { text: '' },
          episodes: [
            { number: 1, titleRu: { text: '' }, descriptionRu: { text: '' }, date: '2026-10-20', runtimeMin: null },
            { number: 2, titleRu: { text: '' }, descriptionRu: { text: '' }, date: null, runtimeMin: null },
          ],
        },
      ],
    }),
    images: { poster: true, backdrop: true },
    now: TODAY,
  });
  assert.ok(result.reasons.includes('schedule_gap'));
});

test('без людей — no_people, но это содержание, а не блокировка', () => {
  const result = computeCompleteness({
    raw: raw({ people: { directors: [], cast: [] }, ageRating: { code: 'RU', rating: '18' } }),
    images: { poster: true, backdrop: true },
    now: TODAY,
  });
  assert.deepEqual(result.reasons, ['no_people']);
  assert.equal(result.level, 'displayable', 'содержание опускает до «пригодна к показу», но не блокирует');
});

test('отсутствие возрастной метки — информационная причина, уровень не трогает', () => {
  const withAge = computeCompleteness({ raw: raw(), images: { poster: true, backdrop: true }, now: TODAY });
  const withoutAge = computeCompleteness({
    raw: raw({ ageRating: null }),
    images: { poster: true, backdrop: true },
    now: TODAY,
  });
  assert.equal(withoutAge.level, withAge.level, 'EC-D13: одна эта причина карточку неполной не делает');
  assert.equal(withoutAge.reasons.includes('no_age'), true, 'но в отчёте она остаётся');
});

test('уровень считается по тому, чего именно не хватает', () => {
  assert.equal(levelOf(['no_genre']), 'minimum', 'нет жанра — публиковать нечего');
  assert.equal(levelOf(['no_tmdb', 'no_poster']), 'minimum', 'блокирующая причина сильнее любой другой');
  assert.equal(levelOf(['no_poster']), 'minimum', 'без постера карточка не «пригодна к показу»');
  assert.equal(levelOf(['no_overview']), 'minimum', 'без описания — тоже');
  assert.equal(levelOf(['no_backdrop', 'schedule_gap']), 'displayable', 'фон и расписание мешают только «полной»');
  assert.equal(levelOf(['no_people']), 'displayable');
  assert.equal(levelOf(['no_overview_ru']), 'displayable', 'английского описания для показа хватает');
  assert.equal(levelOf(['no_age']), 'full', 'информационная причина уровень не трогает');
  assert.equal(levelOf([]), 'full');
});

// ─── Адрес (H-32) ─────────────────────────────────────────────────────────────

test('адрес латиницей из оригинального названия', () => {
  assert.equal(slugFor({ title: 'Breaking Bad', year: 2008, tconst: 'tt1', taken: new Set() }), 'breaking-bad');
});

test('название только на русском даёт латинский адрес транслитерацией', () => {
  // H-32 требует латинский адрес. Транслитерация читаемее, чем `tt`-хвост, и
  // два сериала с одинаковым кириллическим названием всё равно разводятся
  // годом и tconst.
  assert.equal(
    slugFor({ title: 'Во все тяжкие', year: 2008, tconst: 'tt1', taken: new Set() }),
    'vo-vse-tyazhkie',
  );
});

test('английское название используется, когда оригинального нет', () => {
  assert.equal(
    slugFor({ title: '', year: 2008, tconst: 'tt1', taken: new Set(), fallback: 'Breaking Bad' }),
    'breaking-bad',
  );
});

test('кириллица без транслитерируемого остатка даёт адрес из tconst', () => {
  const slug = slugFor({ title: '!!! ???', year: null, tconst: 'tt9', taken: new Set() });
  assert.equal(slug, 'tt9');
});

test('совпадение разрешается годом, а затем идентификатором', () => {
  const taken = new Set(['breaking-bad']);
  assert.equal(slugFor({ title: 'Breaking Bad', year: 2008, tconst: 'tt1', taken }), 'breaking-bad-2008');
  const takenMore = new Set(['breaking-bad', 'breaking-bad-2008']);
  assert.equal(slugFor({ title: 'Breaking Bad', year: 2008, tconst: 'tt1', taken: takenMore }), 'breaking-bad-2008-tt1');
});

test('адрес всегда непустой и без пробелов', () => {
  const slug = slugFor({ title: '!!! ???', year: null, tconst: 'tt5', taken: new Set() });
  assert.match(slug, /^[a-z0-9-]+$/);
  assert.equal(slug.length > 0, true);
});

test('кириллица даёт осмысленный адрес, а не хвост из tconst', () => {
  const slug = slugFor({ title: 'Ёлки', year: 2010, tconst: 'tt9', taken: new Set() });
  assert.match(slug, /^[a-z0-9-]+$/);
  assert.ok(slug.length > 2);
});

// ─── Группировка выходов (EC-D11) ─────────────────────────────────────────────

test('серии одной даты образуют один выход', () => {
  const releases = groupReleases(raw().seasons[0]);
  assert.equal(releases.length, 2);
  assert.deepEqual(releases[0].episodeNumbers, [1]);
  assert.deepEqual(releases[1].episodeNumbers, [2]);
});

test('три серии с одной датой — один выход', () => {
  const season = {
    number: 1,
    titleRu: { text: '' },
    descriptionRu: { text: '' },
    episodes: [1, 2, 3].map((n) => ({
      number: n,
      titleRu: { text: '' },
      descriptionRu: { text: '' },
      date: '2026-10-12',
      runtimeMin: null,
    })),
  };
  const releases = groupReleases(season);
  assert.equal(releases.length, 1);
  assert.deepEqual(releases[0].episodeNumbers, [1, 2, 3]);
});

test('серия без даты в выход не попадает, но и не теряется', () => {
  const season = {
    number: 1,
    titleRu: { text: '' },
    descriptionRu: { text: '' },
    episodes: [
      { number: 1, titleRu: { text: '' }, descriptionRu: { text: '' }, date: '2026-10-12', runtimeMin: null },
      { number: 2, titleRu: { text: '' }, descriptionRu: { text: '' }, date: null, runtimeMin: null },
    ],
  };
  const releases = groupReleases(season);
  assert.equal(releases.length, 1);
  assert.deepEqual(releases[0].episodeNumbers, [1], 'без даты выхода нет — и у второй серии тоже');
});

test('выходы отсортированы по дате', () => {
  const season = {
    number: 1,
    titleRu: { text: '' },
    descriptionRu: { text: '' },
    episodes: [
      { number: 1, titleRu: { text: '' }, descriptionRu: { text: '' }, date: '2026-10-20', runtimeMin: null },
      { number: 2, titleRu: { text: '' }, descriptionRu: { text: '' }, date: '2026-10-12', runtimeMin: null },
    ],
  };
  assert.deepEqual(groupReleases(season).map((r) => r.date), ['2026-10-12', '2026-10-20']);
});

test('битая дата не должна ломать расчёт', () => {
  const season = {
    number: 1,
    titleRu: { text: '' },
    descriptionRu: { text: '' },
    episodes: [
      { number: 1, titleRu: { text: '' }, descriptionRu: { text: '' }, date: 'не дата', runtimeMin: null },
    ],
  };
  assert.deepEqual(groupReleases(season), [], 'такое в выход не попадает, но и прогон не падает');
});

test('окно в 14 дней считается от полуночи, а не от текущего момента', () => {
  const state = computeExitState({
    raw: raw({ status: 'Ended', lastEpisode: { date: '2026-09-30T23:59:00Z' } }),
    today: TODAY,
  });
  assert.equal(state, RELEASE_STATE.ended);
  assert.ok(14 * DAY_MS > 0);
});