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

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — датчик аномалий не проверялся';

let pool;
let sensor;
const fixtures = { series: [] };

test.before(async () => {
  if (!available) return;
  pool = createPool();
  sensor = pgAnomalySensor({ pool, ratings: pgRatings(pool) });
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

async function viewer() {
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
  assert.equal(notification.params.anomaly_id, anomaly.id, 'готовит к M9 разбор');
  assert.equal(notification.user_id, admin.user_id, 'служебное уведомление адресовано админу');
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
