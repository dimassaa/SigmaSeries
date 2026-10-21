// Ручные запуски импорта (S-76, F-12-08).
//
// Кнопка на экране импорта не выполняет прогон: она заводит строку, а
// выполняет её планировщик. Тяжёлое не должно идти в веб-запросе (R-PERF-09),
// а «запустилось» на экране означает «запланировано и начнётся на ближайшем
// такте планировщика».
//
// Строка ручного запуска помечена в `params`: планировщик отличает её от
// ночного плана, который ждёт своего часа, а не минуты.

import { STALE_HOURS } from './scheduler.js';

/** Виды запусков, которые можно завести кнопкой. */
export const MANUAL_KINDS = ['full_run', 'schedule_sync'];

/**
 * Завести ручной запуск.
 *
 * Ночной план расписания при этом переносится на «сейчас»: строк одного вида в
 * плане быть не может (уникальный индекс по виду), а отдельная строка для
 * ручного запуска означала бы два расписания в одну ночь. После того как
 * перенесённый план начнётся, планировщик заведёт следующий — на своё
 * обычное время.
 *
 * @param {object} deps
 * @param {object} deps.pool
 * @param {string} deps.kind вид запуска: `full_run` или `schedule_sync`
 * @param {boolean} [deps.dryRun] сухой прогон; осмыслен только для `full_run`
 * @param {Date} [deps.now]
 * @returns {Promise<{ok: boolean, reason: string|null, id: number|null}>}
 *   `reason`: `busy` — идёт другой прогон, `planned` — такой запуск уже
 *   запланирован, `unknown_kind` — вид запуска не тот
 */
export async function planManualRun({ pool, kind, dryRun = false, now = new Date() }) {
  if (!MANUAL_KINDS.includes(kind)) return { ok: false, reason: 'unknown_kind', id: null };

  // Блокировка общая для всех видов: пока идёт прогон, второй не начинается.
  const { rows: busy } = await pool.query(
    `SELECT count(*)::int AS n FROM e_import_run
      WHERE status = 'running' AND started_at > now() - ($1 || ' hours')::interval`,
    [String(STALE_HOURS)],
  );
  if (busy[0].n > 0) return { ok: false, reason: 'busy', id: null };

  const { rows: planned } = await pool.query(
    'SELECT id FROM e_import_run WHERE kind = $1 AND status = \'planned\'',
    [kind],
  );

  if (planned.length) {
    // Два полных прогона одновременно не идут: второй ждал бы первого, а
    // ждать тут нечего.
    if (kind === 'full_run') return { ok: false, reason: 'planned', id: planned[0].id };

    const { rows } = await pool.query(
      `UPDATE e_import_run
          SET started_at = $2,
              params = params || jsonb_build_object('manual', true)
        WHERE id = $1 AND status = 'planned' RETURNING id`,
      [planned[0].id, now],
    );
    return { ok: true, reason: null, id: rows[0]?.id ?? planned[0].id };
  }

  const { rows } = await pool.query(
    `INSERT INTO e_import_run (kind, dry_run, status, started_at, params)
     VALUES ($1, $2, 'planned', $3, jsonb_build_object('manual', true))
     ON CONFLICT (kind) WHERE status = 'planned' DO NOTHING
     RETURNING id`,
    [kind, dryRun, now],
  );
  if (!rows.length) return { ok: false, reason: 'planned', id: null };
  return { ok: true, reason: null, id: rows[0].id };
}
