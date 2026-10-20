// Студия: список сериалов (S-73) и очередь неполных карточек (S-74).
//
// Студия — единственное место, где видно состояние каждой карточки: что
// опубликовано, чего не хватает и куда сериал можно поставить. Уровень
// полноты и причины хранятся рядом с сериалом, поэтому список — это один
// запрос, а не соединение на каждую строку.
//
// Фильтры — белый список (F-10-01 §9): значение из адреса подставляется в
// запрос только после проверки по списку, а не «как пришло».

/** Сколько строк на странице (F-10-01 §14). */
export const PAGE_SIZE = 50;

/**
 * Причины неполноты и их класс (M12 §8).
 *
 * Класс определяет порядок очереди: блокирующие → размещение → содержание →
 * служебные.
 */
export const REASON_CLASSES = {
  no_tmdb: 'blocking',
  pair_doubt: 'blocking',
  no_genre: 'blocking',
  no_poster: 'content',
  no_overview: 'content',
  no_overview_ru: 'content',
  no_people: 'content',
  no_backdrop: 'placement',
  schedule_gap: 'placement',
  new_genre: 'service',
  no_age: 'info',
};

/** Состояния публикации — белый список фильтра. */
export const PUBLICATION_STATES = ['imported', 'published', 'archived'];

/** Состояния выхода — белый список фильтра. */
export const EXIT_STATES = ['announced', 'airing', 'waiting', 'ended', 'cancelled'];

/** Уровни полноты — белый список фильтра. */
export const LEVELS = ['full', 'displayable', 'minimum'];

/** Сортировки: ключ → выражение ORDER BY. */
const SORTS = {
  popular: 'imdb_votes DESC NULLS LAST, s.id',
  updated: 's.added_at DESC, s.id',
  title: 'lower(coalesce(s.title_ru, s.title_original)), s.id',
};

/**
 * Студия каталога.
 *
 * @param {import('pg').Pool} pool
 */
export function pgStudioCatalogue(pool) {
  /**
   * Список сериалов с фильтрами.
   *
   * @param {object} [options]
   * @param {number} [options.page]
   * @param {string} [options.query] название, tconst или tmdb_id
   * @param {string} [options.publication]
   * @param {string} [options.exit]
   * @param {string} [options.level]
   * @param {string[]} [options.reasons]
   * @param {string} [options.genre]
   * @param {number|null} [options.yearFrom]
   * @param {number|null} [options.yearTo]
   * @param {string} [options.sort]
   * @returns {Promise<{rows: object[], total: number, page: number, pages: number}>}
   */
  async function list(options = {}) {
    const {
      page = 1,
      query = '',
      publication = '',
      exit = '',
      level = '',
      reasons = [],
      genre = '',
      yearFrom = null,
      yearTo = null,
      sort = 'popular',
    } = options;

    const where = [];
    const params = [];
    const add = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    const text = String(query ?? '').trim();
    if (text) {
      const p = add(`%${text}%`);
      where.push(`(s.title_ru ILIKE ${p} OR s.title_original ILIKE ${p}
                   OR s.imdb_key ILIKE ${p} OR s.tmdb_id::text ILIKE ${p})`);
    }
    if (PUBLICATION_STATES.includes(publication)) {
      where.push(`s.publication_state = ${add(publication)}`);
    }
    if (EXIT_STATES.includes(exit)) {
      where.push(`s.exit_state = ${add(exit)}`);
    }
    if (LEVELS.includes(level)) {
      where.push(`s.level = ${add(level)}`);
    }
    const wanted = reasons.filter((reason) => reason in REASON_CLASSES);
    if (wanted.length) {
      // Каждая причина должна быть у сериала: фильтр «причина = no_backdrop»
      // показывает именно такие карточки, а не «хоть одну из».
      where.push(`s.reasons @> ${add(wanted)}::text[]`);
    }
    if (genre) {
      const p = add(genre);
      where.push(`EXISTS (SELECT 1 FROM e_series_genre sg
                           WHERE sg.series_id = s.id AND sg.genre_code = ${p})`);
    }
    if (Number.isFinite(yearFrom)) {
      where.push(`s.year_start >= ${add(Number(yearFrom))}`);
    }
    if (Number.isFinite(yearTo)) {
      where.push(`s.year_start <= ${add(Number(yearTo))}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = SORTS[sort] ?? SORTS.popular;
    const limitParam = add(PAGE_SIZE);
    const offsetParam = add((Math.max(1, Number(page) || 1) - 1) * PAGE_SIZE);

    const { rows } = await pool.query(`
      SELECT s.id, s.slug,
             coalesce(s.title_ru, s.title_original) AS title,
             s.title_original, s.year_start,
             s.publication_state, s.exit_state, s.level, s.reasons,
             s.added_at, s.imdb_key, s.tmdb_id,
             r.value::float AS imdb, r.votes AS imdb_votes,
             pv.width AS poster_width,
             -- Куда сериал можно поставить. «Заставка» делит условие с
             -- баннером: кадры заставки берутся из тех же фонов.
             (s.reasons @> ARRAY['no_backdrop']) = false AS can_banner,
             (s.exit_state IN ('airing','announced')
               AND (s.reasons @> ARRAY['schedule_gap']) = false) AS can_calendar,
             EXISTS (SELECT 1 FROM e_season se
                       JOIN e_release rel ON rel.season_id = se.id
                      WHERE se.series_id = s.id
                        AND rel.release_date BETWEEN CURRENT_DATE - 14 AND CURRENT_DATE)
               AS can_fresh,
             count(*) OVER () AS total
        FROM e_series s
        LEFT JOIN e_external_rating r
               ON r.series_id = s.id AND r.platform = 'imdb'
        LEFT JOIN LATERAL (
          SELECT iv.width FROM e_image_variant iv
          JOIN e_image i ON i.id = iv.image_id
          WHERE i.series_id = s.id AND i.role = 'poster'
          ORDER BY iv.width LIMIT 1
        ) pv ON true
        ${whereSql}
       ORDER BY ${orderSql}
       LIMIT ${limitParam} OFFSET ${offsetParam}`, params);

    const total = rows.length ? Number(rows[0].total) : 0;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return {
      rows: rows.map(decorate),
      total,
      page: Math.max(1, Number(page) || 1),
      pages,
    };
  }

  /**
   * Очередь неполных карточек.
   *
   * Порядок — по классу причины, а внутри класса по числу голосов IMDb:
   * сначала то, что мешает публикации, потом то, что мешает размещению.
   *
   * @param {object} [options]
   * @param {number} [options.page]
   * @param {string} [options.reason] одна причина вместо всех
   * @returns {Promise<{rows: object[], total: number, page: number, pages: number}>}
   */
  async function incomplete(options = {}) {
    const { page = 1, reason = '' } = options;
    const params = [];
    const add = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    const where = [`s.reasons <> '{}'`];
    if (reason in REASON_CLASSES) {
      where.push(`s.reasons @> ${add([reason])}::text[]`);
    }
    const limitParam = add(PAGE_SIZE);
    const offsetParam = add((Math.max(1, Number(page) || 1) - 1) * PAGE_SIZE);

    const { rows } = await pool.query(`
      SELECT s.id, s.slug,
             coalesce(s.title_ru, s.title_original) AS title,
             s.title_original, s.year_start,
             s.publication_state, s.exit_state, s.level, s.reasons,
             s.added_at, s.imdb_key, s.tmdb_id,
             r.value::float AS imdb, r.votes AS imdb_votes,
             pv.width AS poster_width,
             (s.reasons @> ARRAY['no_backdrop']) = false AS can_banner,
             (s.exit_state IN ('airing','announced')
               AND (s.reasons @> ARRAY['schedule_gap']) = false) AS can_calendar,
             EXISTS (SELECT 1 FROM e_season se
                       JOIN e_release rel ON rel.season_id = se.id
                      WHERE se.series_id = s.id
                        AND rel.release_date BETWEEN CURRENT_DATE - 14 AND CURRENT_DATE)
               AS can_fresh,
             count(*) OVER () AS total
        FROM e_series s
        LEFT JOIN e_external_rating r
               ON r.series_id = s.id AND r.platform = 'imdb'
        LEFT JOIN LATERAL (
          SELECT iv.width FROM e_image_variant iv
          JOIN e_image i ON i.id = iv.image_id
          WHERE i.series_id = s.id AND i.role = 'poster'
          ORDER BY iv.width LIMIT 1
        ) pv ON true
       WHERE ${where.join(' AND ')}
       ORDER BY CASE
                  WHEN s.reasons && ARRAY['no_tmdb','pair_doubt','no_genre'] THEN 0
                  WHEN s.reasons && ARRAY['no_backdrop','schedule_gap'] THEN 1
                  WHEN s.reasons && ARRAY['no_poster','no_overview','no_overview_ru','no_people'] THEN 2
                  ELSE 3
                END,
                r.votes DESC NULLS LAST,
                s.id
       LIMIT ${limitParam} OFFSET ${offsetParam}`, params);

    const total = rows.length ? Number(rows[0].total) : 0;
    return {
      rows: rows.map(decorate),
      total,
      page: Math.max(1, Number(page) || 1),
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    };
  }

  /**
   * Жанры для фильтра.
   *
   * @returns {Promise<{code: string, title: string}[]>}
   */
  async function genres() {
    const { rows } = await pool.query(
      // Только те жанры, что есть у сериалов: фильтр по жанру без сериалов
      // ничего не находит и только занимает строку.
      `SELECT g.code, coalesce(NULLIF($1, 'ru'), g.name_ru) AS title
         FROM e_genre g
         JOIN e_series_genre sg ON sg.genre_code = g.code
        WHERE g.active
          -- Сырые жанры IMDb импорт пишет с префиксом imdb:; в фильтре они
          -- лишние: у них нет названия, и в них нет ни одного сериала из
          -- справочника.
          AND g.code NOT LIKE 'imdb:%'
        GROUP BY g.code, g.name_ru
        ORDER BY g.name_ru`, ['ru'],
    );
    return rows.map((row) => ({ code: row.code, title: row.title }));
  }

  return { list, incomplete, genres };
}

/**
 * Строка списка в вид для разметки.
 *
 * @param {object} row
 * @returns {object}
 */
function decorate(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title ?? '',
    titleOriginal: row.title_original ?? '',
    year: row.year_start ?? '',
    publicationState: row.publication_state,
    exitState: row.exit_state,
    level: row.level,
    // Причины с классом: порядок в очереди и цвет значка берутся из класса.
    reasons: (row.reasons ?? []).map((code) => ({
      code,
      kind: REASON_CLASSES[code] ?? 'service',
    })),
    addedAt: row.added_at,
    imdb: row.imdb === null || row.imdb === undefined ? null : Number(row.imdb),
    imdbVotes: row.imdb_votes === null ? null : Number(row.imdb_votes),
    posterWidth: row.poster_width,
    canBanner: Boolean(row.can_banner),
    canCalendar: Boolean(row.can_calendar),
    canFresh: Boolean(row.can_fresh),
  };
}
