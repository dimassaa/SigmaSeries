// Обогащение из TMDB (F-12-03): что из ответа источника годится, а что нет.
//
// Проверяется не «пришёл ли ответ», а то, что в него попадёт: ограничения
// длины (R-SEC-13, R-SEC-15), выбор возрастной метки (H-25), сезоны без
// дат и сезон 0 (H-38). Ошибки здесь всплывают на карточке сериала, а не на
// прогоне импорта.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRawSeries,
  cleanText,
  clampText,
  normalizeSeason,
  pickAgeRating,
  enrichSeries,
  enrichAll,
  LIMITS,
} from '../src/services/import/enrich.js';

const imdb = (extra = {}) => ({
  tconst: 'tt0903747',
  startYear: 2008,
  endYear: 2013,
  genres: ['Drama', 'Crime'],
  numVotes: 2_690_742,
  averageRating: 9.5,
  ...extra,
});

const details = (extra = {}) => ({
  id: 1396,
  name: 'Во все тяжкие',
  original_name: 'Breaking Bad',
  overview: 'Описание',
  status: 'Ended',
  first_air_date: '2008-01-20',
  last_air_date: '2013-09-29',
  genres: [{ id: 18, name: 'Drama' }, { id: 80, name: 'Crime' }],
  ...extra,
});

// ─── Ограничения длины (F-12-03 §9, R-SEC-15) ────────────────────────────────

test('слишком длинное название обрезается и это видно', () => {
  const long = 'я'.repeat(LIMITS.title + 100);
  const result = clampText(long, LIMITS.title);
  assert.equal(result.text.length, LIMITS.title);
  assert.equal(result.truncated, true, 'усечённое не должно выглядеть как целое');
});

test('обычный текст не трогается', () => {
  assert.deepEqual(clampText('Breaking Bad', LIMITS.title), { text: 'Breaking Bad', truncated: false });
  assert.deepEqual(clampText(undefined, LIMITS.title), { text: '', truncated: false });
});

test('разметка из источника вычищается', () => {
  const result = cleanText('Сериал <i>про</i> <a href="/x">здесь</a>', LIMITS.description);
  assert.equal(result.text, 'Сериал про здесь');
  assert.equal(result.truncated, true, 'вычистка тоже обрезка, и её надо заметить');
});

// ─── Сборка сырого слоя ──────────────────────────────────────────────────────

test('русское описание вытесняет английское', () => {
  const raw = buildRawSeries({
    detailsRu: details(),
    detailsEn: details({ name: 'Breaking Bad', overview: 'English overview' }),
    imdb: imdb(),
  });
  assert.equal(raw.descriptions.ru.text, 'Описание');
  assert.equal(raw.descriptions.en.text, '', 'два описания хранить незачем, если русское есть');
});

test('без русского описания остаётся английское', () => {
  const raw = buildRawSeries({
    detailsRu: details({ overview: '' }),
    detailsEn: details({ overview: 'English overview' }),
    imdb: imdb(),
  });
  assert.equal(raw.descriptions.ru.text, '');
  assert.equal(raw.descriptions.en.text, 'English overview');
});

test('годы берутся из IMDb, а не из TMDB', () => {
  const raw = buildRawSeries({
    detailsRu: details({ first_air_date: '2008-01-20' }),
    imdb: imdb(),
  });
  assert.equal(raw.years.start, 2008);
  assert.equal(raw.years.end, 2013);
});

test('статус и ближайшая серия попадают в слой', () => {
  const raw = buildRawSeries({
    detailsRu: details({
      status: 'Returning Series',
      next_episode_to_air: { season_number: 5, episode_number: 1, air_date: '2026-11-01' },
    }),
    imdb: imdb({ endYear: null }),
  });
  assert.equal(raw.status, 'Returning Series');
  assert.deepEqual(raw.nextEpisode, { season: 5, number: 1, date: '2026-11-01' });
});

// ─── Возрастная метка (H-25, EC-D13) ──────────────────────────────────────────

test('метка RU/BY предпочтительнее прочих стран', () => {
  const picked = pickAgeRating([
    { iso_3166_1: 'US', rating: 'TV-MA' },
    { iso_3166_1: 'RU', rating: '18' },
  ]);
  assert.equal(picked.code, 'RU');
});

test('если RU/BY нет, берётся первая доступная', () => {
  assert.equal(pickAgeRating([{ iso_3166_1: 'US', rating: 'TV-MA' }]).rating, 'TV-MA');
});

test('отсутствие метки — это отсутствие, а не ноль', () => {
  assert.equal(pickAgeRating([]), null);
  assert.equal(pickAgeRating(undefined), null);
});

// ─── Сезоны (H-38) ───────────────────────────────────────────────────────────

test('сезон нормализуется вместе с сериями', () => {
  const season = normalizeSeason({
    season_number: 1,
    name: 'Первый сезон',
    overview: 'Описание сезона',
    episodes: [
      { episode_number: 1, name: 'Пилот', overview: '', air_date: '2008-01-20', runtime: 58 },
      { episode_number: 2, name: '…', overview: '', air_date: null, runtime: null },
    ],
  });
  assert.equal(season.number, 1);
  assert.equal(season.titleRu.text, 'Первый сезон');
  assert.equal(season.episodes.length, 2);
  assert.equal(season.episodes[0].date, '2008-01-20');
  assert.equal(season.episodes[1].date, null, 'серия без даты — обычное дело, а не ошибка');
});

test('сезон без серий не ломает слой', () => {
  const season = normalizeSeason({ season_number: 3, name: 'Пустой', episodes: undefined });
  assert.deepEqual(season.episodes, []);
});

// ─── Обогащение одного сериала ───────────────────────────────────────────────

test('сериал обогащается карточкой и сезонами', async () => {
  const seen = [];
  const tmdb = {
    async getDetailsLocalized(id, language) {
      seen.push(`details:${id}:${language}`);
      return details({ seasons: [{ season_number: 0 }, { season_number: 1 }, { season_number: 2 }] });
    },
    async getSeason(id, number, language) {
      seen.push(`season:${id}:${number}`);
      return { season_number: number, name: `Сезон ${number}`, episodes: [] };
    },
  };

  const raw = await enrichSeries({ tmdbId: 1396, imdb: imdb(), tmdb });

  assert.equal(raw.tmdbId, 1396);
  assert.equal(raw.seasons.length, 2, 'спецвыпуски (0) в прогон не входят');
  assert.deepEqual(raw.seasons.map((s) => s.number), [1, 2]);
  assert.ok(seen.includes('details:1396:ru-RU'));
  assert.ok(seen.includes('details:1396:en-US'));
});

test('упавший сезон не роняет сериал', async () => {
  // F-12-03 §5: сезон помечается «не загружен» и повторится в следующем прогоне.
  const tmdb = {
    async getDetailsLocalized() {
      return details({ seasons: [{ season_number: 1 }, { season_number: 2 }] });
    },
    async getSeason(id, number) {
      if (number === 1) throw new Error('сеть недоступна');
      return { season_number: 2, name: 'Второй', episodes: [] };
    },
  };
  const raw = await enrichSeries({ tmdbId: 1, imdb: imdb(), tmdb });
  assert.deepEqual(raw.seasons.map((s) => s.number), [2]);
});

test('список сериалов обогащается с сохранением порядка', async () => {
  const tmdb = {
    async getDetailsLocalized(id) {
      if (id === 2) throw new Error('сеть недоступна');
      return details({ id });
    },
    async getSeason() {
      return { season_number: 1, name: 'Сезон', episodes: [] };
    },
  };
  const out = await enrichAll({
    items: [
      { tmdbId: 1, imdb: imdb() },
      { tmdbId: 2, imdb: imdb() },
      { tmdbId: 3, imdb: imdb() },
    ],
    tmdb,
  });

  assert.equal(out[0].raw.tmdbId, 1);
  assert.equal(out[1].raw, null);
  assert.match(out[1].error, /сеть/);
  assert.equal(out[2].raw.tmdbId, 3, 'один сбой не должен съесть остальные');
});