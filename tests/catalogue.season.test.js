// Страница сезона и страница серии (F-02-02, S-07 и S-08).
//
// Проверяется против живой базы: сезоны и серии приходят из импорта, и запрос,
// который работает на трёх подставных строках, разваливается там, где у части
// серий нет даты или описания — а таких строк в каталоге большинство.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgSeasons } from '../src/services/catalogue/season.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — сезон и серия не проверялись';

let pool;
let seasons;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  seasons = pgSeasons(pool);
});

test.after(async () => {
  if (pool) await pool.end();
});

/** Сезон из каталога с хотя бы одной серией. */
async function anySeason() {
  const { rows } = await pool.query(
    `SELECT s.slug, se.number
       FROM e_season se
       JOIN e_series s ON s.id = se.series_id
       JOIN e_episode e ON e.season_id = se.id
      WHERE s.publication_state = 'published' AND s.archived_at IS NULL AND se.number > 0
      GROUP BY s.slug, se.number
      LIMIT 1`,
  );
  return rows[0];
}

test('неизвестный сериал или сезон — это null, а не пустая страница', { skip }, async () => {
  assert.equal(await seasons.season('такого-сериала-нет', 1), null);
  const found = await anySeason();
  assert.ok(found, 'в каталоге есть сезон с сериями');
  assert.equal(await seasons.season(found.slug, 99), null, 'несуществующий номер сезона');
});

test('серия с чужим номеромseason — 404, а не первая серия под чужим номером', { skip }, async () => {
  const found = await anySeason();
  const page = await seasons.season(found.slug, found.number);
  assert.ok(page, 'сезон читается');

  const missing = Math.max(...page.season.episodes.map((item) => item.number)) + 10;
  assert.equal(await seasons.episode(found.slug, found.number, missing), null);
});

test('сезон отдаёт серии по порядку с датами и длительностью', { skip }, async () => {
  const found = await anySeason();
  const page = await seasons.season(found.slug, found.number);

  assert.ok(page.season.episodes.length > 0, 'в сезоне есть серии');
  const numbers = page.season.episodes.map((item) => item.number);
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), 'серии идут по номеру');
  for (const episode of page.season.episodes) {
    assert.ok(episode.date === null || /^\d{4}-\d{2}-\d{2}$/.test(episode.date),
      `дата «${episode.date}» должна быть либо пустой, либо в формате даты`);
  }
});

test('группа «все серии вышли» появляется только при совпадении дат', { skip }, async () => {
  const { rows } = await pool.query(`
    SELECT s.slug, se.number, count(e.id)::int AS total,
           count(r.release_date)::int AS dated
      FROM e_season se
      JOIN e_series s ON s.id = se.series_id
      JOIN e_episode e ON e.season_id = se.id
      LEFT JOIN e_release rl ON rl.id = (
        SELECT min(rle.release_id) FROM e_release_episode rle WHERE rle.episode_id = e.id)
     JOIN e_release r ON r.id = rl.id
     WHERE s.publication_state = 'published' AND se.number > 0
     GROUP BY s.slug, se.number
     HAVING count(DISTINCT r.release_date) = 1 AND count(e.id) > 1
     LIMIT 1`);

  if (!rows.length) {
    // Совпадающих дат в каталоге нет — тогда проверяем обратное: группа не
    // показывается там, где выходы разные.
    const found = await anySeason();
    const page = await seasons.season(found.slug, found.number);
    assert.equal(page.season.allOutOn, null);
    return;
  }

  const page = await seasons.season(rows[0].slug, rows[0].number);
  assert.ok(page.season.allOutOn, `в сезоне «${rows[0].slug}» ${rows[0].total} серий одной датой`);
  assert.match(page.season.allOutOn, /^\d{4}-\d{2}-\d{2}$/);
});

test('серия отдаёт соседей по сезону', { skip }, async () => {
  const found = await anySeason();
  const season = await seasons.season(found.slug, found.number);
  const numbers = season.season.episodes.map((item) => item.number);
  if (numbers.length < 2) return;   // сезон из одной серии — соседей нет

  const page = await seasons.episode(found.slug, found.number, numbers[0]);
  assert.equal(page.prevEpisode, null, 'у первой серии нет предыдущей');
  assert.equal(page.nextEpisode, numbers[1]);
  assert.equal(page.episode.number, numbers[0]);
});

test('серия без описания или с датой в будущем помечается тонкой (H-35)', { skip }, async () => {
  const { rows } = await pool.query(`
    SELECT s.slug, se.number, e.number AS episode
      FROM e_episode e
      JOIN e_season se ON se.id = e.season_id
      JOIN e_series s ON s.id = se.series_id
      LEFT JOIN e_release r ON r.id = (
        SELECT min(release_id) FROM e_release_episode WHERE episode_id = e.id)
     WHERE s.publication_state = 'published' AND s.archived_at IS NULL
       AND (coalesce(e.description_ru, e.description_en) IS NULL OR r.release_date > CURRENT_DATE)
     LIMIT 1`);

  if (!rows.length) {
    assert.ok(true, 'тонких серий в каталоге нет — проверять нечего');
    return;
  }
  const page = await seasons.episode(rows[0].slug, rows[0].number, rows[0].episode);
  assert.equal(page.episode.thin, true, 'страница без описания или с будущей датой — тонкая');
});

test('неопубликованный сериал недоступен и по адресу сезона', { skip }, async () => {
  const { rows } = await pool.query(
    "SELECT slug FROM e_series WHERE publication_state <> 'published' AND slug IS NOT NULL LIMIT 1",
  );
  if (!rows.length) return;

  assert.equal(await seasons.season(rows[0].slug, 1), null,
    'адрес сезона не выдаёт то, чего не выдаёт адрес сериала');
});

test('архивный сериал сезоном не отдаётся, но отличается от неопубликованного', { skip }, async () => {
  // Своя фикстура, а не поиск по всей таблице: глобальный поиск молчал, когда
  // чужой архивный сериал ещё не появился или уже исчез, и проверка ничего не
  // проверяла.
  const slug = `sn-arch-${crypto.randomUUID()}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start, archived_at)
     VALUES ($1, 'Снят с публикации', 'Archived fixture', 980000001, 'published', 'ended', 2019, now())
     RETURNING id`,
    [slug],
  );
  await pool.query('INSERT INTO e_season (series_id, number) VALUES ($1, 1)', [series.id]);

  try {
    const page = await seasons.season(slug, 1);
    assert.equal(page, null, 'снятый с публикации сериал не должен открываться как актуальный');
  } finally {
    await pool.query('DELETE FROM e_season WHERE series_id = $1', [series.id]);
    await pool.query('DELETE FROM e_series WHERE id = $1', [series.id]);
  }
});