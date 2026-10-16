// Подписки на выходы (F-03-07, H-70).
//
// Проверяется против живой базы: правило H-70 живёт в `ON CONFLICT` двух
// таблиц, и «работает» оно только когда статус и подписка меняются вместе.
//
// Главное, что здесь защищается, — разделение ручного и автоматического:
// человек, выключивший колокольчик, должен остаться без уведомлений, даже
// если снова поставит статус «Смотрю» (EC-T19). Без пометки источника это
// правило выглядит работающим ровно до первого же смены статуса.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';
import { pgWatchStatus } from '../src/services/tracking/status.js';
import { pgSubscriptions } from '../src/services/tracking/subscription.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — подписки не проверялись';

let pool;
let subscriptions;
let status;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  subscriptions = pgSubscriptions(pool);
  status = pgWatchStatus(pool);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM e_subscription WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)', ['sb-%']);
  await pool.query('DELETE FROM e_watch_status WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)', ['sb-%']);
  await pool.query('DELETE FROM e_series WHERE slug LIKE $1', ['sb-%']);
  await pool.query('DELETE FROM e_user WHERE nickname LIKE $1', ['sb-%']);
  await pool.end();
});

/** Зритель и сериал; сериалов столько, сколько попросили. */
async function fixture(seriesCount = 1) {
  const { token, hash } = makeToken();
  const id = `sb-${crypto.randomUUID()}`;
  void token;
  const user = await pgAuthStore(pool).createUser({
    email: `${id}@example.com`,
    nickname: id,
    passwordHash: '$argon2id$заглушка',
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
  });

  const series = [];
  for (let index = 0; index < seriesCount; index += 1) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
       VALUES ($1, 'Подписка: фикстура', 'Subscription fixture', $2, 'published', 'airing', 2020) RETURNING id`,
      [`${id}-${index}`, 994000000 + (Number(id.replace(/\D/g, '').slice(0, 4)) || 1) * 10 + index],
    );
    series.push(row);
  }

  return { userId: user.id, series };
}

async function rowOf(userId, seriesId) {
  const { rows } = await pool.query(
    'SELECT kind, source, enabled FROM e_subscription WHERE user_id = $1 AND series_id = $2',
    [userId, seriesId],
  );
  return rows[0] ?? null;
}

test('у гостя подписки нет, и это не ошибка', { skip }, async () => {
  const f = await fixture();

  assert.equal(await subscriptions.state(null, f.series[0].id), null,
    'гостю нечего показывать: колокольчик без сессии всё равно не сработал бы');
});

test('колокольчик включает подписку вручную', { skip }, async () => {
  const f = await fixture();

  const result = await subscriptions.toggle({ userId: f.userId, seriesId: f.series[0].id, on: true });
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(result.source, 'manual');

  const row = await rowOf(f.userId, f.series[0].id);
  assert.equal(row.source, 'manual', 'человек нажал — значит решение человеческое');
});

test('повторное включение не создаёт вторую строку (EC-T1)', { skip }, async () => {
  const f = await fixture();

  await subscriptions.toggle({ userId: f.userId, seriesId: f.series[0].id, on: true });
  const again = await subscriptions.toggle({ userId: f.userId, seriesId: f.series[0].id, on: true });
  assert.equal(again.ok, true, 'повтор «включить» — не ошибка');

  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM e_subscription WHERE user_id = $1 AND series_id = $2',
    [f.userId, f.series[0].id],
  );
  assert.equal(rows[0].n, 1);
});

test('выключение вручную запоминается и не выглядит автоматикой (EC-T19)', { skip }, async () => {
  const f = await fixture();

  // Сначала автоматика включила подписку статусом «Смотрю».
  await status.set({ userId: f.userId, seriesId: f.series[0].id, status: 'watching' });
  assert.equal((await rowOf(f.userId, f.series[0].id)).source, 'auto');

  await subscriptions.toggle({ userId: f.userId, seriesId: f.series[0].id, on: false });
  const row = await rowOf(f.userId, f.series[0].id);
  assert.equal(row.enabled, false);
  assert.equal(row.source, 'manual',
    'источник обязан стать ручным: иначе следующая смена статуса включила бы подписку обратно');
});

test('после ручного выключения «Смотрю» подписку не включает (EC-T19)', { skip }, async () => {
  const f = await fixture();

  await status.set({ userId: f.userId, seriesId: f.series[0].id, status: 'watching' });
  await subscriptions.toggle({ userId: f.userId, seriesId: f.series[0].id, on: false });

  await status.set({ userId: f.userId, seriesId: f.series[0].id, status: 'dropped' });
  await status.set({ userId: f.userId, seriesId: f.series[0].id, status: 'watching' });

  const row = await rowOf(f.userId, f.series[0].id);
  assert.equal(row.enabled, false,
    'человек отказался от уведомлений — иначе отказаться было бы невозможно');
});

test('ручное включение переживает смену статуса (EC-T19)', { skip }, async () => {
  const f = await fixture();

  await status.set({ userId: f.userId, seriesId: f.series[0].id, status: 'dropped' });
  await subscriptions.toggle({ userId: f.userId, seriesId: f.series[0].id, on: true });

  await status.set({ userId: f.userId, seriesId: f.series[0].id, status: 'watching' });

  const row = await rowOf(f.userId, f.series[0].id);
  assert.equal(row.enabled, true, 'человек подписался на «Брошено» и остался подписан');
});

test('снятый с публикации сериал подписку не включает (EC-T8)', { skip }, async () => {
  const f = await fixture();
  await pool.query("UPDATE e_series SET archived_at = now() WHERE id = $1", [f.series[0].id]);

  const result = await subscriptions.toggle({ userId: f.userId, seriesId: f.series[0].id, on: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'archived');
  assert.equal(await rowOf(f.userId, f.series[0].id), null, 'строки не появилось');
});

test('подписки ограничены `subs.max_per_user`', { skip }, async () => {
  const f = await fixture(2);

  // Заполняем потолок чужими сериалами: правило проверяется на «нельзя», а не
  // на «можно», и заполнять его честными подписками было бы медленно.
  const { rows: [fill] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     SELECT '${f.series[0].id}-fill-' || g, 'Заполнитель', 'Filler', 993000000 + g,
            'published', 'airing', 2020
       FROM generate_series(1, 600) AS g
     RETURNING id`,
  );
  void fill;
  const { rows: fillers } = await pool.query(
    "SELECT id FROM e_series WHERE slug LIKE $1 ORDER BY id",
    [`${f.series[0].id}-fill-%`],
  );
  await pool.query(
    `INSERT INTO e_subscription (user_id, series_id, kind, source, enabled)
     SELECT $1, unnest($2::bigint[]), 'release', 'manual', true`,
    [f.userId, fillers.map((item) => item.id)],
  );

  try {
    const { rows: [count] } = await pool.query(
      'SELECT count(*)::int AS n FROM e_subscription WHERE user_id = $1 AND enabled',
      [f.userId],
    );
    assert.ok(count.n >= 500, `подписок включено ${count.n} — потолок взят`);

    const refused = await subscriptions.toggle({ userId: f.userId, seriesId: f.series[0].id, on: true });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'limit', 'и сказано, что делать: отключить ненужные');
    assert.equal(await rowOf(f.userId, f.series[0].id), null, 'строка не появилась');

    // Выключение лимитом не блокируется: иначе человек не смог бы освободить место.
    const off = await subscriptions.toggle({ userId: f.userId, seriesId: f.series[0].id, on: false });
    assert.equal(off.ok, true);
  } finally {
    await pool.query('DELETE FROM e_subscription WHERE user_id = $1', [f.userId]);
    await pool.query('DELETE FROM e_series WHERE slug LIKE $1', [`${f.series[0].id}-fill-%`]);
  }
});

test('состояния для карточек закладок приходят одним запросом', { skip }, async () => {
  const f = await fixture(3);

  await subscriptions.toggle({ userId: f.userId, seriesId: f.series[0].id, on: true });
  await status.set({ userId: f.userId, seriesId: f.series[1].id, status: 'watching' });
  await status.set({ userId: f.userId, seriesId: f.series[1].id, status: 'watched' });
  await subscriptions.toggle({ userId: f.userId, seriesId: f.series[2].id, on: false });

  const ids = f.series.map((item) => item.id);
  const states = await subscriptions.listOf(f.userId, ids);

  assert.equal(states.size, 3, 'по записи на сериал, даже без подписки');
  assert.equal(states.get(ids[0]).enabled, true);
  assert.equal(states.get(ids[0]).source, 'manual');
  assert.equal(states.get(ids[1]).enabled, false, 'статус «Просмотрено» выключил подписку');
  assert.equal(states.get(ids[2]).enabled, false);
  assert.equal(states.get(ids[2]).source, 'manual', 'выключил человек');
});

test('получатели уведомлений — только подписчики видимых сериалов (F-03-07 §17, EC-T8)', { skip }, async () => {
  const f = await fixture(2);
  await subscriptions.toggle({ userId: f.userId, seriesId: f.series[0].id, on: true });

  // Подписка на второй сериал могла появиться до того, как его сняли с
  // публикации: строка в таблице остаётся, а получателем он быть не должен.
  await subscriptions.toggle({ userId: f.userId, seriesId: f.series[1].id, on: true });
  await pool.query('UPDATE e_series SET archived_at = now() WHERE id = $1', [f.series[1].id]);

  const recipients = await subscriptions.recipientsOf([f.series[0].id, f.series[1].id]);
  assert.deepEqual(recipients, [{ userId: f.userId, seriesId: f.series[0].id }],
    'снятый с публикации сериал в список получателей не попадает — уведомлять о нём не о чем');
});

test('чужую подписку не видно (R-SEC-10)', { skip }, async () => {
  const mine = await fixture();
  const theirs = await fixture();
  await subscriptions.toggle({ userId: theirs.userId, seriesId: theirs.series[0].id, on: true });

  const states = await subscriptions.listOf(mine.userId, [theirs.series[0].id]);
  const seen = states.get(theirs.series[0].id);
  assert.ok(!seen?.enabled, 'у чужого зрителя подписки нет');
});
