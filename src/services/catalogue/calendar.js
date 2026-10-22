// Календарь выходов (F-03-05, S-16, OP-08).
//
// Один запрос на диапазон (измерение 14: «календарь — один запрос на диапазон
// ≤ 62 дней»), потому что сетка месяца, неделя и список спрашивают одни и те же
// данные тремя способами. Разница между видами — в разметке, а не в запросе.
//
// Что в выдаче не зависит от статуса сериала: даты важнее статуса (H-39).
// Показываются выходы любых видимых сериалов, у которых дата попала в диапазон.
// Гостю и без подписок отдаётся всё то же самое — фильтр «Мои» (EC-T21)
// разбирается в маршруте, где понятно, кто перед посетителем.
//
// Сезон целиком — одна запись «все N серий» (EC-T6, EC-D11), а не N строк: в
// стриминге так выходит примерно в шести случаях из тридцати, и месяц из
// тридцати строк вместо одного дня читать невозможно.

import pg from 'pg';

import { isKnownTimeZone, todayIn } from '../timezone.js';

/**
 * Предел диапазона за запрос (M3 §0, `calendar.max_range_days`).
 *
 * Пока ключа нет в настройках, берётся это число — оно же записано в таблицу
 * настроек модуля и проверяется тестом: расхождение означало бы, что страница
 * молча показывает меньше, чем человек просил.
 */
export const DEFAULT_MAX_RANGE_DAYS = 62;

/**
 * Источник данных календаря.
 *
 * @param {pg.Pool} pool
 */
export function pgCalendar(pool) {
  return {
    /**
     * Выходы за период, сгруппированные по дням.
     *
     * @param {object} options
     * @param {string} options.from `YYYY-MM-DD`
     * @param {string} options.to `YYYY-MM-DD`
     * @param {number|null} [options.userId] для фильтра «Мои»
     * @param {string} [options.timezone] пояс посетителя (H-72)
     * @returns {Promise<{from: string, to: string, days: Map<string, any[]>, total: number,
     *   truncated: boolean}>}
     */
    async days({ from, to, userId = null, timezone = 'Europe/Minsk' }) {
      const start = from;
      const last = await lastDay(pool, start, to);
      const truncated = last < to;

      const { rows } = await pool.query(
        `SELECT r.id, r.release_date::text AS release_date, r.release_time::text AS release_time,
                r.precision, r.input_tz,
                se.number AS season_number,
                r.covers_season, r.state,
                s.id AS series_id, s.slug,
                coalesce(s.title_ru, s.title_en, s.title_original) AS title,
                (SELECT count(*)::int FROM e_release_episode rle WHERE rle.release_id = r.id) AS linked,
                (SELECT array_agg(e.number ORDER BY e.number)
                   FROM e_release_episode rle
                   JOIN e_episode e ON e.id = rle.episode_id
                  WHERE rle.release_id = r.id) AS episode_numbers,
                (SELECT count(*)::int FROM e_episode e
                  WHERE e.season_id = se.id AND e.number > 0) AS season_episodes,
                (SELECT iv.width FROM e_image_variant iv
                   JOIN e_image i ON i.id = iv.image_id
                  WHERE i.series_id = s.id AND i.role = 'poster'
                  ORDER BY iv.width LIMIT 1) AS poster_width
           FROM e_release r
           JOIN e_season se ON se.id = r.season_id
           JOIN e_series s ON s.id = se.series_id
          WHERE r.release_date BETWEEN $1 AND $2
            AND s.publication_state = 'published'
            AND s.archived_at IS NULL
            AND ($3::bigint IS NULL OR EXISTS (
                  SELECT 1 FROM e_subscription sub
                   WHERE sub.user_id = $3 AND sub.series_id = s.id
                     AND sub.kind = 'release' AND sub.enabled))
          ORDER BY r.release_date, r.release_time NULLS LAST, s.slug`,
        [start, last, userId],
      );

      const days = new Map();
      for (const row of rows) {
        // Дата со временем переезжает в поясе посетителя, дата без времени — нет
        // (OP-08а, EC-T3). Импорт пока пишет только «дата», но правило в коде
        // стоит раньше, чем появятся строки со временем.
        const date = shiftedDate(row.release_date, row.release_time, row.input_tz, timezone);
        const entry = {
          id: row.id,
          seriesId: row.series_id,
          seriesSlug: row.slug,
          seriesTitle: row.title ?? '',
          seasonNumber: row.season_number ?? 0,
          // Три вида записи (DEC-056): сезон помечен явно, а одна серия или
          // группа отличаются числом связей — это и есть состав выхода (EC-D11).
          kind: row.covers_season ? 'season' : (row.linked === 1 ? 'episode' : 'group'),
          // Состояние выхода: «перенесён» и «отменён» показываются подписью.
          // Человек, которому показали «12 октября» для перенесённой серии,
          // придёт в этот день зря (R-SEO-18).
          state: row.state,
          coversSeason: row.covers_season,
          episodeNumbers: row.linked === 1 ? row.episode_numbers ?? [] : [],
          // У выхода сезона серий столько, сколько их в сезоне: «все 8 серий»
          // должно называть настоящее число, а не «0» (EC-T6). У выхода без
          // связей и без отметки сезона серий нет — и показывать его нечем.
          episodeCount: row.linked > 0
            ? row.linked
            : (row.covers_season ? row.season_episodes ?? 0 : 0),
          time: row.release_time ? row.release_time.slice(0, 5) : null,
          precision: row.precision,
          posterWidth: row.poster_width,
        };

        // Выход без состава и без отметки «весь сезон» показать нечем: ни одной
        // серии он не касается, а дата у него есть. Такой строке в календаре
        // не место, и молча пропустить её — правильнее, чем показать запись
        // без названия серии.
        if (!entry.coversSeason && entry.episodeCount === 0) continue;

        if (!days.has(date)) days.set(date, []);
        days.get(date).push(entry);
      }

      // Порядок внутри дня: известное время раньше неизвестного, потом время
      // по названию — иначе одна и та же сетка пересобиралась бы при каждом
      // прогоне и адреса вида «календарь» менялись бы без причины.
      for (const entries of days.values()) {
        entries.sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99')
          || a.seriesTitle.localeCompare(b.seriesTitle));
      }

      return {
        from: start,
        to: last,
        days,
        total: rows.length,
        truncated,
      };
    },
  };
}

/**
 * Последний день диапазона: не дальше предела из настроек (F-03-05 §5).
 *
 * Диапазон длиннее обрезается, а не отклоняется: человек просил календарь, а
 * ошибка вместо календаря его ничему не учит.
 *
 * @param {pg.Pool} pool
 * @param {string} from
 * @param {string} to
 * @returns {Promise<string>}
 */
async function lastDay(pool, from, to) {
  const { rows } = await pool.query(
    'SELECT value FROM e_system_setting WHERE key = $1',
    ['calendar.max_range_days'],
  );
  const value = Number(rows[0]?.value);
  const limit = Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_RANGE_DAYS;
  return to < addDays(from, limit - 1) ? to : addDays(from, limit - 1);
}

/**
 * Дата выхода в поясе посетителя.
 *
 * Для точности «дата» дата берётся как есть: сдвигать её по поясу нельзя, иначе
 * серия, вышедшая 12 октября, оказалась бы 11-м числом у того, кто в Лос-Анджелесе
 * (OP-08а). Для «дата и время» момент пересчитывается и может перейти на
 * соседний день (EC-T3).
 *
 * Неизвестный или негодный пояс оставляет дату из базы: лучше показать день
 * источника, чем ничего (EC-T4).
 *
 * @param {string} date `YYYY-MM-DD` из базы
 * @param {string|null} time `HH:MM:SS` или `null`
 * @param {string|null} sourceTimezone пояс, в котором введено время
 * @param {string} targetTimezone пояс посетителя
 * @returns {string}
 */
export function shiftedDate(date, time, sourceTimezone, targetTimezone) {
  if (!time || !sourceTimezone) return date;
  // Негодный пояс — это «сегодня» посетителя не посчитать, а не ошибка 500 на
  // каждом запросе: в cookie он попадает извне (EC-T4).
  if (!isKnownTimeZone(sourceTimezone) || !isKnownTimeZone(targetTimezone)) return date;

  const [hour, minute] = time.split(':').map(Number);
  const sourceOffset = zoneOffset(new Date(`${date}T00:00:00Z`), sourceTimezone);
  if (sourceOffset === null) return date;

  // Момент выхода в UTC: строки базы разбираются как время в поясе источника,
  // поэтому из него вычитается смещение именно этого пояса.
  const base = Date.parse(`${date}T00:00:00Z`) + (hour * 60 + minute) * 60_000 - sourceOffset * 60_000;
  return todayIn(targetTimezone, new Date(base));
}

/**
 * Смещение пояса в минутах на момент; `null`, если пояс непригоден.
 *
 * Считается через `Intl`: список поясов и правила перехода на летнее время
 * живут в среде, а свой пересчёт летнего времени был бы второй, неверной
 * реализацией.
 *
 * @param {Date} moment
 * @param {string} timeZone
 * @returns {number|null}
 */
function zoneOffset(moment, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(moment);

    const value = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
    const asUtc = Date.UTC(value.year, value.month - 1, value.day, value.hour % 24, value.minute, value.second);
    return Math.round((asUtc - moment.getTime()) / 60_000);
  } catch {
    return null;
  }
}

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}