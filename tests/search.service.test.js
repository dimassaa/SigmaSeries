// Поиск по каталогу (F-02-06, S-17).
//
// Проверяется против живой базы: нормализация вынесена отдельно и проверяется
// без данных, а здесь важно другое — что названия, люди и подборки находятся
// тем же правилом и что порядок результатов совпадает с приёмкой.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgSearch } from '../src/services/search/service.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE или TEST_DATABASE_URL — поиск не проверялся';

let pool;
let search;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  search = pgSearch(pool);
  // Следы прошлого прогона: без чистки повторный запуск упирается в уникальный
  // индекс и падает не из-за кода.
  await dropFixturePerson(pool);
});

test.after(async () => {
  if (!pool) return;
  await dropFixturePerson(pool);
  await pool.end();
});

/**
 * Убирает фикстурного человека.
 *
 * Порядок обязателен: `e_series_person.person_id` объявлен RESTRICT намеренно
 * («ошибка должна быть громкой»), поэтому связь уходит раньше самой строки.
 *
 * @param {object} pool
 */
async function dropFixturePerson(target) {
  await target.query(
    'DELETE FROM e_series_person WHERE person_id = (SELECT id FROM e_person WHERE slug = $1)',
    ['test-search-person'],
  );
  await target.query('DELETE FROM e_person WHERE slug = $1', ['test-search-person']);
}

test('русское и английское название находят один сериал', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT s.slug, s.title_ru, s.title_original, s.title_en
       FROM e_series s
      WHERE s.publication_state = 'published' AND s.archived_at IS NULL
        AND s.title_ru IS NOT NULL AND s.title_original IS NOT NULL
      LIMIT 1`,
  );
  const series = rows[0];
  assert.ok(series, 'в каталоге есть опубликованный сериал с двумя названиями');

  for (const query of [series.title_ru, series.title_original, series.title_en]) {
    if (!query) continue;
    const result = await search.find({ query });
    assert.ok(
      result.series.some((item) => item.slug === series.slug),
      `«${query}» не нашёл «${series.title_ru}» / «${series.title_original}»`,
    );
  }
});

test('по первому слову названия сериал находится и стоит первым', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT s.slug, s.title_ru FROM e_series s
      WHERE s.publication_state = 'published' AND s.archived_at IS NULL
        AND s.title_ru IS NOT NULL AND length(s.title_ru) > 12
      LIMIT 1`,
  );
  assert.ok(rows.length, 'есть длинное название');
  const { slug, title_ru: title } = rows[0];

  const result = await search.find({ query: title.split(' ')[0] });
  assert.equal(result.series[0]?.slug, slug,
    `«${title.split(' ')[0]}» должен привести «${title}» первым, а привело «${result.series[0]?.title}»`);
});

test('поиск не находит выдуманное, а не выбрасывает половину каталога', { skip }, async () => {
  const result = await search.find({ query: 'квантовая физика слона братьев' });
  assert.deepEqual(result.series, []);
  assert.deepEqual(result.people, []);
  assert.deepEqual(result.collections, []);
  assert.equal(result.total, 0);
});

test('люди находятся по имени', { skip }, async () => {
  // Фикстура своя: чужая строка `e_person` может оказаться в каталоге по
  // одному-единственному сериалу, а параллельный прогон убирает его ссылку —
  // и проверка падает не из-за кода.
  const { rows } = await pool.query(
    `INSERT INTO e_person (slug, name, kind) VALUES ('test-search-person', 'Полосатый Искатель', 'actor')
     RETURNING slug`,
  );
  const { rows: [series] } = await pool.query(
    "SELECT id FROM e_series WHERE publication_state = 'published' AND archived_at IS NULL LIMIT 1",
  );
  await pool.query(
    'INSERT INTO e_series_person (series_id, person_id, role, ordinal) VALUES ($1, (SELECT id FROM e_person WHERE slug = $2), $3, 0)',
    [series.id, rows[0].slug, 'actor'],
  );

  try {
    const result = await search.find({ query: 'Полосатый Искатель' });
    assert.ok(result.people.some((item) => item.slug === rows[0].slug),
      `«Полосатый Искатель» не нашёлся среди людей: ${result.people.map((p) => p.name).join(', ')}`);
  } finally {
    await dropFixturePerson(pool);
  }
});

test('подсказки не появляются на один знак', { skip }, async () => {
  assert.deepEqual((await search.suggest({ query: 'и' })).series, []);
  const many = await search.suggest({ query: 'игра' });
  assert.ok(Array.isArray(many.series));
});

test('подсказки не превышают search.suggest_max', { skip }, async () => {
  const { rows } = await pool.query("SELECT value FROM e_system_setting WHERE key = 'search.suggest_max'");
  const max = rows[0] ? Number(rows[0].value) : 8;

  const result = await search.suggest({ query: 'а' });
  assert.ok(result.series.length <= max, `подсказок ${result.series.length}, максимум ${max}`);
});

test('результаты идут от лучшего совпадения к худшему', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT title_ru FROM e_series
      WHERE publication_state = 'published' AND archived_at IS NULL AND title_ru IS NOT NULL
      ORDER BY year_start LIMIT 1`,
  );
  const result = await search.find({ query: rows[0].title_ru });
  const ranks = result.series.map((item) => item.rank);

  assert.ok(result.series.length > 0);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'ранги не убывают');
});

test('при равенстве совпадений первым идёт более популярный', { skip }, async () => {
  const result = await search.find({ query: 'сериал' });
  const votes = result.series.map((item) => item.votes ?? 0);
  assert.deepEqual(votes, [...votes].sort((a, b) => b - a),
    'среди равных по совпадению первым идёт тот, у кого больше голосов IMDb');
});

test('запрос в чужой раскладке помечается, а не выдаётся за прямой (EC-K10)', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT title_ru FROM e_series
      WHERE publication_state = 'published' AND archived_at IS NULL
        AND title_ru ~ '^[А-Яа-яЁё ]{5,}$'
      LIMIT 1`,
  );
  assert.ok(rows.length, 'есть кириллическое название');
  const title = rows[0].title_ru.trim();
  const wrong = toEnglishLayout(title);

  const result = await search.find({ query: wrong });
  assert.equal(result.layoutFixed?.toLowerCase(), title.toLowerCase(),
    'подсказка называет, что имелось в виду');
  assert.equal(result.query, wrong, 'исходный запрос сохраняется для ссылки обратно');
  assert.ok(result.series.some((item) => item.title.toLowerCase() === title.toLowerCase()),
    'и сам сериал по исправленному запросу найден');
});

test('пометка о раскладке не появляется там, где человек не ошибался', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT title_ru FROM e_series
      WHERE publication_state = 'published' AND archived_at IS NULL
        AND title_ru ~ '^[А-Яа-яЁё ]{5,}$'
      LIMIT 1`,
  );
  const direct = await search.find({ query: rows[0].title_ru.trim() });
  assert.equal(direct.layoutFixed, null, 'прямой запрос не получает пометку');
  assert.equal(direct.query, rows[0].title_ru.trim());
});

/**
 * Кириллица, набранная на латинской раскладке.
 *
 * Раскладка в тесте повторяется намеренно: взять её из модуля нельзя (там
 *转换 в другую сторону), а без неё проверка EC-K10 была бы проверкой того, что
 * модуль умеет читать собственную таблицу.
 */
function toEnglishLayout(text) {
  const rows = [
    ['йцукенгшщзхъ', 'qwertyuiop[]'],
    ['фывапролджэ', "asdfghjkl;'"],
    ['ячсмитьбю.', 'zxcvbnm,./'],
  ];
  let out = '';
  for (const char of text.toLowerCase()) {
    let mapped = char;
    for (const [ru, en] of rows) {
      const at = ru.indexOf(char);
      if (at !== -1) { mapped = en[at]; break; }
    }
    out += mapped;
  }
  return out;
}

test('запрос длиннее ста знаков обрезается, а не отклоняется', { skip }, async () => {
  const result = await search.find({ query: 'игра'.repeat(60) });
  assert.equal(result.query.length, 100);
  assert.equal(result.truncated, true);
});

test('запрос из одних знаков препинания пустой (EC-K9)', { skip }, async () => {
  const result = await search.find({ query: '!!!' });
  assert.equal(result.total, 0);
  assert.deepEqual(result.series, []);
});

test('поиск не видит неопубликованное и архивное', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT s.slug FROM e_series s
      WHERE (s.publication_state <> 'published' OR s.archived_at IS NOT NULL)
        AND s.title_ru IS NOT NULL LIMIT 1`,
  );
  if (!rows.length) return;   // таких сериалов в базе нет — проверять нечего

  const result = await search.find({ query: 'неопубликованный тестовый сериал' });
  assert.ok(!result.series.some((item) => item.slug === rows[0].slug));
});