// Настройки главной страницы (M6 §0, таблица настроек модуля).
//
// Ключи читаются из `e_system_setting` — того же места, что и остальные
// настройки, — и поэтому администратор правит их без правки кода. Раньше все
// двенадцать чисел стояли константами в `home/data.js`: страница работала, но
// ключ из спецификации не влиял ни на что, и на вопрос «а где
// `home.banners_per_day`» ответа не было.
//
// Значения по умолчанию — те же числа, что в M6 §0. Ключа нет — работает
// умолчание: отсутствие строки в настройках не должно ломать главную.

/** `home.*` из M6 §0. */
export const DEFAULTS = {
  bannersPerDay: 3,
  classicMinYear: 2016,
  classicMinRating: 8.5,
  newReleaseWindowDays: 7,
  freshPerPage: 6,
  freshPages: 3,
  marqueeCollections: 6,
  marqueeIntervalMs: 4000,
  genresPerRow: 6,
  genreWindowDays: 1095,
  reloadHour: 4,
};

const KEYS = {
  bannersPerDay: 'home.banners_per_day',
  classicMinYear: 'home.classic_min_year',
  classicMinRating: 'home.classic_min_rating',
  newReleaseWindowDays: 'home.new_release_window_d',
  freshPerPage: 'home.fresh_per_page',
  freshPages: 'home.fresh_pages',
  marqueeCollections: 'home.marquee_collections',
  marqueeIntervalMs: 'home.marquee_interval_ms',
  genresPerRow: 'home.genres_per_row',
  genreWindowDays: 'home.genre_window',
  reloadHour: 'home.reload_hour',
};

/**
 * Настройки главной одним запросом.
 *
 * Один запрос, а не двенадцать: главная — самая частая страница, и двенадцать
 * обращений к настройкам на каждый её открытие дороже, чем весь остальной код
 * главной вместе взятый.
 *
 * @param {pg.Pool} pool
 * @returns {Promise<typeof DEFAULTS>}
 */
export async function homeSettings(pool) {
  const { rows } = await pool.query(
    `SELECT key, value FROM e_system_setting WHERE key = ANY($1::text[])`,
    [Object.values(KEYS)],
  );
  const values = new Map(rows.map((row) => [row.key, Number(row.value)]));

  const result = { ...DEFAULTS };
  for (const [field, key] of Object.entries(KEYS)) {
    const value = values.get(key);
    if (Number.isFinite(value) && value > 0) result[field] = value;
  }
  return result;
}