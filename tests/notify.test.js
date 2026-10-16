// Уведомления о выходах (F-03-08, OP-09): правила создания и доставки.
//
// Проверяется против живой базы: правила целиком в SQL — локальная дата
// подписчика, ключ дедупликации, потолок списка, свёртка в сводку, — и
// проверяются они только выполнением SQL.
//
// Файл один, а не два, хотя правил два: ежечасный проход и события
// синхронизации делят один курсор задачи в общей базе. Параллельный запуск
// двух файлов означал бы, что один из них ставит курсор, пока другой считает
// «свежую установку», — и проверка падала бы без связи с кодом.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { pgNotifications, STEP } from '../src/services/notify/notification.js';
import { createNotificationSweep } from '../src/services/notify/sweep.js';
import { notifyScheduleChanges } from '../src/services/notify/changes.js';
import { categoryOf, KINDS } from '../src/services/notify/types.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';
import { pgSubscriptions } from '../src/services/tracking/subscription.js';
import { recompute } from '../src/services/tracking/progress.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — уведомления о выходах не проверялись';

let pool;
let notify;
let subscriptions;
let counter = 0;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  notify = pgNotifications(pool);
  subscriptions = pgSubscriptions(pool);
});

/**
 * Фикстура: сериал, сезон, серии и выходы.
 *
 * Свои строки на каждый вызов: `node --test` гоняет файлы параллельно, а база
 * одна, и выход чужого фикстура того же дня сделал бы проверку случайной.
 */
async function fixture({ releases = [], coversSeason = false, archived = false } = {}) {
  counter += 1;
  const id = `nt${String(counter).padStart(5, '0')}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start, archived_at)
     VALUES ($1, 'Уведомления: тест', 'Notify fixture', $2, 'published', 'airing', 2024, $3)
     RETURNING id, slug`,
    [`${id}-${crypto.randomUUID().slice(0, 8)}`, 960000000 + counter, archived ? new Date() : null],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [series.id],
  );

  const episodes = [];
  for (const number of [1, 2, 3]) {
    // eslint-disable-next-line no-await-in-loop
    const { rows: [episode] } = await pool.query(
      `INSERT INTO e_episode (season_id, number, title_ru, runtime_min)
       VALUES ($1, $2, $3, 45) RETURNING id`,
      [season.id, number, `Серия ${number}`],
    );
    episodes.push(episode);
  }

  const made = [];
  for (const date of releases) {
    // eslint-disable-next-line no-await-in-loop
    const { rows: [release] } = await pool.query(
      'INSERT INTO e_release (season_id, release_date, covers_season) VALUES ($1, $2, $3) RETURNING id',
      [season.id, date, coversSeason],
    );
    for (const episode of coversSeason ? episodes : [episodes[0]]) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        'INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)',
        [release.id, episode.id],
      );
    }
    made.push(release);
  }

  return { series, season, episodes, releases: made };
}

/** Аккаунт для подписки. */
async function user({ timezone = 'Europe/Minsk', notificationsEnabled = true, status = 'active' } = {}) {
  counter += 1;
  const id = `ntu${String(counter).padStart(4, '0')}-${crypto.randomUUID().slice(0, 8)}`;
  const { hash } = makeToken();
  const created = await pgAuthStore(pool).createUser({
    email: `${id}-${counter}@example.com`,
    nickname: `${id}-${counter}`,
    passwordHash: '$argon2id$заглушка',
    tokenHash: hash,
    timezone,
    locale: 'ru',
    theme: 'dark',
  });
  await pool.query(
    'UPDATE e_user SET notifications_enabled = $2, status = $3 WHERE id = $1',
    [created.id, notificationsEnabled, status],
  );
  return { ...created, timezone, notificationsEnabled };
}

const sweep = (options = {}) => createNotificationSweep({
  pool,
  notifications: notify,
  digestThreshold: 1000,   // сводка проверяется отдельно и малым порогом
  maxPerUser: 500,
  ...options,
});

const rowsOf = async (userId) => (await pool.query(
  'SELECT kind, params, dedup_key FROM e_notification WHERE user_id = $1 ORDER BY created_at, id',
  [userId],
)).rows;

const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const date = day;   // перенос в этой половине файла читается привычнее как `date(3)`

test.after(async () => {
  if (!pool) return;
  // Уборка по нику, а не по адресу: адрес в `e_user` зашифрован, и отбор по
  // нему был бы не «грязно», а просто нерабочим.
  const people = "(SELECT id FROM e_user WHERE nickname LIKE 'ntu-%')";
  await pool.query(`DELETE FROM e_notification WHERE user_id IN ${people}`);
  await pool.query(`DELETE FROM e_subscription WHERE user_id IN ${people}`);
  await pool.query(`DELETE FROM e_watch_status WHERE user_id IN ${people}`);
  await pool.query(`DELETE FROM e_progress WHERE user_id IN ${people}`);
  await pool.query(`DELETE FROM e_season WHERE series_id IN (SELECT id FROM e_series WHERE slug LIKE 'nt%-%')`);
  await pool.query("DELETE FROM e_series WHERE slug LIKE 'nt%-%'");
  await pool.query("DELETE FROM e_system_setting WHERE key = 'notify.last_sweep_at'");
  await pool.query("DELETE FROM e_user WHERE nickname LIKE 'ntu-%'");
  await pool.end();
});

test('тип уведомления знает категорию, а неизвестный тип — ошибка (F-03-08 §8е)', () => {
  assert.equal(categoryOf('release_today'), 'release');
  assert.equal(categoryOf('import_failed'), 'service');
  assert.equal(Object.keys(KINDS).length, 12, 'в реестре двенадцать типов, лишних нет');
  assert.throws(() => categoryOf('что-то новое'), /неизвестный тип/,
    'уведомление без категории нельзя ни показать, ни отключить — это ошибка кода');
});

test('о выходе сегодня приходит одно уведомление с параметрами для текста', { skip }, async () => {
  const f = await fixture({ releases: [day()] });
  const viewer = await user();
  await subscriptions.toggle({ userId: viewer.id, seriesId: f.series.id, on: true });

  await sweep({ now: new Date() }).run();

  const rows = await rowsOf(viewer.id);
  assert.equal(rows.length, 1, 'подписчик получил одно уведомление');
  assert.equal(rows[0].kind, 'release_today');
  assert.equal(rows[0].dedup_key, `release:${f.series.id}:s1:1:${day()}`,
    'ключ по выходу, а не по строке: ночная синхронизация расписания пересоздаёт'
    + ' выходы, и ключ по идентификатору прислал бы то же самое каждую ночь');
  assert.equal(rows[0].params.date, day());
  assert.equal(rows[0].params.season, 1);
  assert.equal(rows[0].params.seriesSlug, f.series.slug);
  assert.deepEqual(rows[0].params.episodes, [1]);
});

test('первый проход не глотает сегодняшние выходы из-за пояса впереди (EC-T4)', { skip }, async () => {
  // Свежая установка: курсора нет, и верхняя граница уезжает на завтра из-за
  // подписчика в Auckland. Отсчёт от неё проглатывал бы выходы сегодняшнего
  // дня для всех остальных — то есть уведомления терялись бы молча.
  await pool.query("DELETE FROM e_system_setting WHERE key = 'notify.last_sweep_at'");
  const f = await fixture({ releases: [day()] });
  const ahead = await user({ timezone: 'Pacific/Auckland' });
  const viewer = await user();
  for (const one of [ahead, viewer]) {
    // eslint-disable-next-line no-await-in-loop
    await subscriptions.toggle({ userId: one.id, seriesId: f.series.id, on: true });
  }

  await sweep().run();

  assert.equal((await rowsOf(viewer.id)).length, 1, 'выход сегодня дошёл до подписчика в Минске');
});

test('повторный проход не создаёт дублей (F-03-08 §18, EC-T17)', { skip }, async () => {
  const f = await fixture({ releases: [day()] });
  const viewer = await user();
  await subscriptions.toggle({ userId: viewer.id, seriesId: f.series.id, on: true });

  await sweep().run();
  const second = await sweep().run();

  assert.equal(second.created, 0, 'второй проход ничего не создал');
  assert.equal((await rowsOf(viewer.id)).length, 1);
});

test('вышедший вчера выход догоняется после простоя сервера (EC-T17)', { skip }, async () => {
  // Курсор стоит на два дня назад — сервер был выключен, и пропущенный день
  // обязан догнаться, а не потеряться.
  const f = await fixture({ releases: [day(-2), day(-1), day()] });
  const viewer = await user();
  await subscriptions.toggle({ userId: viewer.id, seriesId: f.series.id, on: true });
  await notify.saveCursor(new Date(Date.now() - 3 * 86_400_000).toISOString());

  await sweep().run();

  const rows = await rowsOf(viewer.id);
  assert.equal(rows.length, 3, 'пропущенные дни догнались');
  assert.deepEqual(rows.map((row) => row.params.date).sort(), [day(-2), day(-1), day()]);
});

test('локальная дата подписчика, а не серверная (EC-T4, H-72)', { skip }, async () => {
  const f = await fixture({ releases: [day()] });
  // В Auckland «сегодня» наступает раньше минского: его уведомление не должно
  // ждать серверной полуночи.
  const viewer = await user({ timezone: 'Pacific/Auckland' });
  await subscriptions.toggle({ userId: viewer.id, seriesId: f.series.id, on: true });

  await sweep().run();
  assert.equal((await rowsOf(viewer.id)).length, 1, 'пояс подписчика учтён');
});

test('выключенные уведомления, неактивный аккаунт и снятый с публикации сериал молчат', { skip }, async () => {
  const f = await fixture({ releases: [day()] });
  const archived = await fixture({ releases: [day()], archived: true });

  const off = await user({ notificationsEnabled: false });
  const banned = await user({ status: 'banned' });
  const alive = await user();
  for (const viewer of [off, banned, alive]) {
    // eslint-disable-next-line no-await-in-loop
    await subscriptions.toggle({ userId: viewer.id, seriesId: f.series.id, on: true });
    // eslint-disable-next-line no-await-in-loop
    await subscriptions.toggle({ userId: viewer.id, seriesId: archived.series.id, on: true });
  }

  await sweep().run();

  assert.equal((await rowsOf(off.id)).length, 0, 'человек выключил уведомления — их нет');
  assert.equal((await rowsOf(banned.id)).length, 0, 'заблокированному уведомления не пишут');
  assert.equal((await rowsOf(alive.id)).length, 1, 'а живому подписчику выход приходит один раз');
});

test('сезон, вышедший целиком, — одно уведомление (EC-T6)', { skip }, async () => {
  const f = await fixture({ releases: [day()], coversSeason: true });
  const viewer = await user();
  await subscriptions.toggle({ userId: viewer.id, seriesId: f.series.id, on: true });

  await sweep().run();

  const rows = await rowsOf(viewer.id);
  assert.equal(rows.length, 1, 'три серии одним днём — одно уведомление, а не три');
  assert.deepEqual(rows[0].params.episodes, [1, 2, 3]);
  assert.equal(rows[0].params.coversSeason, true);
});

test('потолок списка соблюдается: сверх notify.max_per_user не создаётся (F-03-08 §9)', { skip }, async () => {
  const f = await fixture({ releases: [day()] });
  const viewer = await user();
  await subscriptions.toggle({ userId: viewer.id, seriesId: f.series.id, on: true });

  // Список заполнен: дальше уведомления не создаются, иначе лента растёт
  // бесконечно, а `e_notification` — вместе с ней.
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `INSERT INTO e_notification (user_id, kind, category, params, dedup_key)
       VALUES ($1, 'release_today', 'release', '{}'::jsonb, $2)`,
      [viewer.id, `filler:${day()}:${i}`],
    );
  }

  await sweep({ maxPerUser: 3 }).run();
  assert.equal((await rowsOf(viewer.id)).length, 3, 'список полон — уведомление не добавлено');

  await sweep({ maxPerUser: 10 }).run();
  assert.equal((await rowsOf(viewer.id)).length, 4, 'освободилось место — уведомление пришло');
});

test('много одинаковых за день сворачивается в одну сводку (F-03-08 §5)', { skip }, async () => {
  // Три сериала с выходом сегодня: «много одинаковых за день» — это несколько
  // сериалов одного дня, а не несколько дней одного сериала.
  const viewer = await user();
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const f = await fixture({ releases: [day()] });
    // eslint-disable-next-line no-await-in-loop
    await subscriptions.toggle({ userId: viewer.id, seriesId: f.series.id, on: true });
  }

  const summary = await sweep({ digestThreshold: 3 }).run();
  // Счётчик прохода общий для всех зрителей, а база общая с параллельными
  // прогонами: точное число здесь недостижимо. Проверяется результат для
  // своего зрителя — одна сводка вместо трёх записей.
  assert.ok(summary.digests >= 1, 'хотя бы одна сводка собрана');

  const rows = await rowsOf(viewer.id);
  assert.equal(rows.length, 1, 'вместо трёх записей одна');
  assert.equal(rows[0].dedup_key, `digest:${day()}`);
  assert.equal(rows[0].params.digest.count, 3);
  assert.equal(rows[0].params.digest.series.length, 3);

  await sweep({ digestThreshold: 3 }).run();
  assert.equal((await rowsOf(viewer.id)).length, 1, 'повторный проход сводку не дублирует');
});

test('уведомления идут пачками, а не по одному (EC-T16)', { skip }, async () => {
  const f = await fixture({ releases: [day()] });
  const viewers = [];
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const viewer = await user();
    // eslint-disable-next-line no-await-in-loop
    await subscriptions.toggle({ userId: viewer.id, seriesId: f.series.id, on: true });
    viewers.push(viewer);
  }

  let steps = 0;
  const created = await notify.create({
    userIds: viewers.map((viewer) => viewer.id),
    kind: 'release_today',
    params: { date: day() },
    dedupKey: `release:${f.releases[0].id}`,
    step: 2,
  });
  steps += created.steps;

  assert.equal(created.created, 5);
  assert.equal(steps, 3, 'пять получателей при шаге в два — три шага, а не пять запросов');
  assert.equal(STEP, 500, 'рабочий шаг — 500 записей (F-03-08 §9)');
});

test('кэш прогресса пересчитывается, когда вышел новый эпизод (#130)', { skip }, async () => {
  const f = await fixture({ releases: [day(-3)] });
  const viewer = await user();
  await subscriptions.toggle({ userId: viewer.id, seriesId: f.series.id, on: true });

  // Строку кэша создаёт обычное чтение прогресса — так же, как на странице
  // сериала или в закладках.
  await recompute(pool, { userId: viewer.id, seriesId: f.series.id, today: day(0) });
  const before = await pool.query(
    'SELECT aired FROM e_progress WHERE user_id = $1 AND series_id = $2', [viewer.id, f.series.id],
  );
  assert.equal(before.rows[0].aired, 1, 'одна серия уже вышла');

  // Вышел второй эпизод сериала, а строка кэша старше последнего выхода:
  // без ночного пересчёта прогресс остался бы прежним до следующего открытия.
  await pool.query(
    `INSERT INTO e_release (season_id, release_date) VALUES ($1, $2)`,
    [f.season.id, day(-1)],
  );
  await pool.query(
    `INSERT INTO e_release_episode (release_id, episode_id)
     SELECT r.id, e.id FROM e_release r, e_episode e
      WHERE r.season_id = $1 AND r.release_date = $2 AND e.season_id = r.season_id AND e.number = 2`,
    [f.season.id, day(-1)],
  );
  await pool.query(
    `UPDATE e_progress SET aired = 1, updated_at = now() - interval '2 days'
      WHERE user_id = $1 AND series_id = $2`, [viewer.id, f.series.id],
  );

  await sweep().run();

  const after = await pool.query(
    'SELECT aired FROM e_progress WHERE user_id = $1 AND series_id = $2', [viewer.id, f.series.id],
  );
  assert.equal(after.rows[0].aired, 2, 'вышел новый эпизод — прогресс обновился сам');
});

/**
 * Сериал с одной серией и её выходом; `tconst` — как в событии синхронизации.
 */
async function moved(date) {
  counter += 1;
  const tconst = `tt98${String(counter).padStart(5, '0')}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, imdb_key,
                           publication_state, exit_state, year_start)
     VALUES ($1, 'Перенос: тест', 'Moved fixture', $2, $3, 'published', 'airing', 2024)
     RETURNING id, slug`,
    [`ntm${String(counter).padStart(4, '0')}-${crypto.randomUUID().slice(0, 8)}`,
      965000000 + counter, tconst],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [series.id],
  );
  const { rows: [episode] } = await pool.query(
    `INSERT INTO e_episode (season_id, number, title_ru, runtime_min)
     VALUES ($1, 5, 'Пятая серия', 45) RETURNING id`, [season.id],
  );
  const { rows: [release] } = await pool.query(
    'INSERT INTO e_release (season_id, release_date) VALUES ($1, $2) RETURNING id', [season.id, date],
  );
  await pool.query('INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)',
    [release.id, episode.id]);

  return { series, season, episode, release, tconst };
}

test('перенос серии приходит подписчику как «перенесена»', { skip }, async () => {
  // Событие приходит после записи каталога, поэтому выход уже стоит на новой
  // дате: искать уведомление по прежней дате было бы ошибкой фикстуры, а не
  // проверкой.
  const f = await moved(date(3));
  const viewer = await user();
  await subscriptions.toggle({ userId: viewer.id, seriesId: f.series.id, on: true });

  const summary = await notifyScheduleChanges({
    pool,
    notifications: notify,
    changes: [{ code: 'postponed', tconst: f.tconst, season: 1, episode: 5, from: date(), to: date(3) }],
  });
  assert.equal(summary.created, 1);

  const rows = await rowsOf(viewer.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'release_changed');
  assert.equal(rows[0].params.date, date(3), 'в уведомлении новая дата');
  assert.equal(rows[0].params.from, date(), 'и та, с которой перенесли');
  assert.deepEqual(rows[0].params.episodes, [5], 'номер серии известен — подпись «S1E5» его использует');
});

test('два переноса за сутки схлопываются в последний (F-03-08 §8б)', { skip }, async () => {
  const f = await moved(date(3));
  const viewer = await user();
  await subscriptions.toggle({ userId: viewer.id, seriesId: f.series.id, on: true });

  await notifyScheduleChanges({
    pool,
    notifications: notify,
    changes: [{ code: 'postponed', tconst: f.tconst, season: 1, episode: 5, from: date(), to: date(3) }],
  });
  // Синхронизация узнала о новой дате раньше, чем человек открыл ленту.
  await pool.query('UPDATE e_release SET release_date = $2 WHERE id = $1', [f.release.id, date(6)]);
  await notifyScheduleChanges({
    pool,
    notifications: notify,
    changes: [{
      code: 'postponed', tconst: f.tconst, season: 1, episode: 5, from: date(3), to: date(6),
    }],
  });

  const rows = await rowsOf(viewer.id);
  assert.equal(rows.length, 1, 'человеку приходит одна новость, а не две');
  assert.equal(rows[0].params.date, date(6), 'и в ней последняя дата');
});

test('уведомление о переносе не трогает то, что уже было в ленте (EC-T5)', { skip }, async () => {
  // Сначала серия выходит в свою дату — приходит «вышла сегодня», — а потом
  // переносится. Прежнее уведомление обязано остаться.
  const f = await moved(date(3));
  await pool.query('UPDATE e_release SET release_date = $2 WHERE id = $1', [f.release.id, date()]);
  const viewer = await user();
  await subscriptions.toggle({ userId: viewer.id, seriesId: f.series.id, on: true });

  // Сначала — ежечасная задача: «серия вышла сегодня».
  await createNotificationSweep({ pool, notifications: notify, digestThreshold: 1000 }).run();

  // Ночная синхронизация переписала выход на новую дату — и только потом пришло
  // событие, поэтому порядок здесь такой же, как в бою.
  await pool.query('UPDATE e_release SET release_date = $2 WHERE id = $1', [f.release.id, date(3)]);
  await notifyScheduleChanges({
    pool,
    notifications: notify,
    changes: [{ code: 'postponed', tconst: f.tconst, season: 1, episode: 5, from: date(), to: date(3) }],
  });

  const rows = await rowsOf(viewer.id);
  assert.deepEqual(rows.map((row) => row.kind).sort(), ['release_changed', 'release_today'],
    'прежнее уведомление остаётся: перенос — дополнение, а не замена');
});

test('без подписки перенос никого не будит (§8д)', { skip }, async () => {
  const f = await moved(date(3));
  const viewer = await user();

  const summary = await notifyScheduleChanges({
    pool,
    notifications: notify,
    changes: [{ code: 'postponed', tconst: f.tconst, season: 1, episode: 5, from: date(), to: date(3) }],
  });

  assert.equal(summary.created, 0);
  assert.equal((await rowsOf(viewer.id)).length, 0);
});

test('чужой код события и серия вне каталога не создают уведомлений', { skip }, async () => {
  const viewer = await user();
  const summary = await notifyScheduleChanges({
    pool,
    notifications: notify,
    changes: [
      { code: 'announced', tconst: 'tt0000000', season: 1, episode: 1, from: null, to: date() },
      { code: 'postponed', tconst: 'tt0000000', season: 1, episode: 1, from: date(), to: date(1) },
    ],
  });

  assert.equal(summary.checked, 2, 'события разобраны');
  assert.equal(summary.created, 0);
  assert.equal((await rowsOf(viewer.id)).length, 0);
});
