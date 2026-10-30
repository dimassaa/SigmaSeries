// Жанры: источник данных меню и страницы (F-02-04, S-03; F-10-10).
//
// Меню и страница строятся из справочника: сырые жанры импорта в меню не
// попадают, скрытый жанр не виден, а жанр без сериалов из меню выпадает
// (EC-K7). Порядок в меню идёт по display_order, пустое значение — в конце,
// далее по алфавиту названия локали (F-10-10 §4).

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgCatalogueGenres } from '../src/services/catalogue/genres.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGDATABASE — жанры не проверялись';

let pool;
let genres;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  genres = pgCatalogueGenres(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.end();
});

/** Уникальный код жанра для проверок: не пересекается с сидом и другими файлами. */
const probeCode = (suffix) => `probe-genre-${crypto.randomUUID().slice(0, 8)}-${suffix}`;

async function insertGenre(genreCode, patches = {}) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO e_genre (code, name_ru, name_en, active, is_raw, description_ru, description_en,
       display_order, show_in_menu)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING code`,
    [
      genreCode,
      patches.nameRu ?? 'Жанр для проверки',
      patches.nameEn ?? 'Probe genre',
      patches.active ?? true,
      patches.raw ?? false,
      patches.descriptionRu ?? null,
      patches.descriptionEn ?? null,
      patches.displayOrder ?? null,
      patches.showInMenu ?? true,
    ],
  );
  return row.code;
}

async function publishSeriesWithGenre(genreCode, number) {
  const slug = `probe-series-${crypto.randomUUID().slice(0, 10)}-${number}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, $2, $3, $4, 'published', 'airing', 2024) RETURNING id`,
    [slug, `Пробемый жанр ${number}`, `Probe genre ${number}`, 970000700 + number],
  );
  await pool.query('INSERT INTO e_series_genre (series_id, genre_code) VALUES ($1, $2)',
    [series.id, genreCode]);
  return series.id;
}

async function cleanup(genreCode, seriesIds) {
  for (const id of seriesIds) await pool.query('DELETE FROM e_series WHERE id = $1', [id]);
  await pool.query('DELETE FROM e_genre WHERE code = $1', [genreCode]);
}

test('меню показывает только показываемые жанры с сериалами', { skip }, async () => {
  const code = probeCode('menu');
  await insertGenre(code, { displayOrder: 1 });
  const id = await publishSeriesWithGenre(code, 1);

  try {
    const menu = await genres.menu();
    const row = menu.find((item) => item.code === code);
    assert.ok(row, 'жанр из фикстуры попал в меню');
    assert.equal(row.count, 1, 'число сериалов из опубликованных');
    assert.equal(row.nameRu, 'Жанр для проверки');
    assert.equal(row.nameEn, 'Probe genre');
  } finally {
    await cleanup(code, [id]);
  }
});

test('сырой, скрытый и выключенный жанр в меню не попадают (EC-K7)', { skip }, async () => {
  const rawCode = probeCode('raw');
  const hiddenCode = probeCode('hidden');
  const offCode = probeCode('off');
  await insertGenre(rawCode, { raw: true });
  await insertGenre(hiddenCode, { showInMenu: false });
  await insertGenre(offCode, { active: false });
  const id = await publishSeriesWithGenre(rawCode, 1);

  try {
    const menu = await genres.menu();
    const codes = menu.map((item) => item.code);
    assert.ok(!codes.includes(rawCode), 'сырой жанр без названия в меню лишний');
    assert.ok(!codes.includes(hiddenCode), 'флаг «показывать» закрыт');
    assert.ok(!codes.includes(offCode), 'выключенный жанр в меню лишний');
  } finally {
    await Promise.all([
      cleanup(rawCode, [id]),
      cleanup(hiddenCode, []),
      cleanup(offCode, []),
    ]);
  }
});

test('жанр без сериалов в меню не попадает (EC-K7)', { skip }, async () => {
  const code = probeCode('empty');
  await insertGenre(code);

  try {
    const menu = await genres.menu();
    assert.ok(!menu.some((item) => item.code === code),
      'пустой жанр не показывается в меню');
  } finally {
    await cleanup(code, []);
  }
});

test('архивный и снятый сериал не считаются числом жанра', { skip }, async () => {
  const code = probeCode('archived');
  await insertGenre(code);
  const visible = await publishSeriesWithGenre(code, 1);
  const archivedSlug = `probe-archived-${crypto.randomUUID().slice(0, 10)}`;
  const { rows: [archived] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state,
       year_start, archived_at)
     VALUES ($1, 'Архивный жанр', 'Archived', $2, 'published', 'ended', 2020, now()) RETURNING id`,
    [archivedSlug, 970000750],
  );
  const draftSlug = `probe-draft-${crypto.randomUUID().slice(0, 10)}`;
  const { rows: [draft] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Черновой жанр', 'Draft', $2, 'imported', 'announced', 2024) RETURNING id`,
    [draftSlug, 970000751],
  );
  await pool.query('INSERT INTO e_series_genre (series_id, genre_code) VALUES ($1, $2)',
    [archived.id, code]);
  await pool.query('INSERT INTO e_series_genre (series_id, genre_code) VALUES ($1, $2)',
    [draft.id, code]);

  try {
    const row = await genres.one(code);
    assert.equal(row.count, 1, 'число сериалов жанра — только видимое');
  } finally {
    await Promise.all([
      cleanup(code, [visible, archived.id, draft.id]),
    ]);
  }
});

test('порядок в меню: display_order выше, пустые — по алфавиту локали (F-10-10 §4)', { skip }, async () => {
  const early = probeCode('early');
  const late = probeCode('late');
  await insertGenre(early, { nameRu: 'Ящерица жанра', nameEn: 'Zebra genre', displayOrder: 1 });
  await insertGenre(late, { nameRu: 'Аист жанра', nameEn: 'Aardvark genre', displayOrder: 50 });
  const earlyId = await publishSeriesWithGenre(early, 1);
  const lateId = await publishSeriesWithGenre(late, 1);

  try {
    for (const locale of ['ru', 'en']) {
      const items = await genres.menu(locale);
      const codes = items.map((item) => item.code);
      assert.ok(codes.indexOf(early) < codes.indexOf(late),
        `жанр с меньшим display_order стоит раньше, независимо от алфавита (${locale})`);

      // Порядок проверяется по названию той же локали: русская коллация
      // и английская на одних записях дают разный порядок, подменять
      // один другим в проверке нельзя (R-I18N-03).
      const withoutOrder = items.filter((item) => item.displayOrder === null)
        .map((item) => (locale === 'en' ? item.nameEn : item.nameRu));
      const sorted = [...withoutOrder].sort((a, b) => a.localeCompare(b, locale));
      assert.deepEqual(withoutOrder, sorted, `без порядка — по алфавиту (${locale})`);
    }
  } finally {
    await cleanup(early, [earlyId]);
    await cleanup(late, [lateId]);
  }
});

test('one отдаёт полное описание жанра и цепочку резерва', { skip }, async () => {
  const code = probeCode('one');
  await insertGenre(code, { descriptionRu: 'Пробемое описание', descriptionEn: 'Probe description' });
  const id = await publishSeriesWithGenre(code, 1);

  try {
    const row = await genres.one(code);
    assert.equal(row.code, code);
    assert.equal(row.descriptionRu, 'Пробемое описание');
    assert.equal(row.descriptionEn, 'Probe description');
    assert.equal(row.showInMenu, true);
  } finally {
    await cleanup(code, [id]);
  }
});

test('страница жанра считает число видимых сериалов на FIXTURE-двойнике (пул-двойник)', async () => {
  // Порядок и обёртки ответов проверяются на двойнике: реальные строки тут не
  // нужны, а двойник ловит работу с чужими жанрами через параметры.
  const queries = [];
  const fake = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM e_genre g\s+LEFT JOIN/i.test(sql)) {
        // Форма строки — как в настоящем ответе базы: колонки змеиным
        // регистром и число оконной функцией под именем series_count.
        return { rows: [{ code: 'probe', name_ru: 'Жанр', name_en: 'Genre',
          active: true, is_raw: false, show_in_menu: true, series_count: 3 }] };
      }
      return { rows: [] };
    },
  };
  const service = pgCatalogueGenres(fake);
  const row = await service.one('probe');
  assert.equal(row.count, 3);
  assert.ok(queries.length === 1, 'один запрос целиком, а не по частицам');
});
