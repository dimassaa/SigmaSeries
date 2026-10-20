// Подборка (F-02-05, S-05) и персона (F-02-09, S-15).
//
// Оба адреса строятся по одной и той же причине: поиск и главная предлагают
// эти ссылки, а они вели в 404. Проверяется главное правило каждой страницы —
// порог видимости: подборка из пяти видимых сериалов не существует для
// посетителя (EC-C6), человек без видимых сериалов не существует тоже.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgCollections } from '../src/services/catalogue/collection.js';
import { pgPerson } from '../src/services/catalogue/person.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — подборка и персона не проверялись';

/** Порог видимости подборки (F-02-05 §3): меньше шести — её нет. */
const MIN_VISIBLE = 6;

let pool;
let collections;
let person;
let fixture;

/** Шесть видимых сериалов каталога, которые никто не тронет. */
async function sixVisibleSeries() {
  const { rows } = await pool.query(
    `SELECT id FROM e_series
      WHERE publication_state = 'published' AND archived_at IS NULL
      ORDER BY id LIMIT $1`,
    [MIN_VISIBLE],
  );
  return rows.map((row) => row.id);
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  collections = pgCollections(pool);
  person = pgPerson(pool);
  // Следы прошлого прогона, упавшего посреди теста: без чистки повторный
  // запуск упирается в уникальный индекс и падает не из-за кода.
  await dropFixtures(pool);
});

test.after(async () => {
  if (!available) return;
  await dropFixtures(pool);
  if (pool) await pool.end();
});

/**
 * Убирает фикстуры.
 *
 * Порядок обязателен: связи объявлены RESTRICT намеренно («ошибка должна быть
 * громкой»), поэтому ссылка уходит раньше самой строки.
 *
 * @param {object} target
 */
async function dropFixtures(target) {
  await target.query(
    `DELETE FROM e_collection_item WHERE collection_id IN (SELECT id FROM e_collection WHERE slug LIKE 'test-data-collection%')`,
  );
  await target.query("DELETE FROM e_collection WHERE slug LIKE 'test-data-collection%'");
  await target.query(
    `DELETE FROM e_series_person WHERE person_id IN (SELECT id FROM e_person WHERE slug LIKE 'test-data-person%')`,
  );
  await target.query("DELETE FROM e_person WHERE slug LIKE 'test-data-person%'");
  // Архивные фикстуры: сериал без seasons, поэтому удаляется сам.
  await target.query("DELETE FROM e_series WHERE slug LIKE 'test-archived-%'");
}

test('подборка из шести видимых сериалов открывается, из пяти — нет (EC-C6)', { skip }, async () => {
  const series = await sixVisibleSeries();
  assert.equal(series.length, MIN_VISIBLE, 'в каталоге хватает видимых сериалов');

  const { rows: [full] } = await pool.query(
    "INSERT INTO e_collection (slug, title_ru, description_ru, weight) VALUES ($1, $2, $3, 10) RETURNING id, slug",
    ['test-data-collection-full', 'Проверочная подборка', 'Шесть видимых сериалов'],
  );
  const { rows: [thin] } = await pool.query(
    "INSERT INTO e_collection (slug, title_ru, weight) VALUES ($1, $2, 10) RETURNING id, slug",
    ['test-data-collection-thin', 'Проверочная подборка из пяти'],
  );

  for (const [index, id] of series.entries()) {
    await pool.query(
      'INSERT INTO e_collection_item (collection_id, series_id, ordinal) VALUES ($1, $2, $3)',
      [full.id, id, index],
    );
  }
  for (const id of series.slice(0, MIN_VISIBLE - 1)) {
    await pool.query(
      'INSERT INTO e_collection_item (collection_id, series_id, ordinal) VALUES ($1, $2, $3)',
      [thin.id, id, 0],
    );
  }

  try {
    const page = await collections.collection(full.slug);
    assert.ok(page, 'подборка из шести сериалов видна');
    assert.equal(page.series.length, MIN_VISIBLE);

    assert.equal(await collections.collection(thin.slug), null,
      'подборка из пяти сериалов для посетителя не существует');
  } finally {
    await pool.query('DELETE FROM e_collection WHERE slug IN ($1, $2)', [full.slug, thin.slug]);
  }
});

test('порог считает только видимые сериалы: архивный не в счёт (EC-C6)', { skip }, async () => {
  const series = await sixVisibleSeries();
  // Архивный сериал — свой, а не чужой: снимать с публикации строку каталога
  // значит на время прогона сломать чужой тест, который её читает.
  const { rows: [archived] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, archived_at, exit_state)
     VALUES ('test-archived-series', 'Архивный для проверки', 'Archived for check', 999000001, 'published', now(), 'ended')
     RETURNING id`,
  );
  const { rows: [row] } = await pool.query(
    "INSERT INTO e_collection (slug, title_ru, weight) VALUES ($1, $2, 10) RETURNING id, slug",
    ['test-data-collection-archived', 'Подборка с архивным'],
  );

  for (const [index, id] of series.slice(0, MIN_VISIBLE - 1).entries()) {
    await pool.query(
      'INSERT INTO e_collection_item (collection_id, series_id, ordinal) VALUES ($1, $2, $3)',
      [row.id, id, index],
    );
  }
  await pool.query(
    'INSERT INTO e_collection_item (collection_id, series_id, ordinal) VALUES ($1, $2, $3)',
    [row.id, archived.id, MIN_VISIBLE],
  );

  try {
    assert.equal(await collections.collection(row.slug), null,
      'шесть пунктов, из которых один в архиве, — это пять видимых, то есть подборки нет');
  } finally {
    await pool.query('DELETE FROM e_collection WHERE id = $1', [row.id]);
    await pool.query('DELETE FROM e_series WHERE id = $1', [archived.id]);
  }
});

test('неактивная подборка не видна даже с шестью сериалами', { skip }, async () => {
  const series = await sixVisibleSeries();
  const { rows: [row] } = await pool.query(
    "INSERT INTO e_collection (slug, title_ru, active, weight) VALUES ($1, $2, false, 10) RETURNING id, slug",
    ['test-data-collection-hidden', 'Скрытая подборка'],
  );
  for (const [index, id] of series.entries()) {
    await pool.query(
      'INSERT INTO e_collection_item (collection_id, series_id, ordinal) VALUES ($1, $2, $3)',
      [row.id, id, index],
    );
  }

  try {
    assert.equal(await collections.collection(row.slug), null);
  } finally {
    await pool.query('DELETE FROM e_collection WHERE id = $1', [row.id]);
  }
});

test('неизвестная подборка — null, а не пустая страница', { skip }, async () => {
  assert.equal(await collections.collection('такой-подборки-нет'), null);
});

test('сериалы в подборке идут в порядке админа, а не по алфавиту', { skip }, async () => {
  const series = await sixVisibleSeries();
  const { rows: [row] } = await pool.query(
    "INSERT INTO e_collection (slug, title_ru, weight) VALUES ($1, $2, 10) RETURNING id, slug",
    ['test-data-collection-order', 'Порядок админа'],
  );
  const order = [...series].reverse();
  for (const [index, id] of order.entries()) {
    await pool.query(
      'INSERT INTO e_collection_item (collection_id, series_id, ordinal) VALUES ($1, $2, $3)',
      [row.id, id, index],
    );
  }

  try {
    const page = await collections.collection(row.slug);
    assert.deepEqual(page.series.map((item) => item.id), order,
      'порядок в подборке задан администратором (F-02-05 §3)');
  } finally {
    await pool.query('DELETE FROM e_collection WHERE id = $1', [row.id]);
  }
});

test('баннер по умолчанию — фон первого сериала, а чужого фона не подставляется', { skip }, async () => {
  const series = await sixVisibleSeries();
  const { rows: [row] } = await pool.query(
    "INSERT INTO e_collection (slug, title_ru, weight) VALUES ($1, $2, 10) RETURNING id, slug",
    ['test-data-collection-banner', 'Баннер по умолчанию'],
  );
  for (const [index, id] of series.entries()) {
    await pool.query(
      'INSERT INTO e_collection_item (collection_id, series_id, ordinal) VALUES ($1, $2, $3)',
      [row.id, id, index],
    );
  }

  // Что увидит страница, решает источник, а не тест: если у первого сериала
  // фона нет, подставлять фон второго было бы враньём.
  const { rows: [first] } = await pool.query(
    `SELECT EXISTS (
        SELECT 1 FROM e_image i
          JOIN e_image_variant iv ON iv.image_id = i.id
         WHERE i.series_id = $1 AND i.role = 'backdrop') AS has_backdrop,
            (SELECT max(iv2.width) FROM e_image i2
              JOIN e_image_variant iv2 ON iv2.image_id = i2.id
             WHERE i2.series_id = $1 AND i2.role = 'backdrop') AS widest
       FROM e_series WHERE id = $1`,
    [series[0]],
  );

  try {
    const page = await collections.collection(row.slug);
    if (!first.has_backdrop) {
      assert.equal(page.banner, null, 'нет фона первого сериала — нет и баннера');
      return;
    }
    assert.ok(page.banner, 'фон первого сериала стал баннером');
    assert.ok(page.banner.width <= first.widest, 'ширина взята из загруженных вариантов');
  } finally {
    await pool.query('DELETE FROM e_collection WHERE id = $1', [row.id]);
  }
});

test('список подборок на главной тоже знает про порог в шесть (F-02-05 §3)', { skip }, async () => {
  const series = await sixVisibleSeries();
  const { rows: [row] } = await pool.query(
    "INSERT INTO e_collection (slug, title_ru, weight) VALUES ($1, $2, 10) RETURNING id, slug",
    ['test-data-collection-list', 'Подборка для главной'],
  );
  const { rows: [thin] } = await pool.query(
    "INSERT INTO e_collection (slug, title_ru, weight) VALUES ($1, $2, 9) RETURNING id, slug",
    ['test-data-collection-list-thin', 'Тонкая подборка для главной'],
  );
  for (const [index, id] of series.entries()) {
    await pool.query(
      'INSERT INTO e_collection_item (collection_id, series_id, ordinal) VALUES ($1, $2, $3)',
      [row.id, id, index],
    );
  }
  for (const id of series.slice(0, MIN_VISIBLE - 1)) {
    await pool.query(
      'INSERT INTO e_collection_item (collection_id, series_id, ordinal) VALUES ($1, $2, $3)',
      [thin.id, id, 0],
    );
  }

  try {
    const list = await collections.list(50);
    const slugs = list.map((item) => item.slug);
    assert.ok(slugs.includes(row.slug), 'подборка из шести видна на главной');
    assert.ok(!slugs.includes(thin.slug), 'подборка из пяти на главной не появляется');
  } finally {
    await pool.query('DELETE FROM e_collection WHERE id IN ($1, $2)', [row.id, thin.id]);
  }
});

test('персона отдаёт видимые сериалы, отсортированные по популярности', { skip }, async () => {
  const series = await sixVisibleSeries();
  const { rows: [created] } = await pool.query(
    "INSERT INTO e_person (slug, name, kind) VALUES ('test-person', 'Проверочный Человек', 'actor') RETURNING id, slug",
  );
  for (const [index, id] of series.entries()) {
    await pool.query(
      'INSERT INTO e_series_person (series_id, person_id, role, ordinal) VALUES ($1, $2, $3, $4)',
      [id, created.id, 'actor', index],
    );
  }

  try {
    const page = await person.person(created.slug);
    assert.ok(page, 'человек виден');
    assert.equal(page.series.length, MIN_VISIBLE);
    assert.equal(page.total, MIN_VISIBLE);

    const votes = page.series.map((item) => item.votes ?? 0);
    assert.deepEqual(votes, [...votes].sort((a, b) => b - a),
      'сначала более популярный сериал (F-02-09 §3)');
  } finally {
    await pool.query('DELETE FROM e_series_person WHERE person_id = $1', [created.id]);
    await pool.query('DELETE FROM e_person WHERE id = $1', [created.id]);
  }
});

test('человек без видимых сериалов — 404 (F-02-09)', { skip }, async () => {
  const { rows: [created] } = await pool.query(
    "INSERT INTO e_person (slug, name, kind) VALUES ('test-data-person-alone', 'Ни с кем', 'actor') RETURNING id, slug",
  );
  try {
    assert.equal(await person.person(created.slug), null);
  } finally {
    await pool.query('DELETE FROM e_person WHERE id = $1', [created.id]);
  }
});

test('роль человека приходит списком, а не одним значением', { skip }, async () => {
  const series = await sixVisibleSeries();
  const { rows: [created] } = await pool.query(
    "INSERT INTO e_person (slug, name, kind) VALUES ('test-data-person-roles', 'Два Роля', 'actor') RETURNING id, slug",
  );
  await pool.query(
    'INSERT INTO e_series_person (series_id, person_id, role, ordinal) VALUES ($1, $2, $3, $4)',
    [series[0], created.id, 'actor', 0],
  );
  await pool.query(
    'INSERT INTO e_series_person (series_id, person_id, role, ordinal) VALUES ($1, $2, $3, $4)',
    [series[1], created.id, 'director', 0],
  );

  try {
    const page = await person.person(created.slug);
    assert.deepEqual([...page.roles].sort(), ['actor', 'director'],
      'человек играл и режиссировал — обе роли видны');
  } finally {
    await pool.query('DELETE FROM e_series_person WHERE person_id = $1', [created.id]);
    await pool.query('DELETE FROM e_person WHERE id = $1', [created.id]);
  }
});

test('архивный сериал не попадает на страницу человека', { skip }, async () => {
  const series = await sixVisibleSeries();
  const { rows: [created] } = await pool.query(
    "INSERT INTO e_person (slug, name, kind) VALUES ('test-data-person-archive', 'С Архивом', 'actor') RETURNING id, slug",
  );
  const { rows: [archived] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, archived_at, exit_state)
     VALUES ('test-archived-person-series', 'Архивный для человека', 'Archived for person', 999000002, 'published', now(), 'ended')
     RETURNING id`,
  );
  for (const id of series.slice(0, 2)) {
    await pool.query(
      'INSERT INTO e_series_person (series_id, person_id, role, ordinal) VALUES ($1, $2, $3, $4)',
      [id, created.id, 'actor', 0],
    );
  }
  await pool.query(
    'INSERT INTO e_series_person (series_id, person_id, role, ordinal) VALUES ($1, $2, $3, $4)',
    [archived.id, created.id, 'actor', 0],
  );

  try {
    const page = await person.person(created.slug);
    assert.equal(page.total, 2, 'архивный сериал не считается (F-02-09 §4)');
  } finally {
    await pool.query('DELETE FROM e_series_person WHERE person_id = $1', [created.id]);
    await pool.query('DELETE FROM e_person WHERE id = $1', [created.id]);
    await pool.query('DELETE FROM e_series WHERE id = $1', [archived.id]);
  }
});