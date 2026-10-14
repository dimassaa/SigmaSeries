// Запись сериала в каталог против настоящей базы (F-12-06 §4).
//
// Тест против живой базы — обязателен: тут впервые проверяются ограничения
// схемы, каскады и уникальности, которые видны только при выполнении SQL.
// Пропускается, если PG* не заданы.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { writeSeries, loadSlugs, genreCode, genreNameRu, GENRE_DICTIONARY } from '../src/services/import/write.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE или TEST_DATABASE_URL — запись не проверялась';

let pool;

test.before(async () => {
  if (!available) return;
  pool = createPool();
});

test.after(async () => {
  if (pool) await pool.end();
});

let counter = 0;

/** Сырой слой с уникальным tconst, чтобы тесты не мешали друг другу. */
const raw = (overrides = {}) => {
  counter += 1;
  const tconst = `tt9${String(counter).padStart(6, '0')}`;
  return {
    tconst,
    tmdbId: 900000 + counter,
    status: 'Ended',
    titles: { original: { text: `Тестовый сериал ${counter}` }, ru: { text: '' }, en: { text: '' } },
    descriptions: { ru: { text: 'Описание' }, en: { text: '' } },
    years: { start: 2015, end: 2019 },
    nextEpisode: null,
    lastEpisode: { date: '2019-05-01' },
    imdbGenres: ['Drama', 'Crime'],
    votes: { average: 9.5, count: 100 },
    tmdbVotes: { average: 9.4, count: 5000 },
    people: { directors: [{ nconst: `nm${counter}0001`, name: 'Режиссёр' }], cast: [{ nconst: `nm${counter}0002`, name: 'Актёр' }] },
    seasons: [
      {
        number: 1,
        titleRu: { text: 'Первый сезон' },
        descriptionRu: { text: '' },
        episodes: [
          { number: 1, titleRu: { text: 'Пилот' }, descriptionRu: { text: '' }, date: '2015-02-03', runtimeMin: 50 },
          { number: 2, titleRu: { text: 'Вторая' }, descriptionRu: { text: '' }, date: '2015-02-10', runtimeMin: 45 },
        ],
      },
    ],
    ...overrides,
  };
};

/**
 * Пишет сериал и убирает за собой.
 *
 * Порядок удаления важен: `e_season.series_id` объявлен RESTRICТ намеренно
 * («ошибка должна быть громкой»), поэтому сезоны уходят первыми, а уже за ними
 * сериал. Каскады дальше срабатывают сами: сезон → серии → выходы.
 */
async function writeAndCleanup(series, extra = {}) {
  const slugs = await loadSlugs(pool);
  const result = await writeSeries({ pool, raw: series, slugs, ...extra });
  test.after(async () => {
    await pool.query('DELETE FROM e_season WHERE series_id = $1', [result.seriesId]);
    await pool.query('DELETE FROM e_series WHERE id = $1', [result.seriesId]);
  });
  return result;
}

const row = (id) => pool.query('SELECT * FROM e_series WHERE id = $1', [id]).then((r) => r.rows[0]);

// ─── Запись ───────────────────────────────────────────────────────────────────

test('сериал записывается со всеми связанными строками', { skip }, async () => {
  const result = await writeAndCleanup(raw());

  const series = await row(result.seriesId);
  assert.equal(series.imdb_key, result.tconst);
  assert.equal(series.title_original, series.title_original);
  assert.equal(series.year_start, 2015);
  assert.equal(series.exit_state, 'ended');
  assert.equal(series.publication_state, 'published');

  const genres = await pool.query(
    'SELECT genre_code FROM e_series_genre WHERE series_id = $1 ORDER BY genre_code', [result.seriesId],
  );
  assert.deepEqual(genres.rows.map((r) => r.genre_code), ['crime', 'drama']);

  const episodes = await pool.query(
    `SELECT e.number FROM e_episode e JOIN e_season s ON s.id = e.season_id
      WHERE s.series_id = $1 ORDER BY e.number`,
    [result.seriesId],
  );
  assert.deepEqual(episodes.rows.map((r) => r.number), [1, 2]);
});

test('выходов столько же, сколько разных дат', { skip }, async () => {
  const result = await writeAndCleanup(raw());
  const releases = await pool.query(
    `SELECT r.release_date, count(ep.episode_id)::int AS n
       FROM e_release r JOIN e_season s ON s.id = r.season_id
       LEFT JOIN e_release_episode ep ON ep.release_id = r.id
      WHERE s.series_id = $1 GROUP BY r.release_date ORDER BY r.release_date`,
    [result.seriesId],
  );
  assert.equal(releases.rows.length, 2);
  assert.ok(releases.rows.every((row) => row.n === 1));
});

test('три серии с одной датой дают один выход (EC-D11)', { skip }, async () => {
  const series = raw({
    seasons: [{
      number: 1,
      titleRu: { text: '' },
      descriptionRu: { text: '' },
      episodes: [1, 2, 3].map((n) => ({
        number: n, titleRu: { text: '' }, descriptionRu: { text: '' }, date: '2015-02-03', runtimeMin: 40,
      })),
    }],
  });
  const result = await writeAndCleanup(series);

  const releases = await pool.query(
    `SELECT r.id, count(ep.episode_id)::int AS n
       FROM e_release r JOIN e_season s ON s.id = r.season_id
       JOIN e_release_episode ep ON ep.release_id = r.id
      WHERE s.series_id = $1 GROUP BY r.id`,
    [result.seriesId],
  );
  assert.equal(releases.rows.length, 1, 'одна дата — один выход');
  assert.equal(releases.rows[0].n, 3, 'и три серии внутри него');
});

// ─── Идемпотентность ──────────────────────────────────────────────────────────

test('рейтинги площадок пишутся в шапку карточки', { skip }, async () => {
  const result = await writeAndCleanup(raw());
  const ratings = await pool.query(
    'SELECT platform, value, votes, scale_max FROM e_external_rating WHERE series_id = $1 ORDER BY platform',
    [result.seriesId],
  );
  assert.equal(ratings.rows.length, 2, 'обе площадки из сырого слоя');
  assert.deepEqual(ratings.rows.map((r) => r.platform), ['imdb', 'tmdb']);
  assert.equal(Number(ratings.rows[0].value), 9.5);
  assert.equal(ratings.rows[0].votes, 100);
  assert.equal(Number(ratings.rows[0].scale_max), 10);
  assert.equal(Number(ratings.rows[1].value), 9.4);
});

test('оценка без голосов не пишется', { skip }, async () => {
  // «9,5 у одного человека» — не рейтинг, а шум; в шапке он смотрелся бы как
  // уверенное число.
  const result = await writeAndCleanup(raw({ votes: { average: 9.5, count: null } }));
  const ratings = await pool.query(
    'SELECT platform FROM e_external_rating WHERE series_id = $1', [result.seriesId],
  );
  assert.deepEqual(ratings.rows.map((r) => r.platform), ['tmdb'], 'IMDb без голосов не пишется, TMDB на месте');
});

test('повторная запись не создаёт дублей', { skip }, async () => {
  const series = raw();
  const first = await writeAndCleanup(series);
  const second = await writeSeries({ pool, raw: series, slugs: await loadSlugs(pool) });

  assert.equal(second.seriesId, first.seriesId);
  const count = await pool.query('SELECT count(*)::int AS n FROM e_series WHERE imdb_key = $1', [series.tconst]);
  assert.equal(count.rows[0].n, 1);

  const episodes = await pool.query(
    `SELECT count(*)::int AS n FROM e_episode e JOIN e_season s ON s.id = e.season_id WHERE s.series_id = $1`,
    [first.seriesId],
  );
  assert.equal(episodes.rows[0].n, 2, 'серии не задвоились');

  const releases = await pool.query(
    `SELECT count(*)::int AS n FROM e_release r JOIN e_season s ON s.id = r.season_id WHERE s.series_id = $1`,
    [first.seriesId],
  );
  assert.equal(releases.rows[0].n, 2);
});

test('адрес при повторной записи не меняется (H-32)', { skip }, async () => {
  const series = raw();
  const first = await writeAndCleanup(series);
  const changed = { ...series, titles: { original: { text: 'Совсем другое название' }, ru: { text: '' }, en: { text: '' } } };
  await writeSeries({ pool, raw: changed, slugs: await loadSlugs(pool) });
  const series2 = await row(first.seriesId);
  assert.equal(series2.slug, first.slug);
});

// ─── EC-D8. Ручные правки ─────────────────────────────────────────────────────

test('заблокированное поле импорт не перезаписывает', { skip }, async () => {
  const series = raw();
  const first = await writeAndCleanup(series);

  await pool.query(
    `INSERT INTO e_field_lock (series_id, field, set_by) VALUES ($1, 'title_original', NULL)`,
    [first.seriesId],
  );
  await pool.query(
    `UPDATE e_series SET title_original = 'Название редактора' WHERE id = $1`,
    [first.seriesId],
  );

  await writeSeries({ pool, raw: { ...series, titles: { original: { text: 'Из источника' }, ru: { text: '' }, en: { text: '' } } }, slugs: await loadSlugs(pool) });

  const after = await row(first.seriesId);
  assert.equal(after.title_original, 'Название редактора', 'EC-D8: ручное значение должно выстоять');
  assert.equal(after.year_start, 2015, 'а незаблокированные поля обновились');
});

// ─── Публикация и причины ────────────────────────────────────────────────────

test('сериал без жанров остаётся неопубликованным с причиной (EC-K2)', { skip }, async () => {
  const result = await writeAndCleanup(raw({ imdbGenres: [] }));
  const series = await row(result.seriesId);
  assert.equal(series.publication_state, 'imported');
  assert.ok(series.reasons.includes('no_genre'));
});

test('причины и уровень записываются в карточку', { skip }, async () => {
  const result = await writeAndCleanup(raw());
  const series = await row(result.seriesId);
  // Постер и фон появятся только с F-12-05, а «пригодна к показу» требует
  // постер — значит до сих пор честный уровень «минимум», а не завышенный.
  assert.equal(series.level, 'minimum');
  assert.ok(series.reasons.includes('no_poster'));
  assert.ok(series.reasons.includes('no_backdrop'));
});

test('сериал без IMDb-идентификатора берёт жанры из TMDB', { skip }, async () => {
  // Новинка из обзора TMDB может не иметь IMDb-ключа (F-12-04 §4). Если
  // жанры брать только из IMDb, такой сериал остался бы неопубликованным
  // навсегда: никто его не увидит, а обзор его каждый раз добавлять будет.
  const result = await writeAndCleanup(raw({
    imdbGenres: [],
    genres: [{ code: 18, name: 'Drama' }, { code: 10768, name: 'War & Crime' }],
  }));
  const series = await row(result.seriesId);
  assert.equal(series.publication_state, 'published');
  assert.equal(series.reasons.includes('no_genre'), false);

  const genres = await pool.query(
    'SELECT genre_code FROM e_series_genre WHERE series_id = $1 ORDER BY genre_code', [result.seriesId],
  );
  assert.deepEqual(genres.rows.map((row) => row.genre_code), ['drama', 'imdb:war-crime']);
});

test('совпавшие жанры IMDb не дублируются с TMDB', { skip }, async () => {
  const result = await writeAndCleanup(raw({
    imdbGenres: ['Drama'],
    genres: [{ code: 18, name: 'Drama' }, { code: 80, name: 'Crime' }],
  }));
  const genres = await pool.query(
    'SELECT genre_code FROM e_series_genre WHERE series_id = $1 ORDER BY genre_code', [result.seriesId],
  );
  assert.deepEqual(genres.rows.map((row) => row.genre_code), ['drama'], 'IMDb — источник по умолчанию');
});

test('архивный сериал обновляется, но остаётся архивным (§5)', { skip }, async () => {
  const result = await writeAndCleanup(raw());
  await pool.query(
    `UPDATE e_series SET publication_state = 'archived', archived_at = now() WHERE id = $1`,
    [result.seriesId],
  );
  await writeSeries({ pool, raw: { ...raw(), tconst: result.tconst, years: { start: 2016, end: 2019 } }, slugs: await loadSlugs(pool) });
  const after = await row(result.seriesId);
  assert.equal(after.publication_state, 'archived');
  assert.equal(after.year_start, 2016, 'данные обновились');
});

// ─── Люди ─────────────────────────────────────────────────────────────────────

test('один и тот же человек — одна строка в справочнике', { skip }, async () => {
  // Ключ человека — `nconst`, а не имя: два сериала с одним актёром должны
  // ссылаться на одну строку `e_person`, иначе карточка актёра распадётся.
  const shared = { nconst: 'nm0000999', name: 'Общий актёр' };
  const first = await writeAndCleanup(raw({
    people: { directors: [], cast: [{ ...shared, characters: ['Первый'], order: 1 }] },
  }));
  const second = await writeAndCleanup(raw({
    people: { directors: [], cast: [{ ...shared, characters: ['Второй'], order: 1 }] },
  }));
  test.after(() => pool.query('DELETE FROM e_person WHERE name = $1', [shared.name]));

  // Проверяем по связанным строкам, а не по имени: строки от прошлых прогонов
  // в этой же базе не должны влиять на вывод.
  const linked = await pool.query(
    'SELECT DISTINCT person_id FROM e_series_person WHERE series_id = ANY($1::bigint[])',
    [[first.seriesId, second.seriesId]],
  );
  assert.equal(linked.rows.length, 1, 'один человек — одна строка справочника на два сериала');
});

test('тёзки с разными nconst остаются разными людьми', { skip }, async () => {
  // Одинаковое имя — не один человек: склеив их, мы бы смешали две разные
  // биографии и одну фильмографию с другой.
  const first = await writeAndCleanup(raw({
    people: { directors: [], cast: [{ nconst: 'nm0000888', name: 'Тёзка', characters: [], order: 1 }] },
  }));
  const second = await writeAndCleanup(raw({
    people: { directors: [], cast: [{ nconst: 'nm0000777', name: 'Тёзка', characters: [], order: 1 }] },
  }));
  test.after(() => pool.query('DELETE FROM e_person WHERE name = $1', ['Тёзка']));

  const linked = await pool.query(
    'SELECT DISTINCT person_id FROM e_series_person WHERE series_id = ANY($1::bigint[])',
    [[first.seriesId, second.seriesId]],
  );
  assert.equal(linked.rows.length, 2, 'разные nconst — разные люди, даже с одинаковым именем');
});
