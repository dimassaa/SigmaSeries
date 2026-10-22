// «Выбор редакции» и предпросмотр баннеров (F-10-08).
//
// Назначение — вручную поставить сериал на место «Выбор редакции» в трёх
// баннерах дня. Предпросмотр считается тем же кодом отбора, что и главная
// (F-10-08 §8): если предпросмотр считать отдельно, он разойдётся с главной
// в первый же день, и админ будет смотреть не на то, что увидят.

import { pgBannerSelection } from '../home/banners.js';
import { homeSettings } from '../home/settings.js';

/**
 * Выборы редакции.
 *
 * @param {import('pg').Pool} pool
 */
export function pgEditorialPicks(pool) {
  const selection = pgBannerSelection(pool);

  /**
   * Назначения за месяц.
   *
   * @param {{year: number, month: number}} period
   * @returns {Promise<Map<string, object>>} дата (YYYY-MM-DD) → назначение
   */
  async function month({ year, month }) {
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const { rows } = await pool.query(
      `SELECT p.id, p.active_from::text AS day, p.active_until::text AS until_day,
              p.note, p.set_at, s.id AS series_id, s.slug,
              coalesce(s.title_ru, s.title_original) AS title,
              s.archived_at IS NOT NULL AS withdrawn,
              (s.reasons @> ARRAY['no_backdrop']) AS no_backdrop
         FROM e_editorial_pick p
         JOIN e_series s ON s.id = p.series_id
        WHERE p.active_from <= $2::date
          AND (p.active_until IS NULL OR p.active_until >= $1::date)
        ORDER BY p.set_at DESC`,
      [from, lastDay(year, month)],
    );
    const map = new Map();
    for (const row of rows) {
      const day = row.active_from ?? row.day;
      if (!map.has(day)) {
        map.set(day, {
          id: row.id,
          day,
          seriesId: row.series_id,
          slug: row.slug,
          title: row.title,
          note: row.note,
          setAt: row.set_at,
          // Назначенный сериал может потерять пригодность: ушёл в архив или
          // остался без фона. Тогда работает автовыбор, а день подсвечен
          // админу (EC-S17).
          withdrawn: Boolean(row.withdrawn),
          noBackdrop: Boolean(row.no_backdrop),
        });
      }
    }
    return map;
  }

  /**
   * Назначить выбор на дату.
   *
   * @param {{seriesId: number, date: string, byId: number, note?: string}} args
   * @returns {Promise<boolean>}
   */
  async function assign({ seriesId, date, byId, note = null }) {
    const { rows: [series] } = await pool.query(
      `SELECT id FROM e_series
        WHERE id = $1 AND archived_at IS NULL AND publication_state = 'published'`,
      [seriesId],
    );
    if (!series) return false;

    // На дату назначен только один выбор: срок прежнего заканчивается на
    //канун дня, чтобы два выбора не делили одно место.
    await pool.query(
      `UPDATE e_editorial_pick
          SET active_until = ($1::date - 1)
        WHERE active_until IS NULL AND active_from >= $1::date`,
      [date],
    );
    await pool.query(
      `INSERT INTO e_editorial_pick (series_id, set_by, active_from, active_until, note)
       VALUES ($1, $2, $3, NULL, $4)`,
      [seriesId, byId, date, note],
    );
    return true;
  }

  /**
   * Снять назначение на дату.
   *
   * @param {{date: string}} args
   * @returns {Promise<boolean>}
   */
  async function clear({ date }) {
    const { rowCount } = await pool.query(
      'DELETE FROM e_editorial_pick WHERE active_from = $1::date AND active_until IS NULL',
      [date],
    );
    return rowCount > 0;
  }

  /**
   * Сериалы, годные для баннера.
   *
   * @param {number} [limit]
   * @returns {Promise<any[]>}
   */
  async function candidates(limit = 50) {
    const { rows } = await pool.query(
      `SELECT s.id, s.slug, coalesce(s.title_ru, s.title_original) AS title,
              s.year_start, r.value::float AS imdb
         FROM e_series s
         LEFT JOIN e_external_rating r ON r.series_id = s.id AND r.platform = 'imdb'
        WHERE s.archived_at IS NULL
          AND s.publication_state = 'published'
          AND (s.reasons @> ARRAY['no_backdrop']) = false
        ORDER BY r.value DESC NULLS LAST, s.title_original
        LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      year: row.year_start,
      imdb: row.imdb === null ? null : Number(row.imdb),
    }));
  }

  /**
   * Предпросмотр трёх баннеров на дату.
   *
   * @param {{date: string}} args
   * @returns {Promise<any[]>}
   */
  async function preview({ date }) {
    const settings = await homeSettings(pool);
    const picked = await selection.select({ date, settings });
    return picked.map((banner) => ({
      kind: banner.kind,
      seriesId: banner.seriesId,
      slug: banner.slug,
      title: banner.title,
      year: banner.yearStart,
      imdb: banner.imdb,
    }));
  }

  /**
   * Пересчитать баннеры на дату.
   *
   * @param {{date: string}} args
   * @returns {Promise<any[]>}
   */
  async function recompute({ date }) {
    const settings = await homeSettings(pool);
    return selection.recompute({ date, settings });
  }

  return { month, assign, clear, candidates, preview, recompute };
}

/**
 * Последний день месяца.
 *
 * @param {number} year
 * @param {number} month 1–12
 * @returns {string}
 */
function lastDay(year, month) {
  const date = new Date(Date.UTC(year, month, 0));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
