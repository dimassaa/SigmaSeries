// Шаг 3 регистрации: «Выберите любимые» (F-01-01 §4, H-55).
//
// Выбор сохраняется зёрнами вкуса, а не статусами и не отметками: иначе
// пять случайных сериалов испортили бы статистику просмотра, а человек, который
// ничего не смотрел, числился бы зрителем пяти сериалов.
//
// Правила проверяются на сервере, а не в форме: сетка отключает «Готово», но
// прямой запрос с шестью сериалами обязан быть отвергнут — иначе правило
// «не больше 3 из одного жанра» держится на честности посетителя.

import pg from 'pg';

/** Сетка шага 3 (F-01-01 §4): двадцать четыре популярных сериала. */
export const GRID_SIZE = 24;

/** «Готово» активна при 3–5 выбранных (F-01-01 §4). */
export const MIN_CHOICE = 3;
export const MAX_CHOICE = 5;

/** Не больше трёх сериалов одного основного жанра (F-01-01 §4). */
export const MAX_PER_GENRE = 3;

/** Почему выбор не принят. */
export const REASONS = {
  TOO_FEW: 'too-few',
  TOO_MANY: 'too-many',
  GENRE: 'genre',
  MISSING: 'missing',
};

/**
 * Источник данных зёрен вкуса и сетки выбора.
 *
 * @param {pg.Pool} pool
 */
export function pgTaste(pool) {
  return {
    /**
     * Популярные сериалы для сетки.
     *
     * Порядок тот же, что у каталога по умолчанию: по голосам IMDb, а не по
     * собственному вкусу редактора. Человек выбирает из того, что знают все,
     * а не из того, что полюбил автор.
     *
     * @param {number} [size]
     * @returns {Promise<Array<{id:number, slug:string, title:string,
     *   genreCode:string, genreRu:string|null, genreEn:string|null,
     *   posterWidth:number|null, votes:number|null}>>}
     */
    async popular({ size = GRID_SIZE } = {}) {
      const { rows } = await pool.query(
        `SELECT s.id, s.slug,
                coalesce(s.title_ru, s.title_original, s.slug) AS title,
                (SELECT g.code FROM e_series_genre sg JOIN e_genre g ON g.code = sg.genre_code
                  WHERE sg.series_id = s.id ORDER BY g.code LIMIT 1) AS genre_code,
                (SELECT g.name_ru FROM e_series_genre sg JOIN e_genre g ON g.code = sg.genre_code
                  WHERE sg.series_id = s.id ORDER BY g.code LIMIT 1) AS genre_ru,
                (SELECT g.name_en FROM e_series_genre sg JOIN e_genre g ON g.code = sg.genre_code
                  WHERE sg.series_id = s.id ORDER BY g.code LIMIT 1) AS genre_en,
                -- Роль «постер» живёт в e_image, а не в e_image_variant, и
                -- берётся самая узкая картинка — та же, что показывает каталог.
                (SELECT iv.width FROM e_image_variant iv
                   JOIN e_image im ON im.id = iv.image_id
                  WHERE im.series_id = s.id AND im.role = 'poster'
                  ORDER BY iv.width LIMIT 1) AS poster_width,
                (SELECT votes FROM e_external_rating r
                  WHERE r.series_id = s.id AND r.platform = 'imdb') AS votes
           FROM e_series s
           LEFT JOIN e_external_rating r ON r.series_id = s.id AND r.platform = 'imdb'
          WHERE s.publication_state = 'published' AND s.archived_at IS NULL
          ORDER BY r.votes DESC NULLS LAST, s.title_ru ASC
          LIMIT $1`,
        [size],
      );
      return rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        genreCode: row.genre_code,
        // Оба названия: язык выбирает представление, а не источник данных —
        // иначе источник знал бы о языке интерфейса.
        genreRu: row.genre_ru,
        genreEn: row.genre_en,
        posterWidth: row.poster_width,
        votes: row.votes,
      }));
    },

    /**
     * Сохраняет выбор.
     *
     * Проверки идут до записи, а не после: половина сохранённых зёрен хуже,
     * чем отказ с понятным текстом.
     *
     * @param {{userId:number, seriesIds:number[], source?:string}} input
     * @returns {Promise<{ok:boolean, reason?:string, saved?:number}>}
     */
    async save({ userId, seriesIds, source = 'signup' }) {
      const chosen = [...new Set(seriesIds.map(Number).filter(Number.isInteger))];
      if (chosen.length < MIN_CHOICE) return { ok: false, reason: REASONS.TOO_FEW };
      if (chosen.length > MAX_CHOICE) return { ok: false, reason: REASONS.TOO_MANY };

      // Основной жанр берётся тем же способом, что и на карточке: первому по
      // алфавиту коду. Отдельного признака «основной» в схеме нет, и заводить
      // его ради одного правила — это правка каталога, а не регистрации.
      const { rows } = await pool.query(
        `SELECT s.id, (SELECT g.code FROM e_series_genre sg JOIN e_genre g ON g.code = sg.genre_code
                        WHERE sg.series_id = s.id ORDER BY g.code LIMIT 1) AS genre
           FROM e_series s
          WHERE s.id = ANY($1::bigint[]) AND s.publication_state = 'published'`,
        [chosen],
      );
      if (rows.length !== chosen.length) return { ok: false, reason: REASONS.MISSING };

      const byGenre = new Map();
      for (const row of rows) {
        const genre = row.genre ?? '—';
        byGenre.set(genre, (byGenre.get(genre) ?? 0) + 1);
        if (byGenre.get(genre) > MAX_PER_GENRE) return { ok: false, reason: REASONS.GENRE };
      }

      await pool.query(
        `INSERT INTO e_taste_seed (user_id, series_id, source)
         SELECT $1, unnest($2::bigint[]), $3
         ON CONFLICT (user_id, series_id) DO UPDATE SET source = EXCLUDED.source`,
        [userId, chosen, source],
      );
      return { ok: true, saved: chosen.length };
    },

    /**
     * Жанры для карточек, найденных поиском.
     *
     * Поиск отдаёт свои строки и жанра в них не несёт: добавление жанра в его
     * выборку меняло бы общий модуль ради одного экрана. Берётся ровно то, чего
     * не хватает, и по тому же правилу, что на карточке каталога, — первый по
     * алфавиту код.
     *
     * @param {Array<number|string>} ids
     * @returns {Promise<Map<number, {genreRu: string|null, genreEn: string|null,
     *   genreCode: string|null}>>}
     */
    async genresOf(ids) {
      const wanted = [...new Set(ids.map(Number).filter(Number.isInteger))];
      if (!wanted.length) return new Map();

      const { rows } = await pool.query(
        `SELECT s.id,
                (SELECT g.code FROM e_series_genre sg JOIN e_genre g ON g.code = sg.genre_code
                  WHERE sg.series_id = s.id ORDER BY g.code LIMIT 1) AS code,
                (SELECT g.name_ru FROM e_series_genre sg JOIN e_genre g ON g.code = sg.genre_code
                  WHERE sg.series_id = s.id ORDER BY g.code LIMIT 1) AS ru,
                (SELECT g.name_en FROM e_series_genre sg JOIN e_genre g ON g.code = sg.genre_code
                  WHERE sg.series_id = s.id ORDER BY g.code LIMIT 1) AS en
           FROM e_series s WHERE s.id = ANY($1::bigint[])`,
        [wanted],
      );
      return new Map(rows.map((row) => [Number(row.id), {
        genreCode: row.code ?? null, genreRu: row.ru ?? null, genreEn: row.en ?? null,
      }]));
    },

    /**
     * Уже сохранённый выбор — чтобы вернувшийся человек увидел своё.
     *
     * @param {number} userId
     * @returns {Promise<number[]>}
     */
    async selected(userId) {
      const { rows } = await pool.query(
        'SELECT series_id FROM e_taste_seed WHERE user_id = $1 ORDER BY created_at', [userId],
      );
      return rows.map((row) => Number(row.series_id));
    },
  };
}