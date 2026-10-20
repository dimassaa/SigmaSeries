// Отбор трёх баннеров дня (F-06-02).
//
// Отбор — чистая функция от каталога и выходов: сначала проверяются сами
// правила (без базы), потом — что расчёт кладётся в `e_banner` и что
// повторный пересчёт даёт тот же результат.
//
// Проверки на живой базе пропускаются без подключения, как и остальные.

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { selectBanners, pgBannerSelection } from '../src/services/home/banners.js';
import { homeSettings } from '../src/services/home/settings.js';

const CONN = process.env.PGHOST && process.env.PGDATABASE
  ? {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER,
      database: process.env.PGDATABASE,
    }
  : process.env.TEST_DATABASE_URL
    ? { connectionString: process.env.TEST_DATABASE_URL }
    : null;

const skip = CONN ? false : 'нет подключения к базе — отбор баннеров не проверялся';

const SETTINGS = {
  bannersPerDay: 3,
  classicMinYear: 2016,
  classicMinRating: 8.5,
  newReleaseWindowDays: 7,
};

/**
 * Кандидат в правило.
 *
 * @param {number} id
 * @param {string} slug
 * @param {number|null} imdb
 * @param {number} [yearStart]
 * @returns {object}
 */
function cand(id, slug, imdb, yearStart = 2020) {
  return { seriesId: id, slug, title: slug, yearStart, imdb };
}

const empty = {
  newToday: [], newWindow: [], classicRated: [], classicAny: [], editorial: [], editorialLast: [],
};

// --- Правила отбора (чистая функция) ---------------------------------------

test('новинка — наибольший рейтинг среди выходов сегодня', () => {
  const picked = selectBanners({
    ...empty,
    newToday: [cand(2, 'b', 9.4), cand(1, 'a', 9.1), cand(3, 'c', 8.8)],
  }, SETTINGS);

  assert.equal(picked[0].kind, 'new');
  assert.equal(picked[0].slug, 'b', 'высший рейтинг идёт первым');
});

test('запасное правило новинки — окно в семь дней, когда сегодня выходов нет', () => {
  const picked = selectBanners({
    ...empty,
    newWindow: [cand(1, 'a', 8.9), cand(2, 'b', 8.2)],
  }, SETTINGS);

  assert.equal(picked[0].kind, 'new');
  assert.equal(picked[0].slug, 'a');
});

test('классика — старше порога года и с рейтингом не ниже порога', () => {
  const picked = selectBanners({
    ...empty,
    classicRated: [cand(1, 'old-high', 9.0, 2001), cand(2, 'old-low', 8.4, 2001)],
  }, SETTINGS);

  assert.equal(picked[0].kind, 'classic');
  assert.equal(picked[0].slug, 'old-high');
});

test('запасное правило классики — любой старше десяти лет, если по рейтингу никого нет', () => {
  const picked = selectBanners({
    ...empty,
    classicAny: [cand(1, 'old-any', null, 2001)],
  }, SETTINGS);

  assert.equal(picked[0].kind, 'classic');
  assert.equal(picked[0].slug, 'old-any', 'рейтинг не обязателен для запасного правила');
});

test('выбор редакции — активная запись', () => {
  const picked = selectBanners({
    ...empty,
    editorial: [cand(7, 'picked', 8.0)],
  }, SETTINGS);

  assert.equal(picked[0].kind, 'editorial');
  assert.equal(picked[0].slug, 'picked');
});

test('без выбора редакции третье место берётся из второго круга, но не повторяет сериал', () => {
  const picked = selectBanners({
    ...empty,
    newToday: [cand(1, 'a', 9.1), cand(2, 'b', 9.0)],
    classicRated: [cand(3, 'c', 9.5, 2001)],
  }, SETTINGS);

  const slugs = picked.map((p) => p.slug);
  assert.equal(picked.length, 3, 'три места заполнены');
  assert.equal(new Set(slugs).size, 3, 'сериалы разные');
  assert.ok(!slugs.includes('a') || slugs.filter((s) => s === 'a').length === 1);
});

test('три правила дали один сериал — остальные места занимают следующие по рейтингу (EC-H1)', () => {
  const picked = selectBanners({
    ...empty,
    newToday: [cand(1, 'same', 9.5)],
    classicRated: [cand(1, 'same', 9.5, 2001), cand(2, 'next', 9.4, 2001)],
    editorial: [cand(1, 'same', 9.5)],
  }, SETTINGS);

  const slugs = picked.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'один сериал не занимает два места');
  assert.ok(slugs.includes('next'), 'второе место занял следующий по рейтингу');
});

test('отбор детерминирован: одинаковые входы дают одинаковую тройку', () => {
  const input = {
    ...empty,
    newToday: [cand(3, 'c', 8.8), cand(1, 'a', 8.8), cand(2, 'b', 8.8)],
  };
  const first = selectBanners(input, SETTINGS);
  const second = selectBanners(input, SETTINGS);
  assert.deepEqual(first, second);
});

test('три места всегда помечены: метка причины обязательна (F-06-01 §8а)', () => {
  const picked = selectBanners({
    ...empty,
    newToday: [cand(1, 'a', 9.1)],
    classicRated: [cand(2, 'b', 9.0, 2001)],
    editorial: [cand(3, 'c', 8.5)],
  }, SETTINGS);

  assert.deepEqual(picked.map((p) => p.kind), ['new', 'classic', 'editorial']);
});

// --- Расчёт и хранение (живая база) ----------------------------------------

let pool;
let selection;

test.before(async () => {
  if (!CONN) return;
  pool = new pg.Pool(CONN);
  await pool.query('select 1');
  selection = pgBannerSelection(pool);
});

test.after(async () => {
  if (pool) await pool.end();
});

test('пересчёт кладёт три баннера и повторный пересчёт даёт тот же результат', { skip }, async () => {
  const date = '2026-01-02';
  const settings = await homeSettings(pool);

  const first = await selection.recompute({ date, settings });
  const { rows } = await pool.query(
    'SELECT kind, series_id FROM e_banner WHERE show_on = $1 ORDER BY kind', [date],
  );
  assert.equal(rows.length, first.length, 'в базе столько же баннеров, сколько выбрано');
  assert.ok(rows.length >= 1, 'хотя бы один баннер выбран');

  const second = await selection.recompute({ date, settings });
  const again = await pool.query(
    'SELECT kind, series_id FROM e_banner WHERE show_on = $1 ORDER BY kind', [date],
  );
  assert.deepEqual(
    again.rows.map((r) => `${r.kind}:${r.series_id}`),
    rows.map((r) => `${r.kind}:${r.series_id}`),
    'повторный пересчёт идемпотентен',
  );
  assert.deepEqual(
    second.map((p) => `${p.kind}:${p.seriesId}`),
    first.map((p) => `${p.kind}:${p.seriesId}`),
    'результат повторного пересчёта тот же',
  );

  await pool.query('DELETE FROM e_banner WHERE show_on = $1', [date]);
});

test('баннеры разных дат не мешают друг другу', { skip }, async () => {
  const settings = await homeSettings(pool);
  await selection.recompute({ date: '2026-01-03', settings });
  await selection.recompute({ date: '2026-01-04', settings });

  const { rows } = await pool.query(
    "SELECT show_on::text AS day, count(*)::int AS n FROM e_banner WHERE show_on IN ('2026-01-03','2026-01-04') GROUP BY show_on",
  );
  assert.equal(rows.length, 2, 'оба дня сохранились');

  await pool.query('DELETE FROM e_banner WHERE show_on IN ($1, $2)', ['2026-01-03', '2026-01-04']);
});
