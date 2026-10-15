// Персона (F-02-09, S-15).
//
// Страница человека существует ровно настолько, насколько человек виден в
// каталоге: без видимых сериалов адреса нет (404). Фото у человека нет —
// источник IMDb `name.basics` его не даёт, а выдуманная картинка в шапке
// страницы вреднее пустой плашки с инициалами.
//
// Сетка отсортирована по популярности (голоса IMDb), и это единственное место
// в каталоге, где порядок решает не редакция: человек сходит по фильмам, а не
// читает список ролей.
//
// Индексация — только от двух сериалов (F-02-09 §3): страница об одном сериале
// в выдаче поисковика ничего не добавляет.

import pg from 'pg';

/** Сериалов на страницу; дальше постранично (F-02-09 «Валидация и лимиты»). */
export const PERSON_SERIES_LIMIT = 60;

/**
 * Источник данных страницы человека.
 *
 * @param {pg.Pool} pool
 */
export function pgPerson(pool) {
  return {
    /**
     * Человек и его сериалы.
     *
     * @param {string} slug
     * @param {object} [options]
     * @param {number} [options.page] страница сетки, начиная с 1
     * @param {number} [options.limit]
     * @returns {Promise<object|null>}
     */
    async person(slug, { page = 1, limit = PERSON_SERIES_LIMIT } = {}) {
      const { rows } = await pool.query(
        'SELECT id, slug, name, kind FROM e_person WHERE slug = $1',
        [slug],
      );
      const person = rows[0];
      if (!person) return null;

      const [roles, total] = await Promise.all([
        rolesOf(pool, person.id),
        countVisible(pool, person.id),
      ]);
      // Без видимых сериалов человека нет: страница «человек, нигде не
      // снимавшийся» — это пустая страница, а такие адреса в индексе не нужны.
      if (!total) return null;

      const offset = (Math.max(1, page) - 1) * limit;
      const { rows: series } = await pool.query(
        `SELECT s.id, s.slug,
                coalesce(s.title_ru, s.title_en, s.title_original) AS title,
                s.year_start,
                sp.role,
                r.votes,
                (SELECT iv.width FROM e_image_variant iv
                   JOIN e_image i ON i.id = iv.image_id
                  WHERE i.series_id = s.id AND i.role = 'poster'
                  ORDER BY iv.width LIMIT 1) AS poster_width
           FROM e_series_person sp
           JOIN e_series s ON s.id = sp.series_id
           LEFT JOIN e_external_rating r ON r.series_id = s.id AND r.platform = 'imdb'
          WHERE sp.person_id = $1
            AND s.publication_state = 'published' AND s.archived_at IS NULL
          ORDER BY r.votes DESC NULLS LAST, s.year_start DESC NULLS LAST, s.id
          LIMIT $2 OFFSET $3`,
        [person.id, limit, offset],
      );

      return {
        slug: person.slug,
        name: person.name,
        kind: person.kind,
        roles,
        initials: initialsOf(person.name),
        series: series.map((row) => ({
          id: row.id,
          slug: row.slug,
          title: row.title ?? '',
          year: row.year_start ?? '',
          role: row.role,
          votes: row.votes,
          posterWidth: row.poster_width,
        })),
        total,
        page: Math.max(1, page),
        limit,
        pages: Math.max(1, Math.ceil(total / limit)),
        // Один сериал — тонкая страница: в индексе ей нечего предложить.
        thin: total < 2,
      };
    },
  };
}

/**
 * Все роли человека в каталоге.
 *
 * `e_person.kind` — одна роль, а `e_series_person.role` — своя для каждого
 * сериала, и человек нередко играет и режиссирует. Страница показывает обе.
 *
 * @param {pg.Pool} pool
 * @param {number} personId
 * @returns {Promise<string[]>}
 */
async function rolesOf(pool, personId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT sp.role
       FROM e_series_person sp
       JOIN e_series s ON s.id = sp.series_id
      WHERE sp.person_id = $1
        AND s.publication_state = 'published' AND s.archived_at IS NULL`,
    [personId],
  );
  return rows.map((row) => row.role);
}

async function countVisible(pool, personId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total
       FROM e_series_person sp
       JOIN e_series s ON s.id = sp.series_id
      WHERE sp.person_id = $1
        AND s.publication_state = 'published' AND s.archived_at IS NULL`,
    [personId],
  );
  return rows[0].total;
}

/**
 * Инициалы для плашки вместо фото.
 *
 * @param {string} name
 * @returns {string}
 */
function initialsOf(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  const first = [...(parts[0] ?? '')][0] ?? '';
  const second = parts.length > 1 ? [...parts[1]][0] : [...(parts[0] ?? '').slice(1)][0] ?? '';
  return (first + second).toUpperCase();
}