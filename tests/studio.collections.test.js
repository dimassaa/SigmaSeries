// Подборки студии и справочники (F-10-07, F-10-10).
//
// Проверяется то, что легко сломать: порядок сериалов, порог публикации и
// запрет менять шкалу платформы, у которой уже есть оценки.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

import { pgStudioCollections, MIN_VISIBLE_SERIES } from '../src/services/studio/collections.js';
import { pgStudioDictionaries } from '../src/services/studio/dictionaries.js';

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

const skip = CONN ? false : 'нет подключения к базе — подборки не проверялись';

let pool;
let collections;
let dictionaries;
let slug;

test.before(async () => {
  if (!CONN) return;
  pool = new pg.Pool(CONN);
  await pool.query('select 1');
  collections = pgStudioCollections(pool);
  dictionaries = pgStudioDictionaries(pool);
  slug = `check-collection-${crypto.randomUUID().slice(0, 8)}`;
});

test.after(async () => {
  if (pool && slug) {
    await pool.query(
      `DELETE FROM e_collection_item WHERE collection_id = (SELECT id FROM e_collection WHERE slug = $1)`,
      [slug],
    );
    await pool.query('DELETE FROM e_collection WHERE slug = $1', [slug]);
  }
  if (pool) await pool.end();
});

test('черновик создаётся и виден в списке (F-10-07 §4)', { skip }, async () => {
  const saved = await collections.save({
    slug,
    title: 'Подборка для проверки',
    description: 'Описание подборки.',
    weight: 5,
    active: false,
    seriesIds: [],
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.slug, slug);

  const list = await collections.list();
  const found = list.find((item) => item.slug === slug);
  assert.ok(found, 'подборка в списке');
  assert.equal(found.weight, 5);
  assert.equal(found.state, 'draft');
});

test('публикация пустой подборки закрыта с перечнем причин (F-10-07 §5)', { skip }, async () => {
  const attempt = await collections.save({
    slug, title: 'Подборка для проверки', description: 'Описание подборки.',
    weight: 5, active: true, seriesIds: [],
  });
  assert.equal(attempt.ok, false, 'пустую подборку опубликовать нельзя');
  assert.equal(attempt.reason, 'blocked');
  assert.deepEqual(attempt.blockers, ['few_series', 'no_banner'],
    'перечень назван в порядке §5: сериалы, затем баннер');
  const row = (await collections.list()).find((item) => item.slug === slug);
  assert.equal(row.state, 'draft', 'после отказа ничего не сместилось');
});

test('состояние следует за жизнью: причины на пустой, публикация с шестью, авто-скрытие (§5, §6, EC-C6)', { skip }, async () => {
  const mine = `check-state-${crypto.randomUUID().slice(0, 8)}`;
  try {
    // Черновик без описания: публиковать нечего, перечислены все причины.
    const draft = await collections.save({
      slug: mine, title: 'Проверка состояний', weight: 1, active: false, seriesIds: [],
    });
    assert.equal(draft.ok, true);
    let one = await collections.one(mine);
    assert.deepEqual(one.publishBlockers, ['few_series', 'no_description_ru', 'no_banner'],
      'порядок причин — как в §5: сериалы, описание, баннер');
    assert.equal(one.state, 'draft');

    // Включение при нуле сериaлов отказано:IRONMENT_visible=0, нужно описание, баннер ни своего, ни фона.
    const emptyPublish = await collections.save({
      slug: mine, title: 'Проверка состояний', weight: 1, active: true, seriesIds: [],
    });
    assert.equal(emptyPublish.ok, false);
    assert.equal(emptyPublish.reason, 'blocked');
    one = await collections.one(mine);
    assert.equal(one.state, 'draft', 'после отказа состояние — черновик');

    // Взяли шесть видимых сериaлов и назначили свой баннер: закрыта только причина описания.
    const { rows: six } = await pool.query(
      `SELECT id FROM e_series
        WHERE publication_state = 'published' AND archived_at IS NULL
       ORDER BY id LIMIT $1`,
      [MIN_VISIBLE_SERIES],
    );
    const ids = six.map((row) => row.id);
    await collections.save({
      slug: mine, title: 'Проверка состояний', weight: 1, active: false, seriesIds: ids,
    });
    // Баннер «свой»: тест обязан быть детерминированным, а не зависеть от того,
    // есть ли фон у первого сериаала из выборки.
    await pool.query(
      `UPDATE e_collection SET banner_image_id =
         (SELECT id FROM e_image WHERE role = 'backdrop' ORDER BY id LIMIT 1)
        WHERE slug = $1`,
      [mine],
    );
    one = await collections.one(mine);
    assert.deepEqual(one.publishBlockers, ['no_description_ru']);

    const withoutDescription = await collections.save({
      slug: mine, title: 'Проверка состояний', weight: 1, active: true, seriesIds: ids,
    });
    assert.equal(withoutDescription.ok, false);
    assert.deepEqual(withoutDescription.blockers, ['no_description_ru']);

    const published = await collections.save({
      slug: mine, title: 'Проверка состояний', description: 'Описание.',
      weight: 1, active: true, seriesIds: ids,
    });
    assert.equal(published.ok, true);
    one = await collections.one(mine);
    assert.equal(one.state, 'published');

    // Пара серий снялась: EC-C6 — подборка скрывается сама, блокировок нет.
    await pool.query(
      'DELETE FROM e_collection_item WHERE collection_id = $1 AND series_id >= $2',
      [one.id, ids[4]],
    );
    one = await collections.one(mine);
    assert.equal(one.state, 'auto_hidden', 'опустевшая активная подборка — авто-скрытие');
    assert.deepEqual(one.publishBlockers, ['few_series']);
  } finally {
    await pool.query('DELETE FROM e_collection_item WHERE collection_id = (SELECT id FROM e_collection WHERE slug = $1)', [mine]);
    await pool.query('DELETE FROM e_collection WHERE slug = $1', [mine]);
  }
});

test('создание подборки без slug: авто-имя и правильные столбцы INSERT (№246)', { skip }, async () => {
  const auto = await collections.save({
    slug: null, title: 'Создание по авто-slug', description: 'Создано из пустой формы обращения.',
    weight: 2, active: false, seriesIds: null,
  });
  assert.equal(auto.ok, true);
  assert.match(auto.slug ?? '', /^[a-z0-9-]{1,120}$/, 'slug сгенерирован из названия');
  const list = await collections.list();
  const row = list.find((item) => item.slug === auto.slug);
  assert.ok(row, 'созданная подборка попала в список');
  assert.equal(row.title, 'Создание по авто-slug', 'название и столбцы записались целиком');

  await pool.query('DELETE FROM e_collection WHERE slug = $1', [auto.slug]);
});

test('порог публикации — шесть видимых сериалов (F-10-07 §5)', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT id FROM e_series
      WHERE publication_state = 'published' AND archived_at IS NULL
      ORDER BY id LIMIT $1`,
    [MIN_VISIBLE_SERIES],
  );
  const ids = rows.map((row) => row.id);
  await pool.query(
    `UPDATE e_collection SET banner_image_id =
       (SELECT id FROM e_image WHERE role = 'backdrop' ORDER BY id LIMIT 1)
      WHERE slug = $1`,
    [slug],
  );
  const saved = await collections.save({
    slug, title: 'Подборка для проверки', description: 'Описание подборки.', weight: 5,
    active: true, seriesIds: ids,
  });
  assert.equal(saved.ok, true);
  const one = await collections.one(slug);
  assert.equal(one.visibleSeries, MIN_VISIBLE_SERIES);
  assert.deepEqual(one.publishBlockers, [], 'при шести сериалах публикация открыта');

  // Пять сериалов — уже опубликованную подборку правим свободно, §5 закрывает
  // только переход в публикацию; EC-C6 показывает «скрыта автоматически».
  const short = await collections.save({
    slug, title: 'Подборка для проверки', description: 'Описание подборки.', weight: 5,
    active: true, seriesIds: ids.slice(0, MIN_VISIBLE_SERIES - 1),
  });
  assert.equal(short.ok, true, 'правка активной подборки не блокируется');
  const afterShort = await collections.one(slug);
  assert.equal(afterShort.visibleSeries, MIN_VISIBLE_SERIES - 1);
  assert.equal(afterShort.state, 'auto_hidden',
    'сократившаяся активная подборка скрыта автоматикой, а не отказом формы');

  // Состав вернули на шесть: фикстура остаётся «опубликованной» для соседних тестов.
  await collections.save({
    slug, title: 'Подборка для проверки', description: 'Описание подборки.', weight: 5,
    active: true, seriesIds: ids,
  });
});

test('порядок меняется кнопками так же, как перетаскиванием (F-10-07 §18)', { skip }, async () => {
  const one = await collections.one(slug);
  const ids = one.items.map((item) => item.seriesId);
  const moved = await collections.reorder({
    collectionId: one.id, seriesId: ids[2], where: 'first',
  });
  assert.equal(moved, true, 'перестановка выполнена');
  const after = await collections.one(slug);
  assert.equal(after.items[0].seriesId, ids[2], 'сериал встал в начало');
});

test('вес подборки — целое от 0 до 999 (F-10-07 §9)', { skip }, async () => {
  const bad = await collections.save({ slug, title: 'Название', weight: 1000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'weight');
});

test('справочник жанров читается и правится (F-10-10 §4)', { skip }, async () => {
  const genres = await dictionaries.genres();
  assert.ok(genres.length > 0, 'жанры есть');
  const raw = genres.find((genre) => genre.raw);
  assert.ok(raw, 'сырые жанры импорта помечены');

  const saved = await dictionaries.saveGenre({
    code: 'check-genre', nameRu: 'Жанр для проверки', nameEn: 'Check genre', active: true,
  });
  assert.equal(saved.ok, true);
  const after = await dictionaries.genres();
  assert.ok(after.some((genre) => genre.code === 'check-genre'));

  await pool.query('DELETE FROM e_genre WHERE code = $1', ['check-genre']);
});

test('подпорка описания: пустое имя не принимается, форма с описанием правится (F-10-10 §4)', { skip }, async () => {
  // Сохранение жанров затирает дружественные названия через upsert, поэтому
  // фикстура удаляется сразу после.
  const code = `check-genre-${crypto.randomUUID().slice(0, 8)}`;
  const saved = await dictionaries.saveGenre({
    code, nameRu: 'Жанр с описанием', nameEn: 'Described genre', active: true,
    descriptionRu: 'Описаний много не бывает',
    descriptionEn: 'More descriptions',
    displayOrder: 3,
    showInMenu: true,
  });
  assert.equal(saved.ok, true);

  const row = (await dictionaries.genres()).find((genre) => genre.code === code);
  assert.ok(row, 'жанр из формы перечитан');
  assert.equal(row.descriptionRu, 'Описаний много не бывает');
  assert.equal(row.descriptionEn, 'More descriptions');
  assert.equal(row.displayOrder, 3);
  assert.equal(row.showInMenu, true, 'флаг «показывать в меню» сохранён');

  const bad = await dictionaries.saveGenre({
    code, nameRu: 'Жанр', active: true, displayOrder: 'два',
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'order', 'нечисловой порядок отклонён');

  await pool.query('DELETE FROM e_genre WHERE code = $1', [code]);
});

test('шкалу платформы с оценками менять нельзя (F-10-10 §8)', { skip }, async () => {
  const platforms = await dictionaries.platforms();
  const imdb = platforms.find((platform) => platform.code === 'imdb');
  assert.ok(imdb, 'платформа IMDb есть');
  if (!imdb.ratings) return;

  const result = await dictionaries.savePlatform({
    code: 'imdb', name: imdb.name, scaleMax: 100, priority: imdb.priority, active: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'scale_in_use', 'шкала защищена');
});

// ─── Правка адреса подборки (№249, F-10-07 §4 «авто, можно править до публикации») ─

test('у черновика адрес правится, строка остаётся одна (№249)', { skip }, async () => {
  const mine = `check-slug-${crypto.randomUUID().slice(0, 8)}`;
  const target = `check-slug-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const created = await collections.save({
      slug: mine, title: 'Адресная правка', weight: 0, active: false,
    });
    assert.equal(created.ok, true);

    const renamed = await collections.save({
      slug: mine, newSlug: target,
      title: 'Адресная правка', weight: 0, active: false,
    });
    assert.equal(renamed.ok, true);
    assert.equal(renamed.slug, target, 'адрес заменён введённым, а не старым');
    const { rows: counted } = await pool.query(
      'SELECT count(*)::int AS n FROM e_collection WHERE slug = $1 OR slug = $2',
      [mine, target],
    );
    assert.equal(counted[0].n, 1, 'строка одна: правка, а не создание второй');
    const one = await collections.one(target);
    assert.ok(one, 'строка открывается по новому адресу');
    assert.equal(one.title, 'Адресная правка', 'поля переехали целиком');
  } finally {
    await pool.query('DELETE FROM e_collection WHERE slug = $1 OR slug = $2', [mine, target]);
  }
});

test('активной подборке адрес не правится: заморозка после публикации (№249, §4)', { skip }, async () => {
  // Активная строка сидируется прямым INSERT: состояние «активна» без
  // состава — дневной свет EC-C6, запрещать его правку теперь обязан сервис.
  const active = `check-slug-locked-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await pool.query(
      `INSERT INTO e_collection (slug, title_ru, description_ru, weight, active, is_demo)
       VALUES ($1, 'Активная для адреса', 'Описание.', 0, TRUE, FALSE)`,
      [active],
    );
    const attempt = await collections.save({
      slug: active, newSlug: `check-slug-x-${crypto.randomUUID().slice(0, 8)}`,
      title: 'Активная для адреса', weight: 0, active: true,
    });
    assert.equal(attempt.ok, false, 'адрес активной подборки не меняется');
    assert.equal(attempt.reason, 'slug_locked');
    const one = await collections.one(active);
    assert.ok(one, 'строка осталась на исходном адресе');

    // Очистка поля на активной строке — тоже попытка смены адреса: авто-имя
    // выдалось бы новым, чтобы заморозка разворачивает и её.
    const cleared = await collections.save({
      slug: active, newSlug: '',
      title: 'Активная для адреса', weight: 0, active: true,
    });
    assert.equal(cleared.ok, false, 'очищенное поле адреса — та же заморозка');
    assert.equal(cleared.reason, 'slug_locked');
  } finally {
    await pool.query('DELETE FROM e_collection WHERE slug = $1', [active]);
  }
});

test('переадресация на чужой адрес отклонена, обе подборки целы (№249, §9)', { skip }, async () => {
  const first = `check-slug-a-${crypto.randomUUID().slice(0, 8)}`;
  const second = `check-slug-b-${crypto.randomUUID().slice(0, 8)}`;
  try {
    for (const one of [first, second]) {
      const made = await collections.save({ slug: one, title: 'Занято', weight: 0, active: false });
      assert.equal(made.ok, true);
    }
    const clash = await collections.save({
      slug: first, newSlug: second, title: 'Занято', weight: 0, active: false,
    });
    assert.equal(clash.ok, false);
    assert.equal(clash.reason, 'slug', 'адрес уникален, второй родитель не перезаписывается');
    const a = await collections.one(first);
    const b = await collections.one(second);
    assert.ok(a && b, 'обе подборки на своих адресах');
  } finally {
    await pool.query('DELETE FROM e_collection WHERE slug = $1 OR slug = $2', [first, second]);
  }
});

test('правка по устаревшему адресу не создаёт дубль — отказ (№249)', { skip }, async () => {
  // Форма, открытая до чужой переадресации, шлёт старый адрес строки:
  // раньше так появлялась вторая подборка, теперь — полный отказ.
  const stale = `check-slug-stale-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const attempt = await collections.save({
      slug: stale, newSlug: stale, title: 'Призрак', weight: 0, active: false,
    });
    assert.equal(attempt.ok, false);
    assert.equal(attempt.reason, 'missed');
    const { rows: counted } = await pool.query(
      'SELECT count(*)::int AS n FROM e_collection WHERE slug = $1', [stale],
    );
    assert.equal(counted[0].n, 0, 'никакой вставки на месте несуществующей правки');
  } finally {
    await pool.query('DELETE FROM e_collection WHERE slug = $1', [stale]);
  }
});

test('при создании адрес можно задать вручную (№249, §4)', { skip }, async () => {
  const manual = `check-slug-manual-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const made = await collections.save({
      slug: null, newSlug: manual,
      title: 'Ручной адрес', weight: 1, active: false,
    });
    assert.equal(made.ok, true);
    assert.equal(made.slug, manual, 'введённый адрес использован, авто-имя не подставлено');

    const bad = await collections.save({
      slug: null, newSlug: 'Недопустимый адрес!',
      title: 'Ручной адрес', weight: 1, active: false,
    });
    assert.equal(bad.ok, false, 'адрес не из латиницы, цифр и дефиса не принят');
    assert.equal(bad.reason, 'slug');
  } finally {
    await pool.query('DELETE FROM e_collection WHERE slug = $1', [manual]);
  }
});

test('очищенное поле адреса — авто-имя из нового названия (№249)', { skip }, async () => {
  const mine = `check-slug-auto-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const created = await collections.save({
      slug: mine, title: 'Старое название', weight: 0, active: false,
    });
    assert.equal(created.ok, true);
    const readdressed = await collections.save({
      slug: mine, newSlug: '', title: 'Совсем другое имя', weight: 0, active: false,
    });
    assert.equal(readdressed.ok, true);
    assert.notEqual(readdressed.slug, mine, 'адрес сгенерирован заново');
    assert.match(readdressed.slug ?? '', /^[a-z0-9-]+-[0-9a-fA-F]{6}$/,
      'формат авто-адреса сохранён: имя из названия и соль');
    assert.ok(await collections.one(readdressed.slug), 'строка открывается по новому адресу');
  } finally {
    await pool.query('DELETE FROM e_collection WHERE slug = $1', [mine]);
  }
});
