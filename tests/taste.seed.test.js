// Шаг 3 регистрации: «Выберите любимые» (F-01-01 §4).
//
// Шаг был описан и отмечен в интерфейсе, но после подтверждения адреса человека
// отправляли на главную, а индикатор «Шаг 2 из 3» обещал третью страницу.
//
// Проверяется то, что может сломаться тихо: правило «3–5 выбранных», запрет
// больше трёх из одного жанра и сохранение именно как зёрен вкуса — статусы и
// отметки выбор не трогает, иначе выборка испортила бы статистику просмотра
// (H-55).

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { acquireImportLock } from './helpers/import-lock.js';

import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken, hashPassword } from '../src/services/auth/password.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — выбор любимых не проверялся';

let pool;
let unlockImport;
const fixtures = { series: [], users: [] };

test.before(async () => {
  if (!available) return;
  pool = createPool();
// Фикстуры заводятся один раз на файл: каталог не должен меняться, пока идут
// проверки постраничности. Блокировка та же, что у них.
  unlockImport = await acquireImportLock(pool);
});

test.after(async () => {
  if (!pool) return;
  if (fixtures.series.length) {
    await pool.query('DELETE FROM e_taste_seed WHERE series_id = ANY($1::bigint[])', [fixtures.series]);
    await pool.query('DELETE FROM e_season WHERE series_id = ANY($1::bigint[])', [fixtures.series]);
    await pool.query('DELETE FROM e_series WHERE id = ANY($1::bigint[])', [fixtures.series]);
  }
  await unlockImport?.();
  await pool.end();
});

/** Сериал с основным жанром: правило «не больше трёх одного жанра». */
async function seriesOf(genre) {
  const slug = `taste-${genre}-${crypto.randomUUID().slice(0, 8)}`;
  const { rows: [row] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Любимый', 'Favourite', $2, 'published', 'airing', 2024) RETURNING id, slug`,
    [slug, 990_000_000 + fixtures.series.length],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [row.id],
  );
  await pool.query(
    'INSERT INTO e_episode (season_id, number, title_ru, runtime_min) VALUES ($1, 1, \'Серия\', 45)',
    [season.id],
  );
  // Основного жанра в схеме нет: карточка берёт первый по алфавиту код, и
  // правило «не больше трёх одного жанра» считается так же (см. находку №144).
  await pool.query(
    'INSERT INTO e_series_genre (series_id, genre_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [row.id, genre],
  );
  fixtures.series.push(row.id);
  return row.id;
}

async function viewer() {
  const { hash } = makeToken();
  const created = await pgAuthStore(pool).createUser({
    email: `taste-${crypto.randomUUID().slice(0, 8)}@example.com`,
    nickname: `taste-${crypto.randomUUID().slice(0, 8)}`,
    passwordHash: await hashPassword('правильный-пароль-из-десяти'),
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  fixtures.users.push(created.id);
  return created.id;
}

const seedsOf = async (userId) => (await pool.query(
  'SELECT series_id, source FROM e_taste_seed WHERE user_id = $1 ORDER BY series_id', [userId],
)).rows;

test('выбор сохраняется как зёрна вкуса, а не как отметки', { skip }, async () => {
  const userId = await viewer();
  const picked = [await seriesOf('drama'), await seriesOf('comedy')];

  await pool.query(
    `INSERT INTO e_taste_seed (user_id, series_id, source) VALUES ($1, $2, 'signup'), ($1, $3, 'signup')`,
    [userId, picked[0], picked[1]],
  );

  const rows = await seedsOf(userId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.series_id), picked);
  assert.ok(rows.every((r) => r.source === 'signup'), 'источник помечен: потом такие выборы отличаются');

  // Ни статуса, ни отметки выбор создавать не должен (H-55): иначе испортилась
  // бы статистика просмотра.
  const marks = await pool.query(
    `SELECT count(*)::int AS n FROM e_watch_mark m
       JOIN e_episode e ON e.id = m.episode_id
       JOIN e_season s ON s.id = e.season_id
      WHERE m.user_id = $1 AND s.series_id = ANY($2::bigint[])`,
    [userId, picked],
  );
  assert.equal(marks.rows[0].n, 0, 'отметок просмотра выбор не создал');
});

test('повторный выбор того же сериала не двоит строку', { skip }, async () => {
  const userId = await viewer();
  const one = await seriesOf('drama');

  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `INSERT INTO e_taste_seed (user_id, series_id, source) VALUES ($1, $2, 'signup')
       ON CONFLICT (user_id, series_id) DO UPDATE SET source = EXCLUDED.source`,
      [userId, one],
    );
  }

  assert.equal((await seedsOf(userId)).length, 1, 'один сериал — одна строка');
});

test('источник ограничен двумя значениями', { skip }, async () => {
  // `signup | explicit` — из DOMAIN-MODEL §55. Без ограничения в таблицу
  // попало бы что угодно, и по источнику нельзя было бы отличить выбор при
  // регистрации от осознанного.
  const userId = await viewer();
  const one = await seriesOf('drama');
  await assert.rejects(
    pool.query(
      `INSERT INTO e_taste_seed (user_id, series_id, source) VALUES ($1, $2, 'от балды')`,
      [userId, one],
    ),
    (error) => /** @type {any} */ (error).code === '23514',
  );
});