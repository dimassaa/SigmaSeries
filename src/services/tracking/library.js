// Закладки (F-03-04, S-30).
//
// Список — это статусы зрителя, соединённые с каталогом и выходами. Отдельной
// таблицы закладок в чтении нет (находка #126), и это не потеря: закладка без
// статуса и статус без закладки — одно и то же.
//
// Прогресс и «продолжить» считаются на лету, а не берутся из кэша `E-Progress`:
// таблицы нет (F-03-03 не начата), а зрителей с сотней закладок и тысячами
// отметок приложение ещё не видело. Считать с кэшем имеет смысл, когда список
// начнут открывать часто; решение — за F-03-03.
//
// Счётчики на вкладках считаются по всем статусам пользователя, а не по
// выборке (F-03-04 §8): цифра, меняющаяся при переключении вкладки, читается
// как ошибка.

import pg from 'pg';

import { STATUSES } from './status.js';

/** Виды списка (F-03-04 §4): карточки по умолчанию и плотный список. */
export const VIEWS = ['cards', 'list'];

/** `library.page_size` (M3 §0): 24 закладки на страницу. */
export const LIBRARY_PAGE_SIZE = 24;

/** Сортировки — белый список: значение из адреса не должно попадать в SQL. */
/**
 * Сортировки — белый список: значение из адреса не должно попадать в SQL.
 *
 * Пишутся по именам колонок внешней выборки (алиасам), а не исходной таблицы:
 * в `ORDER BY` выражении PostgreSQL не ищет псевдонимы (`marked::float` даёт
 * «столбец не существует»), поэтому запрос обёрнут в подвыборку — там псевдонимы
 * становятся настоящими колонками.
 */
export const SORTS = {
  recent: 'changed_at DESC, series_id',
  title: 'title, series_id',
  // Сортировка по прогрессу идёт по строкам `e_progress`: выборка зрителя уже
  // получает прогресс из кэша, и второй подсчёт на ту же строку был бы вдвое
  // дороже без единой новой правды.
  progress: `progress_percent DESC NULLS LAST, title, series_id`,
  next: 'next_release_date NULLS LAST, title, series_id',
  year: 'year_start DESC NULLS LAST, title, series_id',
};

/**
 * Источник данных списка закладок.
 *
 * @param {pg.Pool} pool
 */
export function pgLibrary(pool) {
  return {
    /**
     * Страница закладок.
     *
     * @param {object} options
     * @param {number} options.userId
     * @param {string|null} [options.status] вкладка; `null` — все
     * @param {string} [options.sort]
     * @param {number} [options.page]
     * @param {number} [options.limit]
     * @param {string} [options.query] поиск по списку
     * @param {string} options.today сегодня пояса зрителя `YYYY-MM-DD`
     * @returns {Promise<{items: object[], total: number, counts: Record<string, number>,
     *   page: number, pages: number, limit: number, status: string|null, sort: string,
 *   query: string, view: 'cards'|'list'}>}
     */
    async list({
      userId,
      status = null,
      sort = 'recent',
      page = 1,
      limit = LIBRARY_PAGE_SIZE,
      query = '',
      view = 'cards',
      today,
      progressOf = null,
    }) {
      const wanted = STATUSES.includes(status) ? status : null;
      const orderBy = SORTS[sort] ?? SORTS.recent;
      const needle = String(query ?? '').trim();

      const { rows, total, counts } = await loadRows({
        pool, userId, status: wanted, needle, today, orderBy, progressOf,
      });

      // Страница за концом списка — последняя страница, а не пустая (EC-K6).
      const pages = Math.max(1, Math.ceil(total / limit));
      const current = Math.min(Math.max(1, page), pages);

      return {
        items: rows.slice((current - 1) * limit, current * limit),
        total,
        counts,
        page: current,
        pages,
        limit,
        status: wanted,
        sort: SORTS[sort] ? sort : 'recent',
        query: needle,
        // Чужое значение отбрасывается, а не показывается: вид из адреса не
        // должен уводить страницу в состояние, которого нет (F-03-04 §9).
        view: VIEWS.includes(view) ? view : 'cards',
      };
    },
  };
}

/**
 * Все строки закладок пользователя вместе со счётчиками.
 *
 * Одна выборка на страницу: прогресс и следующая серия считаются
 * коррелированными подзапросами, поэтому считать их отдельно для страницы
 * означало бы сначала выбрать все строки зрителя целиком — а он может быть
 * длиннее страницы.
 *
 * @param {object} args
 * @returns {Promise<{rows: object[], total: number, counts: Record<string, number>}>}
 */
async function loadRows({ pool, userId, status, needle, today, orderBy, progressOf }) {
  const counts = Object.fromEntries(STATUSES.map((value) => [value, 0]));

  const { rows } = await pool.query(
    `SELECT b.*,
            (SELECT round(p.marked::numeric * 100 / nullif(p.aired, 0))
               FROM e_progress p
              WHERE p.user_id = $1 AND p.series_id = b.series_id) AS progress_percent
       FROM (
    SELECT s.id AS series_id, s.slug,
            coalesce(s.title_ru, s.title_en, s.title_original) AS title,
            s.year_start, s.exit_state, s.archived_at IS NOT NULL AS archived,
            s.publication_state,
            ws.status, ws.changed_at::text AS changed_at,
            rel.d AS next_release_date,
            (SELECT iv.width FROM e_image_variant iv
               JOIN e_image i ON i.id = iv.image_id
              WHERE i.series_id = s.id AND i.role = 'poster'
              ORDER BY iv.width LIMIT 1) AS poster_width
       FROM e_watch_status ws
       JOIN e_series s ON s.id = ws.series_id
       LEFT JOIN LATERAL (
         SELECT min(r3.release_date) AS d
           FROM e_season se3
           JOIN e_release r3 ON r3.season_id = se3.id
          WHERE se3.series_id = s.id AND se3.number > 0 AND r3.release_date > $3::date
       ) rel ON true
      WHERE ws.user_id = $1
        AND ($2::text IS NULL OR ws.status = $2)
        -- Имя выражения целиком, а не псевдоним: в WHERE псевдонимы из
        -- списка выбора не видны, и запрос падал бы с «столбец не существует».
        AND ($4::text = '' OR coalesce(s.title_ru, s.title_en, s.title_original) ILIKE $4)
      ) AS b
      ORDER BY ${orderBy}`,
    [userId, status, today, needle ? `%${needle}%` : ''],
  );

  // Счётчики — по всем статусам зрителя: вкладки показывают, сколько чего
  // всего, а не сколько помещается в выборку.
  const { rows: tally } = await pool.query(
    'SELECT status, count(*)::int AS n FROM e_watch_status WHERE user_id = $1 GROUP BY status',
    [userId],
  );
  for (const row of tally) counts[row.status] = row.n;

  // Прогресс приходит из кэша `e_progress` (F-03-03 §9), а не считается на
  // каждую строку: двадцать четыре карточки — это двадцать четыре подзапроса.
  // Источник передаёт его функцией, поэтому слой списка не знает, откуда взялись
  // числа, а без прогресса остаётся рабочим — с нулями, а не с ошибкой.
  const cached = progressOf
    ? await progressOf(rows.map((row) => row.series_id))
    : new Map();

  const items = rows.map((row) => {
    const progress = cached.get(row.series_id) ?? {
      marked: 0, aired: 0, percent: 0, nextSeason: null, nextEpisode: null,
      nextDate: null, awaitingDate: null, skipped: 0, state: 'no-airdates',
    };

    return {
      seriesId: row.series_id,
      slug: row.slug,
      title: row.title ?? '',
      year: row.year_start ?? null,
      status: row.status,
      changedAt: row.changed_at,
      archived: row.archived,
      exitState: row.exit_state,
      posterWidth: row.poster_width,
      progress: {
        marked: progress.marked,
        total: progress.aired,
        percent: progress.percent,
        nextSeason: progress.nextSeason,
        nextEpisode: progress.nextEpisode,
        nextEpisodeDate: progress.nextDate,
        skipped: progress.skipped,
        state: progress.state,
      },
      nextReleaseDate: row.next_release_date ?? null,
    };
  });

  return { rows: items, total: items.length, counts };
}
