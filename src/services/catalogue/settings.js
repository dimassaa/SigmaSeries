// Порог голосов внешнего рейтинга (M2 §0, `external_rating.min_votes_display`).
//
// Число 10 в документации названо для TMDB; автор 15.10 подтвердил то же и для
// IMDb. Смысл один: «8,5» от трёх человек и «8,5» от двухсот тысяч — это разные
// числа, и показывать их одинаково нельзя. Рейтинг, у которого голосов меньше
// порога, не показывается, не сортирует выдачу и не проходит фильтр.
//
// Свой рейтинг сайта (M4) под порог не попадает: там другие значения
// (5 для сериала, 3 для серии), и ключ называется иначе — специально, чтобы их
// не перепутать.

/** Порог, пока ключа нет в настройках (M2 §0, H-24). */
export const DEFAULT_RATING_FLOOR = 10;

/**
 * Порог голосов и размер страницы каталога — одним запросом.
 *
 * Два ключа читаются вместе не из экономии: страница и фильтр рейтинга
 * спрашивают их в одном и том же вызове, и второй запрос ничего бы не дал.
 *
 * @param {object} pool
 * @returns {Promise<{pageSize: number, ratingFloor: number}>}
 */
export async function importSettings(pool) {
  const { rows } = await pool.query(
    "SELECT key, value FROM e_system_setting WHERE key IN ('catalog.page_size', 'external_rating.min_votes_display')",
  );
  const values = new Map(rows.map((row) => [row.key, Number(row.value)]));

  const pageSize = values.get('catalog.page_size');
  const floor = values.get('external_rating.min_votes_display');

  return {
    pageSize: Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 100
      ? pageSize
      : DEFAULT_PAGE_SIZE,
    ratingFloor: Number.isInteger(floor) && floor >= 0 ? floor : DEFAULT_RATING_FLOOR,
  };
}

const DEFAULT_PAGE_SIZE = 24;