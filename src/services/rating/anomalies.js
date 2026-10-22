// Датчик аномалий оценок (F-04-08, H-77).
//
// Часовой проход по всем сериалам: где за окно всплеска набралось больше
// оценок, чем max(минимум, множитель × среднее дневное по базовой линии),
// и не меньше заданной доли из них — экстремумы от молодых аккаунтов,
// серия помечается аномалией: строка с числами детекции и снимком блока
// рейтинга, снимком читатели и пользуются до решения админа.
//
// Пороги — стартовые значения H-77 из настроек (RATING.anomaly*).
// Базовая линия — предыдущие N дней (DEC-066): по всей жизни сериала
// пенял бы новинкам, у которых истории нет.
//
// Повторный вход не дублирует: уникальный индекс по открытой аномалии
// в базе, и проход их исключает условием NOT EXISTS. Решения админа
// (принять/отбросить) живут в маршрутах M9; здесь — только находка.

import { RATING } from '../../config/settings.js';

/**
 * Работает с настоящей таблицей аномалий: возьмите этот конструктор, если
 * ДБ-доступ через pg.Pool.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {any} deps.ratings хранилище оценок: его `summary(seriesId)`
 *   даёт снимок блока «последнее стабильное» на момент срабатывания
 * @returns {{scan: (at?: Date) => Promise<number>, resolve: Function}}
 */
export function pgAnomalySensor({ pool, ratings }) {
  /**
   * Часовой проход.
   *
   * @param {Date} [at] момент прохода; тесты подставляют фиксированные даты
   * @returns {Promise<number>} сколько аномалий открыто этим проходом
   */
  async function scan(at = new Date()) {
    const windowStart = windowStartDate(at);
    const baselineStart = baselineStartDate(at, windowStart);
    const { rows: candidates } = await pool.query(
      `WITH recent AS (
         SELECT r.series_id,
                count(*)::int AS count_window,
                count(*) FILTER (
                  WHERE (r.value <= $1 OR r.value >= $2)
                    AND u.registered_at > $3
                )::int AS count_extreme
           FROM e_rating r
           JOIN e_user u ON u.id = r.user_id
          WHERE r.object_type = 'series' AND r.episode_id IS NULL
            AND r.created_at >= $4 AND r.created_at < $5
          GROUP BY r.series_id
       ),
       baseline AS (
         SELECT r.series_id, count(*)::float8 AS count_baseline
           FROM e_rating r
          WHERE r.object_type = 'series' AND r.episode_id IS NULL
            AND r.created_at >= $6 AND r.created_at < $4
          GROUP BY r.series_id
       )
       SELECT s.series_id, s.count_window, s.count_extreme, es.title_ru, es.slug,
              coalesce(b.count_baseline, 0) AS count_baseline
         FROM recent s
         LEFT JOIN baseline b ON b.series_id = s.series_id
         LEFT JOIN e_series es ON es.id = s.series_id
        WHERE NOT EXISTS (
              SELECT 1 FROM e_rating_anomaly a
               WHERE a.series_id = s.series_id AND a.state = 'open')
          AND s.count_window > GREATEST(
                $7,
                $8 * coalesce(b.count_baseline, 0.0) / $9)
          AND s.count_extreme::float8 / s.count_window >= $10::float8 / 100`,
      [
        RATING.anomalyExtremeLow,
        RATING.anomalyExtremeHigh,
        toTimestamp(youngerDate(at)),
        windowStart,
        toTimestamp(at),
        baselineStart,
        RATING.anomalyMinVotes,
        RATING.anomalyAvgMultiplier,
        RATING.anomalyBaselineDays,
        RATING.anomalyExtremeShare,
      ],
    );

    for (const row of candidates) {
      const summary = await ratings.summary(row.series_id);
      const { rows: [anomaly] } = await pool.query(
        `INSERT INTO e_rating_anomaly (series_id, signal, frozen)
         VALUES ($1, $2, $3)
         RETURNING id, created_at AS created`,
        [
          row.series_id,
          JSON.stringify(signal({ at, row })),
          JSON.stringify({ summary: freezeSummary(summary) }),
        ],
      );
      await notifyAdmins({ pool, anomaly, at, row });
    }
    return candidates.length;
  }

  /**
   * Решение админа по аномалии (F-04-08 §4, H-77).
   *
   * @param {object} args
   * @param {number} args.id
   * @param {'accepted'|'discarded'} args.decision
   * @param {number} args.adminId
   * @returns {Promise<{ok: true, decision: string, discarded: number}
   *   |{ok: false, reason: 'bad-decision'|'missing'|'not-open'}>}
   */
  async function resolve({ id, decision, adminId }) {
    if (decision !== 'accepted' && decision !== 'discarded') {
      return { ok: false, reason: 'bad-decision' };
    }
    const client = await pool.connect();
    const at = new Date();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE e_rating_anomaly
            SET state = $2, resolved_by = $3, resolved_at = $4
          WHERE id = $1 AND state = 'open'
          RETURNING series_id, signal`,
        [id, decision, adminId, at],
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        const known = await pool.query(
          'SELECT 1 FROM e_rating_anomaly WHERE id = $1', [id],
        );
        return { ok: false, reason: known.rows.length ? 'not-open' : 'missing' };
      }
      const { series_id: seriesId, signal } = rows[0];
      let discarded = 0;
      if (decision === 'discarded') {
        // Экстремумы окна от молодых аккаунтов теряют учёт (F-04-08 §8):
        // окно читается из signal — те же числа, что высчитывал датчик.
        const drop = await client.query(
          `UPDATE e_rating r
              SET counted = FALSE
             WHERE r.object_type = 'series' AND r.episode_id IS NULL
               AND r.series_id = $1
               AND r.created_at >= $2
               AND r.created_at < $2 + make_interval(hours => $3)
               AND (r.value <= $4 OR r.value >= $5)
               AND r.counted
               AND r.user_id IN (
                    SELECT u.id FROM e_user u
                     WHERE u.registered_at > $2 - make_interval(hours => $6))`,
          [
            seriesId,
            signal.window_start,
            signal.window_hours,
            signal.extreme_low,
            signal.extreme_high,
            signal.young_hours,
          ],
        );
        discarded = drop.rowCount;
        // Агрегат серии собирается из учитываемых строк: после сброса
        // сумма и число голосов обязаны читать по новой, иначе замороженный
        // блок ещё долго показывал бы сброшенные голоса.
        await client.query(
          `INSERT INTO e_series_rating_stat (series_id, sum_value, votes, recalculated_at)
           SELECT $1, coalesce(sum(value), 0)::numeric(12,2), count(*)::int, $2
             FROM e_rating
            WHERE series_id = $1 AND object_type = 'series' AND episode_id IS NULL AND counted
           GROUP BY series_id
           ON CONFLICT (series_id) DO UPDATE
              SET sum_value = EXCLUDED.sum_value, votes = EXCLUDED.votes,
                  recalculated_at = EXCLUDED.recalculated_at`,
          [seriesId, at],
        );
      }
      await client.query('COMMIT');
      return { ok: true, decision, discarded };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return { scan, resolve };
}

function toTimestamp(date) {
  return date.toISOString();
}

/** Начало окна всплеска: `anomalyWindowH` часов до прохода. */
function windowStartDate(at) {
  return toTimestamp(new Date(at.getTime() - RATING.anomalyWindowH * 3600_000));
}

/** Начало базовой линии: сразу перед окном всплеска, длиной N дней. */
function baselineStartDate(at, windowStart) {
  return toTimestamp(
    new Date(new Date(windowStart).getTime() - RATING.anomalyBaselineDays * 86_400_000),
  );
}

/** «Молодой аккаунт»: зарегистрирован позже этого момента. */
function youngerDate(at) {
  return new Date(at.getTime() - RATING.anomalyYoungHours * 3600_000);
}

/**
 * Числа детекции: редактор разбора не должен вычислять их заново по
 * волатильным таблицам — всё, на что смотрел датчик, лежит здесь.
 *
 * @param {{at: Date, row: any}} args
 */
function signal({ at, row }) {
  return {
    window_hours: RATING.anomalyWindowH,
    window_start: windowStartDate(at),
    baseline_days: RATING.anomalyBaselineDays,
    count_window: row.count_window,
    count_extreme: row.count_extreme,
    extreme_share: Math.round((row.count_extreme * 100.0 / row.count_window) * 100) / 100,
    count_baseline: Number(row.count_baseline),
    min_votes: RATING.anomalyMinVotes,
    avg_multiplier: RATING.anomalyAvgMultiplier,
    extreme_low: RATING.anomalyExtremeLow,
    extreme_high: RATING.anomalyExtremeHigh,
    young_hours: RATING.anomalyYoungHours,
  };
}

/**
 * Снимок блока рейтинга:(src Map не JSON-сериализуется, гистограмма
 * превращается в объект со строковыми ключами `1..10`.
 */
function freezeSummary(summary) {
  return {
    sum: summary.sum,
    average: summary.average ?? null,
    votes: summary.votes,
    shown: summary.shown,
    histogram: Object.fromEntries([...summary.histogram ?? new Map()].map(
      ([value, n]) => [String(value), n],
    )),
  };
}

/** Служебное уведомление каждому активному админу (M3, kind `rating_anomaly`). */
async function notifyAdmins({ pool, anomaly, at, row }) {
  // Пары вида «серия → аномалия» собираются при срабатывании: админ должен
  // прочитать уведомление без захода в базу, и re-look тут был бы заходом.
  const share = Math.round(
    (row.count_extreme * 100.0 / Math.max(1, row.count_window)) * 10,
  ) / 10;
  await pool.query(
    `INSERT INTO e_notification (user_id, kind, category, params, dedup_key)
     SELECT u.id, 'rating_anomaly', 'service', $1, $2
       FROM e_user u
       JOIN e_role_assignment a ON a.user_id = u.id
      WHERE a.role = 'admin'
        AND (a.expires_at IS NULL OR a.expires_at > $3)
      ON CONFLICT (user_id, dedup_key) DO NOTHING`,
    [
      JSON.stringify({
        // Имена параметров — как у остальных уведомлений (camelCase): лента
        // читает их своими же словами, и snake_case приводил к пустому
        // названию сериала и «0 новых оценок» в тексте письма.
        anomalyId: anomaly.id,
        createdAt: toTimestamp(anomaly.created),
        seriesTitle: row.title_ru,
        seriesSlug: row.slug,
        countWindow: row.count_window,
        extremeShare: share,
      }),
      `rating-anomaly:${anomaly.id}`,
      toTimestamp(at),
    ],
  );
}
