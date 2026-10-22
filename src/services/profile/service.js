// Публичный профиль пользователя (S-18, F-01-07).
//
// Профиль отвечает на вопрос «кто это написал». Видно ник, инициалы, дату
// регистрации и опубликованные работы. Статистика и список отмеченных
// сериалов показываются, только если человек сам их открыл (F-01-07 §4):
// по умолчанию закрыто, и открытый профиль не значит «всё про меня».
//
// Удалённый аккаунт отвечает «Пользователь удалён» (EC-A22): его материалы
// при анонимизации обезличиваются или удаляются (F-01-10), а в чужих
// местах ник автора заменяется текстом без ссылки на профиль.

import pg from 'pg';

/** F-01-07 §9: списки постранично, по двадцать на страницу. */
export const PROFILE_PAGE_SIZE = 20;

/** Состояния материала, видимые читателям. */
const PUBLIC_STATES = ['published', 'approved'];

/**
 * Данные публичного профиля.
 *
 * @param {pg.Pool} pool
 */
export function pgProfile(pool) {
  return {
    /**
     * Пользователь по нику.
     *
     * Ник уникален без учёта регистра, и в адрес он может попасть в любом
     * написании: «/u/Ivan» и «/u/ivan» — один и тот же человек.
     *
     * @param {string} nickname
     * @returns {Promise<any|null>} профиль или null, если такого ника нет
     */
    async byNickname(nickname) {
      const { rows } = await pool.query(
        `SELECT id, nickname, status, registered_at, stats_public, profile_public
           FROM e_user
          WHERE lower(nickname) = lower($1)`,
        [String(nickname ?? '')],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: Number(row.id),
        nickname: row.nickname,
        status: row.status,
        registeredAt: row.registered_at,
        statsPublic: row.stats_public === true,
        profilePublic: row.profile_public === true,
      };
    },

    /**
     * Пользователь по идентификатору.
     *
     * @param {number} userId
     * @returns {Promise<any|null>}
     */
    async byId(userId) {
      const { rows } = await pool.query(
        `SELECT id, nickname, status, registered_at, stats_public, profile_public
           FROM e_user WHERE id = $1`,
        [userId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: Number(row.id),
        nickname: row.nickname,
        status: row.status,
        registeredAt: row.registered_at,
        statsPublic: row.stats_public === true,
        profilePublic: row.profile_public === true,
      };
    },

    /**
     * Счётчики опубликованных работ: отзывы и руководства.
     *
     * @param {number} userId
     * @returns {Promise<{review: number, guide: number}>}
     */
    async counts(userId) {
      const { rows } = await pool.query(
        `SELECT kind, count(*)::int AS n
           FROM e_material
          WHERE author_id = $1 AND kind IN ('review','guide') AND state = ANY($2::text[])
          GROUP BY kind`,
        [userId, PUBLIC_STATES],
      );
      const counts = { review: 0, guide: 0 };
      for (const row of rows) counts[row.kind] = Number(row.n);
      return counts;
    },

    /**
     * Страница опубликованных материалов автора.
     *
     * @param {number} userId
     * @param {'review'|'guide'} kind
     * @param {{page?: number, pageSize?: number}} [options]
     * @returns {Promise<{items: any[], total: number, page: number, pages: number}>}
     */
    async materials(userId, kind, { page = 1, pageSize = PROFILE_PAGE_SIZE } = {}) {
      const size = Math.max(1, pageSize);
      const number = Math.max(1, page);
      const { rows } = await pool.query(
        `SELECT m.id, m.title, m.slug, m.spoiler, m.created_at, m.lang,
                left(m.body, 240) AS excerpt,
                s.id AS series_id, s.slug AS series_slug,
                coalesce(s.title_ru, s.title_original) AS series_title
           FROM e_material m
           LEFT JOIN e_series s ON s.id = m.series_id
          WHERE m.author_id = $1 AND m.kind = $2 AND m.state = ANY($3::text[])
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $4 OFFSET $5`,
        [userId, kind, PUBLIC_STATES, size, (number - 1) * size],
      );
      const { rows: [total] } = await pool.query(
        `SELECT count(*)::int AS n
           FROM e_material
          WHERE author_id = $1 AND kind = $2 AND state = ANY($3::text[])`,
        [userId, kind, PUBLIC_STATES],
      );
      const count = Number(total.n);
      return {
        items: rows.map((row) => ({
          id: Number(row.id),
          title: row.title,
          slug: row.slug,
          spoiler: row.spoiler === true,
          createdAt: row.created_at,
          lang: row.lang,
          excerpt: row.excerpt ?? '',
          seriesId: row.series_id === null ? null : Number(row.series_id),
          seriesSlug: row.series_slug,
          seriesTitle: row.series_title,
        })),
        total: count,
        page: number,
        pages: Math.max(1, Math.ceil(count / size)),
      };
    },

    /**
     * Статистика: сколько сериалов отмечено, оценок и отзывов.
     *
     * Отметки — это статусы просмотра (F-03-04): отдельной таблицы закладок
     * в чтении нет (находка #126), и закладка без статуса — то же самое,
     * что статус без закладки.
     *
     * @param {number} userId
     * @returns {Promise<{marked: number, ratings: number, reviews: number}>}
     */
    async statistics(userId) {
      const { rows: [row] } = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM e_watch_status WHERE user_id = $1) AS marked,
           (SELECT count(*)::int FROM e_rating WHERE user_id = $1 AND counted) AS ratings,
           (SELECT count(*)::int FROM e_material
             WHERE author_id = $1 AND kind = 'review' AND state = ANY($2::text[])) AS reviews`,
        [userId, PUBLIC_STATES],
      );
      return {
        marked: Number(row.marked),
        ratings: Number(row.ratings),
        reviews: Number(row.reviews),
      };
    },

    /**
     * Список отмеченных сериалов: страница.
     *
     * @param {number} userId
     * @param {{page?: number, pageSize?: number}} [options]
     * @returns {Promise<{items: any[], total: number, page: number, pages: number}>}
     */
    async marked(userId, { page = 1, pageSize = PROFILE_PAGE_SIZE } = {}) {
      const size = Math.max(1, pageSize);
      const number = Math.max(1, page);
      const { rows } = await pool.query(
        `SELECT s.id, s.slug, coalesce(s.title_ru, s.title_original) AS title,
                ws.status, ws.changed_at
           FROM e_watch_status ws
           JOIN e_series s ON s.id = ws.series_id
          WHERE ws.user_id = $1
          ORDER BY ws.changed_at DESC, s.id
          LIMIT $2 OFFSET $3`,
        [userId, size, (number - 1) * size],
      );
      const { rows: [total] } = await pool.query(
        'SELECT count(*)::int AS n FROM e_watch_status WHERE user_id = $1',
        [userId],
      );
      const count = Number(total.n);
      return {
        items: rows.map((row) => ({
          id: Number(row.id),
          slug: row.slug,
          title: row.title,
          status: row.status,
          changedAt: row.changed_at,
        })),
        total: count,
        page: number,
        pages: Math.max(1, Math.ceil(count / size)),
      };
    },
  };
}
