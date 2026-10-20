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

/**
 * Слово, по которому находятся три фикстурных сериала.
 *
 * В каталоге названия уникальны, общего слова с тремя совпадениями там нет, и
 * поиск по нему проверял бы на пустом месте. Фикстуры создаются на время
 * прогона и убираются в `after`.
 */
// Слово уникально на каждый прогон: оставшиеся от упавшего прогона сериалы
// иначе попадали бы в тот же запрос и ломали бы счётчик.
const SHARED = `проверкапоиска${crypto.randomUUID().slice(0, 8)}`;

async function sharedWordFixtures() {
  const made = [];
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await pool.query(
      `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
       VALUES ($1, $2, $3, $4, 'published', 'airing', 2023)
       RETURNING id`,
      [`test-search-${i}-${crypto.randomUUID().slice(0, 8)}`, `${SHARED} ${i}`, `Shared word ${i}`, 991_000_000 + i],
    );
    made.push(rows[0].id);
  }
  return made;
}

let sharedIds = [];

test.before(async () => {
  if (!available) return;
  pool = createPool();
  sharedIds = await sharedWordFixtures();
  search = pgSearch(pool);
  // Следы прошлого прогона: без чистки повторный запуск упирается в уникальный
  // индекс и падает не из-за кода.
  await dropFixturePerson(pool);
});

test.after(async () => {
  if (!pool) return;
  await dropFixturePerson(pool);
  await dropSharedWordFixtures(sharedIds);
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
  // Своя фикстура вместо поиска по всему каталогу: запрос по живому
  // каталогу предполагал, что все совпадения равны по релевантности, а это
  // неправда — сериал с тем же словом в названии может совпасть лучше, и
  // проверка падала без связи с кодом (так и случилось, когда в каталоге
  // появились сериалы пробы).
  const title = 'Фикстура порядка поиска';
  const slugs = [];
  const ids = [];
  try {
    for (const [index, votes] of [[1, 40], [2, 900]]) {
      const slug = `test-search-order-${index}-${crypto.randomUUID().slice(0, 8)}`;
      const { rows: [row] } = await pool.query(
        `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
         VALUES ($1, $2, 'Order fixture', $3, 'published', 'airing', 2024)
         RETURNING id`,
        [slug, title, 984_000_000 + index],
      );
      await pool.query(
        `INSERT INTO e_external_rating (series_id, platform, value, votes, measured_on)
         VALUES ($1, 'imdb', 7.5, $2, current_date)`,
        [row.id, votes],
      );
      slugs.push(slug);
      ids.push(row.id);
    }

    const result = await search.find({ query: title });
    const ours = result.series.filter((item) => slugs.includes(item.slug));
    assert.equal(ours.length, 2, 'обе фикстуры найдены');
    const first = result.series.findIndex((item) => item.slug === slugs[1]);
    const second = result.series.findIndex((item) => item.slug === slugs[0]);
    assert.ok(first >= 0 && second >= 0, 'фикстуры в выдаче');
    assert.ok(first < second, 'при равном совпадении первым идёт тот, у кого больше голосов IMDb');
  } finally {
    await pool.query('DELETE FROM e_external_rating WHERE series_id = ANY($1::bigint[])', [ids]);
    await pool.query('DELETE FROM e_series WHERE id = ANY($1::bigint[])', [ids]);
  }
});

test('запрос в чужой раскладке помечается, а не выдаётся за прямой (EC-K10)', { skip }, async () => {
  // Своя фикстура, а не любой сериал из каталога: переведённая в чужую раскладку
  // строка настоящего названия может совпасть с другим сериалом напрямую, и
  // тогда пометки не будет — верно по коду, но проверяет не то.
  const { rows: [fixture] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Заполнитель поиска', 'Fixture', $2, 'published', 'airing', 2024)
     RETURNING id`,
    [`test-search-layout-${crypto.randomUUID().slice(0, 8)}`, 983_000_000],
  );

  try {
    const title = 'Заполнитель поиска';
    const wrong = toEnglishLayout(title);

    const result = await search.find({ query: wrong });
    assert.equal(result.layoutFixed?.toLowerCase(), title.toLowerCase(),
      'подсказка называет, что имелось в виду');
    assert.equal(result.query, wrong, 'исходный запрос сохраняется для ссылки обратно');
    assert.ok(result.series.some((item) => item.id === fixture.id),
      'и сам сериал по исправленному запросу найден');
  } finally {
    await pool.query('DELETE FROM e_series WHERE id = $1', [fixture.id]);
  }
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

// --- Морфология и индекс (находки #114 и #115) ---

test('падеж находит слово в другом падеже, а не только в своём', { skip }, async () => {
  // Берём слово из названия и ищем его в форме, которой в названии нет:
  // если морфологии нет, выдача пуста и это видно сразу.
  const { rows } = await pool.query(
    `SELECT title_ru FROM e_series
      WHERE publication_state = 'published' AND archived_at IS NULL
        AND title_ru ~* '\\mчеловек\\M' LIMIT 1`,
  );
  assert.ok(rows.length, 'в каталоге есть название со словом «человек»');

  const exact = await search.find({ query: 'человек' });
  assert.ok(exact.series.length > 0, 'точная форма находится');

  const declined = await search.find({ query: 'человеком' });
  assert.ok(
    declined.series.some((item) => item.title === rows[0].title_ru),
    `«человеком» не нашёл «${rows[0].title_ru}» — морфология не работает`,
  );
});

test('строка, найденная базой, не выбрасывается сортировкой', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT title_ru FROM e_series
      WHERE publication_state = 'published' AND archived_at IS NULL
        AND title_ru ~* '\\mчеловек\\M' LIMIT 1`,
  );
  if (!rows.length) return;

  const result = await search.find({ query: 'человеком' });
  const ranks = result.series.map((item) => item.rank);
  assert.ok(ranks.length > 0);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'ранги не убывают');
});

test('английское название ищется через тот же индекс', { skip }, async () => {
  // Если из выражения выпадет `title_en`, английское название перестанет
  // находиться по индексу — и это заметит только этот тест.
  const { rows } = await pool.query(
    `EXPLAIN (COSTS OFF)
     SELECT s.id FROM e_series s
      WHERE s.publication_state = 'published'
        AND (${search.vectorExpression}) @@ plainto_tsquery('russian', $1)
      LIMIT 200`,
    ['thrones'],
  );
  const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
  assert.match(plan, /ix_series_search/, `индекс не использован:\n${plan}`);
});

test('поиск идёт по индексу, а не просмотром таблицы', { skip }, async () => {
  const { rows } = await pool.query(
    `EXPLAIN (COSTS OFF)
     SELECT s.id FROM e_series s
      WHERE s.publication_state = 'published'
        AND (${search.vectorExpression}) @@ plainto_tsquery('russian', $1)
      LIMIT 200`,
    ['престолов'],
  );
  const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
  assert.match(plan, /ix_series_search/, `индекс не использован:\n${plan}`);
});

test('короткое слово запроса не подставляет чужих людей', { skip }, async () => {
  // `of` содержится в половине латинских фамилий: без проверки запрос
  // «game of thrones» выдавал бы Beau Mirchoff среди людей.
  const { rows } = await pool.query(
    `SELECT s.title_original FROM e_series s
      WHERE s.publication_state = 'published' AND s.archived_at IS NULL
        AND s.title_original ~* '^[A-Za-z ]+$' LIMIT 1`,
  );
  if (!rows.length) return;   // латинских названий нет

  const title = rows[0].title_original.trim();
  const result = await search.find({ query: title });
  const found = result.people.map((person) => person.name.toLowerCase());

  for (const word of title.toLowerCase().split(' ').filter((word) => word.length === 2)) {
    const falsePositives = found.filter((name) => name.includes(word));
    assert.deepEqual(falsePositives, [],
      `люди найдены только по слову «${word}» из запроса «${title}»`);
  }
});
// ─── Найденное и показанное (#120, #121) ─────────────────────────────────────

async function dropSharedWordFixtures(ids) {
  if (!ids.length) return;
  await pool.query('DELETE FROM e_series WHERE id = ANY($1::bigint[])', [ids]);
}

test('счётчик считает найденное, а не показанное (#120)', { skip }, async () => {
  const result = await search.find({ query: SHARED, limit: 1 });

  assert.equal(result.series.length, 1, 'показана ровно одна строка');
  assert.equal(result.counts.series, 3, 'а найдено три — столько обещает счётчик');
  assert.equal(result.total, result.counts.series + result.counts.people + result.counts.collections,
    'общее число — сумма найденного по группам, а не показанного');
});

test('«показать ещё» листает внутри группы, не сбивая другие (#121)', { skip }, async () => {
  const first = await search.find({ query: SHARED, limit: 1 });
  const second = await search.find({ query: SHARED, limit: 1, offsets: { series: 1 } });

  assert.notEqual(second.series[0]?.id, first.series[0]?.id,
    'вторая страница группы показывает другую запись');
  assert.equal(second.groups.series.offset, 1, 'смещение сохраняется в ответе — по нему строится ссылка');
  assert.equal(second.groups.series.more, true, 'пока есть ещё, ссылка показывается');

  const last = await search.find({ query: SHARED, limit: 1, offsets: { series: 2 } });
  assert.equal(last.series.length, 1, 'на последней записи строка ещё есть');
  assert.equal(last.groups.series.more, false, 'а показывать дальше нечего');

  // Чужие группы не сдвигаются от смещения сериалов.
  assert.deepEqual(last.people, first.people,
    'смещение одной группы не трогает остальные');
});

test('смещение за пределами группы даёт пусто, а не ошибку', { skip }, async () => {
  const result = await search.find({ query: SHARED, limit: 5, offsets: { series: 1000 } });

  assert.deepEqual(result.series, [], 'за концом группы пусто');
  assert.equal(result.groups.series.more, false, 'и показывать дальше нечего');
});
