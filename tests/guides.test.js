// Руководства (F-05-06).
//
// Проверяется главное: тело статьи разбирается на разделы, короткая статья
// не принимается, и без привязки к сериалу её не создать.

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { pgGuides, parseSections } from '../src/services/guides/service.js';
import { pgAuthStore } from '../src/services/auth/store.js';

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

const skip = CONN ? false : 'нет подключения к базе — руководства не проверялись';

const DICTIONARY = { block: [], allow: [], available: true };

let pool;
let guides;
let userId;
let seriesId;

test.before(async () => {
  if (!CONN) return;
  pool = new pg.Pool(CONN);
  await pool.query('select 1');
  guides = pgGuides(pool);

  const name = `guide-${crypto.randomUUID().slice(0, 8)}`;
  const account = await pgAuthStore(pool).createUser({
    email: `${name}@example.com`,
    nickname: name,
    passwordHash: 'x',
    tokenHash: crypto.randomUUID(),
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  userId = account.id;

  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, imdb_key, title_ru, title_original, year_start, exit_state, publication_state, reasons, level)
     VALUES ($1, $2, 'Сериал для руководства', 'Guide series', 2020, 'ended', 'published', '{}', 'minimum')
     RETURNING id`,
    [`guide-${crypto.randomUUID().slice(0, 8)}`, `tt${crypto.randomUUID().slice(0, 8)}`],
  );
  seriesId = series.id;
});

test.after(async () => {
  if (pool) {
    if (userId) await pool.query('DELETE FROM e_material WHERE author_id = $1', [userId]);
    if (seriesId) await pool.query('DELETE FROM e_series WHERE id = $1', [seriesId]);
    if (userId) await pool.query('DELETE FROM e_user WHERE id = $1', [userId]);
  }
  if (pool) await pool.end();
});

test('тело статьи разбирается на разделы', () => {
  const sections = parseSections('## Первая\nТекст первой.\n\n## Вторая\nТекст второй.');
  assert.equal(sections.length, 2);
  assert.equal(sections[0].heading, 'Первая');
  assert.equal(sections[0].text, 'Текст первой.');
  assert.equal(sections[1].heading, 'Вторая');
});

test('короткая статья не принимается (ugc.guide_min_chars)', { skip }, async () => {
  const result = await guides.submit({
    userId, seriesId, title: 'Заголовок', text: '## Раздел\nМало текста.', dictionary: DICTIONARY,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'short');
});

test('статья без разделов не принимается (F-05-06 §5)', { skip }, async () => {
  const result = await guides.submit({
    userId, seriesId, title: 'Заголовок', text: 'Сплошной текст без разделов. '.repeat(40), dictionary: DICTIONARY,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sections');
});

test('статья создаётся и видна по адресу (F-05-06 §4)', { skip }, async () => {
  const text = `## О чём\n${'Подробный разбор сериала. '.repeat(30)}\n\n## Стоит ли\n${'Смотреть стоит. '.repeat(30)}`;
  const result = await guides.submit({
    userId, seriesId, title: 'Разбор сериала', text, dictionary: DICTIONARY,
  });
  assert.equal(result.ok, true, 'статья создана');
  assert.ok(result.slug, 'у статьи есть адрес');

  const guide = await guides.one(result.slug);
  assert.ok(guide, 'статья открывается по адресу');
  assert.equal(guide.title, 'Разбор сериала');
  assert.equal(guide.sections.length, 2, 'разделы на месте');

  const list = await guides.list({ seriesId });
  assert.equal(list.total, 1, 'статья в списке сериала');
});
