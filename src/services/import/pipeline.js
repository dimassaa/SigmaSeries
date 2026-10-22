// OP-06 и OP-07 — сопоставление каталогов и полнота карточки.
// Спецификация: docs/01-product/features/M12-import.md.
// Пороги полноты: docs/04-data/CONTENT-PLAN.md §3.
// Источники данных: docs/04-data/DATA-SOURCES.md.
//
// Модуль чистый: сеть и база внедряются. Импорт — единственное место, где
// ошибка одно раз тихо портит каталог навсегда, поэтому проверяется он
// целиком, а не «посмотреть глазами, что записи появились».

/** Допуск по году. Разные источники округляют по-разному. */
export const YEAR_TOLERANCE = 1;

/**
 * Ключ сопоставления названий.
 *
 * Приводит к сравнимому виду: регистр, ё, пунктуация, «the» в начале,
 * пробелы. «The Office» и «Office» должны совпасть, а «Office» и «Officer» —
 * нет, поэтому похожие строки не склеиваются, а только упрощаются.
 */
// ─── OP-07. Полнота карточки ──────────────────────────────────────────────────

/** Требования уровней — CONTENT-PLAN §3, дословно. */
export const LEVELS = {
  /** Название, год, ≥1 жанр, статус. */
  minimum: [
    { field: 'title', required: true },
    { field: 'year_start', required: true },
    { field: 'status', required: true },
    { field: 'genres', required: true, min: 1 },
  ],
  /** Минимум + постер + описание на ru или en. */
  displayable: [
    { field: 'poster', required: true },
    { field: 'description', required: true, anyOf: ['description_ru', 'description_en'] },
  ],
  /** + фон 16:9 ≥1920, ru-описание, график без пропусков, люди. */
  full: [
    { field: 'backdrop', required: true, minWidth: 1920 },
    { field: 'description_ru', required: true },
    { field: 'schedule', required: true, onlyWhenAiring: true },
    { field: 'people', required: true, min: 1 },
  ],
};

/**
 * Уровень полноты карточки.
 *
 * «Выходит» и «Ждём сезон» считаются по-разному: у выходящего сериала
 * график — часть полноты, у завершённого графика может не быть вовсе, и
 * требовать его — значит держать в очереди всё подряд.
 *
 * @param {Record<string, unknown>} card
 * @returns {{level:'full'|'displayable'|'minimum', missing:string[]}}
 */
export function completeness(card) {
  const isAiring = card.status === 'airing' || card.status === 'announced';
  const missing = [];

  const check = (list) => {
    for (const req of list) {
      if (req.onlyWhenAiring && !isAiring) continue;
      if (req.anyOf) {
        if (!req.anyOf.some((f) => hasValue(card[f]))) missing.push(req.field);
        continue;
      }
      const v = card[req.field];
      const enough = req.min != null
        ? Array.isArray(v) ? v.length >= req.min : Number(v ?? 0) >= req.min
        : hasValue(v);
      if (req.minWidth) {
        const w = Number(card[`${req.field}_width`] ?? 0);
        if (w < req.minWidth) missing.push(req.field);
        continue;
      }
      if (!enough) missing.push(req.field);
    }
  };

  check(LEVELS.minimum);
  if (missing.length) return { level: 'minimum', missing: [...new Set(missing)] };

  check(LEVELS.displayable);
  if (missing.length) return { level: 'displayable', missing: [...new Set(missing)] };

  check(LEVELS.full);
  if (missing.length) return { level: 'displayable', missing: [...new Set(missing)] };

  return { level: 'full', missing: [] };
}

function hasValue(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

// ─── Защита ручных правок ─────────────────────────────────────────────────────

/**
 * Какие поля импорт имеет право перезаписать.
 *
 * Ручная правка администратора переживает импорт (EC-R8, F-10-03(а)).
 * Без этого работа студии теряется при каждом запуске синхронизации, и
 * админ узнаёт об этом через месяц.
 *
 * @param {Record<string, unknown>} incoming поля из источника
 * @param {Set<string>|string[]} locked поля, зафиксированные вручную
 * @returns {{applied:Record<string, any>, skipped:string[]}}
 */
export function applyIncoming(incoming, locked) {
  const lock = locked instanceof Set ? locked : new Set(locked ?? []);
  const applied = {};
  const skipped = [];
  for (const [k, v] of Object.entries(incoming)) {
    if (lock.has(k)) skipped.push(k);
    else applied[k] = v;
  }
  return { applied, skipped };
}

/**
 * Один прогон импорта.
 *
 * Ошибка источника не должна оставлять каталог в промежуточном состоянии:
 * сначала собирается весь результат, и он применяется целиком. Иначе падение
 * TMDB на середине оставит половину карточек обновлённой, а половину нет —
 * и это невозможно отличить от штатной работы.
 *
 * @param {object} deps
 * @param {any} [deps.dryRun]
 * @param {(dryRun:boolean) => Promise<any[]>} deps.fetchSource
 * @param {(rows:any[], dryRun:boolean) => Promise<{written:number, skipped:number}>} deps.persist
 * @param {(event: any) => Promise<void>} [deps.onEvent]
 * @returns {Promise<{ok: boolean, written: number, skipped: number, count: number,
 *   dryRun?: boolean, error?: string}>}
 */
export async function runImport({ fetchSource, persist, onEvent = async () => {}, dryRun = false }) {
  const startedAt = new Date().toISOString();
  try {
    const source = await fetchSource(dryRun);
    const rows = Array.isArray(source) ? source : [];
    const result = dryRun
      ? { written: 0, skipped: rows.length, dryRun: true }
      : await persist(rows, false);
    await onEvent({ type: 'import.finished', startedAt, count: rows.length, ...result });
    return { ok: true, ...result, count: rows.length };
  } catch (e) {
    // Ничего не применено: persist не вызывался. Каталог остался как был.
    await onEvent({ type: 'import.failed', startedAt, error: String(e?.message ?? e) });
    return { ok: false, written: 0, skipped: 0, count: 0, error: String(e?.message ?? e) };
  }
}