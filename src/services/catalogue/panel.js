// Правая панель «Предстоящие» (F-03-06, UI-04).
//
// Три решения, которые этот файл держит:
//
//  1. Панель — дополнение, а не содержимое страницы. Ошибка данных возвращает
//     пустой список, а не исключение: страница, ради которой человек пришёл,
//     не должна падать из-за уголка.
//  2. Кэш keyed по локальной дате (H-72), а не по поясу и не по человеку:
//     панель показывает календарные даты («сегодня вышло», «завтра»), поэтому
//     двум людям с одной календарной датой достаточно одной записи. Личный
//     порядок (H-71) считается поверх кэша и в него не входит.
//  3. Один сериал — одна строка, и это ближайший его выход: две строки про
//     один сериал читались бы как два разных сериала.

import pg from 'pg';

/** `panel.items` (M3 §0): строк в панели. */
export const PANEL_ITEMS = 10;

/** `panel.window_days` (M3 §0): окно «сегодня … +N дней». */
export const PANEL_WINDOW_DAYS = 14;

/** `panel.cache_s` (M3 §0): сколько живёт запись кэша. */
export const PANEL_CACHE_S = 300;

/** Сколько вариантов держится одновременно (F-03-06 §8в): три пояса каталога. */
export const MAX_CACHED_VARIANTS = 3;

/**
 * Подпись даты выхода (R-I18N-05).
 *
 * До трёх дней — словами, дальше — датой: «через девять дней» длиннее самой
 * даты и читается хуже её.
 *
 * @param {string} locale
 * @param {string} date `YYYY-MM-DD`
 * @param {string} today сегодня пояса читателя
 * @returns {string}
 */
export function captionFor(locale, date, today) {
  const days = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );

  if (days <= 0) return locale === 'en' ? 'Out today' : 'Сегодня вышла';
  if (days === 1) return locale === 'en' ? 'Tomorrow' : 'Завтра';
  if (days <= 3) {
    return locale === 'en'
      ? `In ${days} days`
      : `Через ${days} ${days === 2 ? 'дня' : 'дня'}`.replace('дня дня', 'дня');
  }

  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ru-RU', {
    day: 'numeric', month: 'short',
  }).format(new Date(`${date}T00:00:00Z`)).replace('.', '.');
}

/**
 * Подпись серии: `S2E5`, `S2E5–6` или «все серии сезона» (EC-T6).
 *
 * @param {{seasonNumber: number, episodes: number[], coversSeason: boolean, seasonEpisodes: number}} row
 * @returns {string}
 */
export function labelFor(row) {
  if (row.coversSeason) return `S${row.seasonNumber} · все ${row.seasonEpisodes}`;

  const episodes = [...(row.episodes ?? [])].sort((a, b) => a - b);
  if (episodes.length === 1) return `S${row.seasonNumber}E${episodes[0]}`;
  if (episodes.length === 2) return `S${row.seasonNumber}E${episodes[0]}–${episodes[1]}`;
  if (episodes.length > 2) return `S${row.seasonNumber}E${episodes[0]}–${episodes[episodes.length - 1]}`;
  return `S${row.seasonNumber}`;
}

/**
 * Источник данных панели.
 *
 * @param {pg.Pool} pool
 * @param {object} [options]
 * @param {number} [options.cacheSeconds]
 * @param {number} [options.maxVariants]
 * @param {() => number} [options.clock]
 */
export function pgUpcomingPanel(pool, {
  cacheSeconds = PANEL_CACHE_S,
  maxVariants = MAX_CACHED_VARIANTS,
  clock = () => Date.now(),
  onError = null,
} = {}) {
  /** Ключ — локальная дата, значение — строки и момент записи. */
  const cache = new Map();

  return {
    /**
     * Ближайшие выходы.
     *
     * @param {object} args
     * @param {string} args.today сегодня пояса читателя `YYYY-MM-DD`
     * @param {number} [args.userId] поднимает сериалы «Смотрю» и «В планах»
     * @returns {Promise<object[]>}
     */
    async upcoming({ today, userId = null, limit = PANEL_ITEMS, windowDays = PANEL_WINDOW_DAYS }) {
      try {
        return await collect({
          pool, today, userId, limit, windowDays, cache, cacheSeconds, maxVariants, clock,
        });
      } catch (error) {
        // Панель — дополнение: страница, ради которой человек пришёл, не должна
        // падать из-за уголка. Причина уходит наверх, чтобы молчание не было
        // ошибкой, о которой никто не узнает.
        onError?.(error);
        return [];
      }
    },
  };
}

/** Сборка ответа: кэш, личный порядок и подписи. */
async function collect({ pool, today, userId, limit, windowDays, cache, cacheSeconds, maxVariants, clock }) {
  const rows = await releases({ pool, today, limit, windowDays, cache, cacheSeconds, maxVariants, clock });
  if (!rows.length) return [];

  const mine = userId ? await watching(pool, userId, rows.map((row) => row.seriesId)) : new Set();

  // Личный порядок поверх кэша (H-71): сериалы из «Смотрю» и «В планах» идут
  // выше остальных, а внутри своих групп порядок остаётся прежним —
  // сегодняшние, затем по дате, при равенстве по голосам.
  return [...rows]
    .sort((a, b) => (mine.has(b.seriesId) ? 1 : 0) - (mine.has(a.seriesId) ? 1 : 0))
    .map((row) => ({ ...row, mine: mine.has(row.seriesId) }));
}

/**
 * Ближайшие выходы из базы с кэшем по локальной дате.
 *
 * @returns {Promise<object[]>}
 */
async function releases({ pool, today, limit, windowDays, cache, cacheSeconds, maxVariants, clock }) {
  const hit = cache.get(today);
  if (hit && clock() - hit.at < cacheSeconds * 1000) return hit.rows;

  // Сначала ближайший выход каждого сериала, потом уже «самые ближайшие из
  // ближайших». Порядок важен: ограничение по числу строк внутри `DISTINCT ON`
  // отсекало бы сериалы с большими идентификаторами, то есть ровно те, что
  // импортированы последними, — а панель показывает ближайшие даты.
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (s.id)
              s.id AS series_id, s.slug,
              coalesce(s.title_ru, s.title_en, s.title_original) AS title,
              se.number AS season_number,
              r.release_date::text AS date,
              r.covers_season,
              (SELECT count(*)::int FROM e_episode e2 WHERE e2.season_id = se.id AND e2.number > 0)
                AS season_episodes,
              coalesce((SELECT array_agg(e.number ORDER BY e.number)
                          FROM e_release_episode link
                          JOIN e_episode e ON e.id = link.episode_id
                         WHERE link.release_id = r.id), '{}') AS episodes,
              coalesce((SELECT r2.votes FROM e_external_rating r2
                         WHERE r2.series_id = s.id AND r2.platform = 'imdb'), 0) AS votes
         FROM e_release r
         JOIN e_season se ON se.id = r.season_id AND se.number > 0
         JOIN e_series s ON s.id = se.series_id
        WHERE s.publication_state = 'published' AND s.archived_at IS NULL
          AND r.release_date >= $1::date
          AND r.release_date < ($1::date + $2::int)::date
          -- Выход без состава и без отметки сезона в календаре не показывается
          -- (EC-T3): в панели он был бы строкой, которая ничего не объясняет.
          AND (r.covers_season
               OR EXISTS (SELECT 1 FROM e_release_episode link WHERE link.release_id = r.id))
        ORDER BY s.id, r.release_date
     ) nearest
     ORDER BY date, votes DESC, title
     LIMIT $3`,
    [today, windowDays, limit],
  );

  const list = rows.map((row) => ({
    seriesId: row.series_id,
    slug: row.slug,
    title: row.title,
    seasonNumber: row.season_number,
    date: row.date,
    votes: row.votes,
    label: labelFor({
      seasonNumber: row.season_number,
      episodes: row.episodes ?? [],
      coversSeason: row.covers_season,
      seasonEpisodes: row.season_episodes,
    }),
  }));

  // Порядок повторяется в Node: после сборки строки сортируются ещё раз — ради
  // личного порядка и ради одинакового результата, если запрос вернулся из
  // кэша, собранного другой веткой кода.
  list.sort((a, b) => a.date.localeCompare(b.date) || b.votes - a.votes || a.title.localeCompare(b.title));

  cache.set(today, { rows: list, at: clock() });
  // Вариантов держится столько, сколько поясов в каталоге зрителей: иначе
  // за месяц в кэше осело бы тридцать записей, и ни одна не понадобится.
  while (cache.size > maxVariants) cache.delete(cache.keys().next().value);

  return list;
}

/** Сериалы, за которыми человек следит: их панель показывает выше. */
async function watching(pool, userId, seriesIds) {
  if (!seriesIds.length) return new Set();
  const { rows } = await pool.query(
    `SELECT series_id FROM e_watch_status
      WHERE user_id = $1 AND series_id = ANY($2::bigint[])
        AND status IN ('watching', 'planned')`,
    [userId, seriesIds],
  );
  return new Set(rows.map((row) => Number(row.series_id)));
}