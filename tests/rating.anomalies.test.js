// Датчик аномалий оценок (F-04-08, H-77).
//
// Расхождение, которое живёт только на настоящей базе: сработал ли порог
// `max(20, 5 × среднее дневное)` и какие строки попали в окно. Заглушка
// тут бы утаила все три ловушки — SQL-окна, долю экстремумов и отсутствие
// дубля при уже открытой аномалии.
//
// Базовая линия — предыдущие 7 дней (DEC-066): у новинок полной истории
// нет, порог по всей жизни сделал бы срабатывание недостижимым.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgRatings } from '../src/services/rating/store.js';
import { pgAnomalySensor } from '../src/services/rating/anomalies.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken } from '../src/services/auth/password.js';
import { notificationText } from '../src/view/notification.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — датчик аномалий не проверялся';

let pool;
let sensor;
let ratings;
const fixtures = { series: [] };

test.before(async () => {
  if (!available) return;
  pool = createPool();
  ratings = pgRatings(pool);
  sensor = pgAnomalySensor({ pool, ratings });
});

test.after(async () => {
  if (!pool) return;
  // Префикс только свой: файлы идут параллельно, и общая уборка била бы
  // по фикстурам соседа. Пользователей физически не удалить (R-SQL-02,
  // правило no_delete_user) — удаляем самое гремящее: роли, уведомления,
  // голоса и сами серии (аномалии падают каскадом от серии).
  await pool.query(`DELETE FROM e_role_assignment WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)`, ['rating-anomaly-%']);
  await pool.query(`DELETE FROM e_notification WHERE user_id IN (SELECT id FROM e_user WHERE nickname LIKE $1)`, ['rating-anomaly-%']);
  await pool.query(`DELETE FROM e_rating WHERE series_id IN (SELECT id FROM e_series WHERE slug LIKE $1)`, ['rating-anomaly-%']);
  await pool.query(`DELETE FROM e_series WHERE slug LIKE $1`, ['rating-anomaly-%']);
  await pool.end();
});

/** Сериал без сезонов: датчик смотрит оценки сериала, серии ему не нужны. */
async function seriesWith() {
  const slug = `rating-anomaly-${crypto.randomUUID().slice(0, 8)}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Аномалия фикстуры', 'Anomaly fixture', $2, 'published', 'airing', 2024)
     RETURNING id, slug`,
    [slug, 965_000_000 + Math.floor(Math.random() * 900)],
  );
  fixtures.series.push(series.id);
  return series.id;
}

/**
 * Аккаунт для оценок. По умолчанию взрослый: свежий аккаунт по умолчанию
 * превратил бы любую фикс-оценку в экстремум молодого.
 *
 * @param {{ageHours: number}} args
 */
async function viewer({ ageHours = 24 * 30 } = {}) {
  const { hash } = makeToken();
  const created = await pgAuthStore(pool).createUser({
    email: `rating-anomaly-${crypto.randomUUID().slice(0, 8)}@example.com`,
    nickname: `rating-anomaly-${crypto.randomUUID().slice(0, 8)}`,
    passwordHash: '$argon2id$заглушка',
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  await pool.query(
    `UPDATE e_user SET registered_at = now() - ($2 || ' hours')::interval WHERE id = $1`,
    [created.id, String(ageHours)],
  );
  return created.id;
}

/** Молодой (не повзрослевший) аккаунт: регистрация минуту назад. */
async function young() {
  const id = await viewer();
  await pool.query(`UPDATE e_user SET registered_at = now() - interval '1 hour' WHERE id = $1`, [id]);
  return id;
}

/**
 * Оценка сериала, вставленная в обход сторы: датчик обязан читать не только
 * «сейчас», но и прошлые дни, а через сторы эту дату не записать. По
 * умолчанию голос не учитывается (counted=false) — тогда фикстуры не
 * двигают среднее по сайту, по которому сверяются соседние файлы.
 */
function fare(seriesId, userId, value, when, { counted = false } = {}) {
  return pool.query(
    `INSERT INTO e_rating (user_id, object_type, series_id, value, counted, created_at)
     VALUES ($1, 'series', $2, $3, $5, $4)`,
    [userId, seriesId, value, when, counted],
  );
}

/** Кэш агрегата сторы обновляют сами; фикстуры пишут в обход — выравниваем вручную. */
function syncStat(seriesId) {
  return pool.query(
    `INSERT INTO e_series_rating_stat (series_id, sum_value, votes)
     SELECT series_id, sum(value), count(*) FROM e_rating
      WHERE series_id = $1 AND counted AND object_type = 'series' AND episode_id IS NULL
      GROUP BY series_id
     ON CONFLICT (series_id) DO UPDATE
        SET sum_value = EXCLUDED.sum_value, votes = EXCLUDED.votes,
            recalculated_at = now()`,
    [seriesId],
  );
}

/** Момент окна для signal (JSONB хранит ISO-строку). */
function windowStamp(date) {
  return date.toISOString();
}

test('всплеск от новых аккаунтов детектируется: заморозка и уведомление', { skip }, async () => {
  const seriesId = await seriesWith();
  const recent = new Date(Date.now() - 10 * 60_000); // 10 минут назад
  // 19 экстремумов «1» + 2 обычные от молодых, 4 обычные от взрослых:
  // доля экстремумов молодых 19/25 = 76% ≥ 70% (H-77), счёт 25 > 20.
  // Молодые голоса недозревшие (counted=false) — снимок блока видит их на
  // «посчитанных» четыре; датчик же читает сырые строки без флага.
  for (let i = 0; i < 19; i += 1) await fare(seriesId, await young(), 1, recent);
  for (let i = 0; i < 2; i += 1) await fare(seriesId, await young(), 6, recent);
  for (let i = 0; i < 4; i += 1) await fare(seriesId, await viewer(), 8, recent, { counted: true });
  await syncStat(seriesId);

  const { rows: [admin] } = await pool.query(
    `INSERT INTO e_role_assignment (user_id, role) VALUES ($1, 'admin') RETURNING user_id`,
    [await viewer()],
  );

  const found = await sensor.scan(new Date());
  assert.equal(found, 1, 'пороговый всплеск обязан сработать');

  const { rows: [anomaly] } = await pool.query(
    `SELECT id, state, signal, frozen FROM e_rating_anomaly WHERE series_id = $1`,
    [seriesId],
  );
  assert.equal(anomaly.state, 'open');
  assert.equal(anomaly.signal.count_window, 25, 'все новые оценки сериала в окне');
  assert.equal(anomaly.signal.extreme_share, 76, 'доля зафиксирована для разбора');
  assert.equal(anomaly.frozen.summary.votes, 4, 'снимок считывает только учитываемые строки');
  assert.ok(anomaly.frozen.summary.average >= 1 && anomaly.frozen.summary.average <= 10);

  const { rows: [notification] } = await pool.query(
    `SELECT user_id, kind, params FROM e_notification WHERE user_id = $1 AND dedup_key = $2`,
    [admin.user_id, `rating-anomaly:${anomaly.id}`],
  );
  assert.equal(notification.kind, 'rating_anomaly');
  assert.equal(notification.params.anomalyId, anomaly.id, 'готовит к M9 разбор');
  assert.equal(notification.user_id, admin.user_id, 'служебное уведомление адресовано админу');

  // Лента читает параметры своими же словами (camelCase). Проверяется не
  // запись в базе, а готовый текст письма: пока датчик писал snake_case,
  // уведомление выходило с пустым названием сериала и «0 новых оценок», а
  // тесты смотрели только на строку в базе.
  const rendered = notificationText('ru', { kind: notification.kind, params: notification.params });
  assert.match(rendered.body, /Аномалия фикстуры/, 'письмо называет сериал');
  assert.match(rendered.body, /25/, 'письмо называет число новых оценок');
  assert.match(rendered.body, /76%/, 'письмо называет долю экстремумов');
});

test('пять оценок и ноль экстремумов — датчик молчит', { skip }, async () => {
  const seriesId = await seriesWith();
  const recent = new Date(Date.now() - 30 * 60_000);
  for (let i = 0; i < 10; i += 1) await fare(seriesId, await viewer(), 7, recent);
  const found = await sensor.scan(new Date());
  assert.equal(found, 0);
});

test('25 всплеска без 70% экстремумов — не аномалия', { skip }, async () => {
  const seriesId = await seriesWith();
  const recent = new Date(Date.now() - 30 * 60_000);
  for (let i = 0; i < 10; i += 1) await fare(seriesId, await young(), 1, recent);
  for (let i = 0; i < 15; i += 1) await fare(seriesId, await viewer(), 7, recent);
  const found = await sensor.scan(new Date());
  assert.equal(found, 0);
});

test('впивается в свежий шум: базовая линия 7 дней держит порог (DEC-066)', { skip }, async () => {
  const seriesId = await seriesWith();
  // Фон: 42 оценки за предыдущую неделю (≈ 6 в день) → порог max(20, 30).
  for (let d = 2; d <= 8; d += 1) {
    for (let i = 0; i < 6; i += 1) {
      await fare(seriesId, await viewer(), 6,
        new Date(Date.now() - d * 24 * 3600_000));
    }
  }
  // 25 новых экстремумов от молодых — доля 100%, но 25 <= 30: не аномалия.
  const recent = new Date(Date.now() - 10 * 60_000);
  for (let i = 0; i < 25; i += 1) await fare(seriesId, await young(), 1, recent);
  const found = await sensor.scan(new Date());
  assert.equal(found, 0);
});

test('повторный скан не дублирует открытую аномалию', { skip }, async () => {
  const seriesId = await seriesWith();
  const recent = new Date(Date.now() - 10 * 60_000);
  for (let i = 0; i < 21; i += 1) await fare(seriesId, await young(), 2, recent);
  assert.equal(await sensor.scan(new Date()), 1);
  assert.equal(await sensor.scan(new Date()), 0, 'пока аномалия открыта, датчик молчит');
});

test('после решения датчик снова ловит новый всплеск', { skip }, async () => {
  const seriesId = await seriesWith();
  const recent = new Date(Date.now() - 10 * 60_000);
  for (let i = 0; i < 21; i += 1) await fare(seriesId, await young(), 10, recent);
  await sensor.scan(new Date());
  await pool.query(
    `UPDATE e_rating_anomaly SET state = 'accepted', resolved_at = now(),
        resolved_by = (SELECT id FROM e_user ORDER BY id LIMIT 1) WHERE series_id = $1`,
    [seriesId],
  );
  // Новое окно: 21 нижепомеченная оценка создана прямо сейчас.
  for (let i = 0; i < 21; i += 1) await fare(seriesId, await young(), 1, new Date());
  assert.equal(await sensor.scan(new Date()), 1);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM e_rating_anomaly WHERE series_id = $1`,
    [seriesId],
  );
  assert.equal(rows[0].n, 2, 'решённая осталась в истории, открыта новая');
});

test('заморозка: summary отдаёт снимок блока, пока аномалия открыта', { skip }, async () => {
  const seriesId = await seriesWith();
  const recent = new Date(Date.now() - 10 * 60_000);
  // 19 экстремумов + 4 считаемых: доля 19/23 ≈ 82.6% ≥ 70%, счёт 23 > 20.
  for (let i = 0; i < 19; i += 1) await fare(seriesId, await young(), 1, recent);
  for (let i = 0; i < 4; i += 1) await fare(seriesId, await viewer(), 8, recent, { counted: true });
  await syncStat(seriesId);
  await sensor.scan(new Date());
  const before = await ratings.summary(seriesId);
  assert.equal(before.votes, 4);

  // Голос после заморозки меняет живой расчёт, но не замороженный показ.
  for (let i = 0; i < 3; i += 1) await fare(seriesId, await viewer(), 9, new Date(), { counted: true });
  await syncStat(seriesId);
  const frozen = await ratings.summary(seriesId);
  assert.equal(frozen.votes, 4, 'голоса после срабатывания не меняют показ');
  assert.equal(frozen.average, before.average, 'замороженное среднее неизменно');

  await pool.query(
    `UPDATE e_rating_anomaly SET state = 'accepted', resolved_at = now(),
        resolved_by = (SELECT id FROM e_user ORDER BY id LIMIT 1) WHERE series_id = $1`,
    [seriesId],
  );
  const live = await ratings.summary(seriesId);
  assert.equal(live.votes, 7, 'после решения блок читает живой агрегат');
});

test('решение «принять»: аномалия закрыта, оценки остаются учитываемыми', { skip }, async () => {
  const seriesId = await seriesWith();
  const recent = new Date(Date.now() - 10 * 60_000);
  for (let i = 0; i < 21; i += 1) await fare(seriesId, await viewer(), 1, recent, { counted: true });
  await syncStat(seriesId);
  const { rows: [anomaly] } = await pool.query(
    `INSERT INTO e_rating_anomaly (series_id, signal, frozen)
     VALUES ($1, $2::jsonb, $3::jsonb) RETURNING id`,
    [
      seriesId,
      JSON.stringify({ window_start: windowStamp(recent), count_window: 21 }),
      JSON.stringify({ summary: { votes: 21, average: 1.0, shown: true, histogram: {} } }),
    ],
  );
  const admin = await viewer();

  const result = await sensor.resolve({ id: anomaly.id, decision: 'accepted', adminId: admin });

  assert.equal(result.ok, true);
  assert.equal(result.discarded, 0, 'принятие ничего не помечает');
  const { rows: [row] } = await pool.query(
    'SELECT state, resolved_by, resolved_at FROM e_rating_anomaly WHERE id = $1', [anomaly.id],
  );
  assert.equal(row.state, 'accepted');
  assert.equal(row.resolved_by, admin, 'админ записан в строку решения');
  assert.ok(row.resolved_at instanceof Date);
  const { rows: [stat] } = await pool.query(
    'SELECT votes, sum_value::float AS sum FROM e_series_rating_stat WHERE series_id = $1',
    [seriesId],
  );
  assert.equal(stat.votes, 21, 'агрегат после принятия не пересчитывали');
});

test('решение «отбросить»: экстремумы окна теряют учёт, взрослые держатся', { skip }, async () => {
  const seriesId = await seriesWith();
  const recent = new Date(Date.now() - 10 * 60_000);
  const pastYear = new Date(Date.now() - 365 * 24 * 3600_000);
  // Молодые экстремумы 19 + молодые обычные 5 (не считались), взрослые
  // экстремумы 4 (считаются): доля 19/28 ≈ 67.9 — чуть ниже порога, датчик
  // молчит, а строку решения заводим руками. Молодые экстремумы при этом
  // считаются (counted=true): так видно, что именно сброс отменяет учёт —
  // в жизни такие строки возможны после дозревания голоса.
  for (let i = 0; i < 19; i += 1) await fare(seriesId, await young(), 1, recent, { counted: true });
  for (let i = 0; i < 5; i += 1) await fare(seriesId, await young(), 6, recent, { counted: false });
  for (let i = 0; i < 4; i += 1) await fare(seriesId, await viewer({ ageHours: 24 * 400 }), 1, recent, { counted: true });
  const { rows: [anomaly] } = await pool.query(
    `INSERT INTO e_rating_anomaly (series_id, signal, frozen)
     VALUES ($1, $2::jsonb, $3::jsonb) RETURNING id`,
    [
      seriesId,
      JSON.stringify({
        window_start: windowStamp(recent),
        window_hours: 24,
        extreme_low: 2,
        extreme_high: 9,
        young_hours: 168,
      }),
      JSON.stringify({ summary: { votes: 23, average: 1.2, shown: true, histogram: {} } }),
    ],
  );
  const admin = await viewer();
  const votes = (counted) => pool.query(
    `SELECT count(*)::int AS n FROM e_rating
      WHERE series_id = $1 AND object_type = 'series' AND episode_id IS NULL AND counted = $2`,
    [seriesId, counted],
  );

  const result = await sensor.resolve({ id: anomaly.id, decision: 'discarded', adminId: admin });

  assert.equal(result.ok, true);
  assert.equal(result.discarded, 19, 'помечены только молодые экстремумы окна');
  const before = await votes(true);
  assert.equal(before.rows[0].n, 4, 'взрослые экстремумы остаются учитываемыми');
  const { rows: [row] } = await pool.query(
    'SELECT state FROM e_rating_anomaly WHERE id = $1', [anomaly.id],
  );
  assert.equal(row.state, 'discarded');
  // Пересчитанный агрегат серии: только считаемые после сброса.
  const { rows: [stat] } = await pool.query(
    'SELECT votes, sum_value::float AS sum FROM e_series_rating_stat WHERE series_id = $1',
    [seriesId],
  );
  assert.equal(stat.votes, 4, 'агрегат пересчитан без сброшенных голосов');
  assert.equal(stat.sum, 4);
});

test('разбор аномалии: решённая и несуществующая не решаются', { skip }, async () => {  const seriesId = await seriesWith();
  const past = new Date(Date.now() - 30 * 24 * 3600_000);
  const { rows: [anomaly] } = await pool.query(
    `INSERT INTO e_rating_anomaly (series_id, signal, frozen)
     VALUES ($1, $2::jsonb, $3::jsonb) RETURNING id`,
    [
      seriesId,
      JSON.stringify({ window_start: windowStamp(past), count_window: 1 }),
      JSON.stringify({ summary: { votes: 0, average: null, shown: false, histogram: {} } }),
    ],
  );
  const admin = await viewer();
  await sensor.resolve({ id: anomaly.id, decision: 'accepted', adminId: admin });

  const again = await sensor.resolve({ id: anomaly.id, decision: 'discarded', adminId: admin });
  assert.equal(again.ok, false, 'решённая аномалия не решаетсявторой раз');
  assert.equal(again.reason, 'not-open');
  const unknown = await sensor.resolve({ id: 987_654_321, decision: 'accepted', adminId: admin });
  assert.equal(unknown.ok, false);
  const nonsense = await sensor.resolve({ id: anomaly.id, decision: 'как-нибудь', adminId: admin });
  assert.equal(nonsense.ok, false, 'незнакомое решение отклонено');
});
