// Жанры: меню в шапке (UI-03, F-02-04) и страница жанра (S-03).
//
// Оба экрана читают один справочник `e_genre`, но с разными правилами:
//
//  • меню показывает только жанры, которые админ открыл для навигации
//    (`show_in_menu`), из справочника (не сырые), с числом сериалов ≥ 1 —
//    жанр без сериалов в меню лишний (EC-K7);
//  • страница отвечает по прямому адресу, поэтому её правила мягче: скрытый
//    для меню жанр закрыт и здесь (F-02-04 «неизвестный или скрытый — 404»),
//    а ноль сериалов — не ошибка, а пустая страница.
//
// Кэша нет: жанров двадцать, запрос копеечный, и хранить его ещё где-то —
// значит получить вторую копию справочника, которая рано или поздно
// разъедется с базой. Числа берутся во время запроса, как на странице жанра.

/**
 * Верхняя граница меню: в навигации помещаются не больше 30 жанров (F-02-04 §9).
 * Записей в справочнике столько нет и не предполагается; ограничение — защита
 * от творчества админа, а не рабочий потолок.
 */
const MENU_LIMIT = 30;

/**
 * Жанр страницы S-03 — строка, которую вид и маршрут получают целиком.
 *
 * @typedef {object} GenrePage
 * @property {string} code
 * @property {string} nameRu
 * @property {string} nameEn
 * @property {string|null} descriptionRu
 * @property {string|null} descriptionEn
 * @property {number|null} displayOrder порядок в меню; пусто — по алфавиту
 * @property {boolean} showInMenu всегда true: скрытые жанры считаются 404
 * @property {number} count число видимых сериалов
 */

/**
 * Пункт меню жанров (UI-03).
 *
 * @typedef {object} GenreMenuItem
 * @property {string} code
 * @property {string} nameRu
 * @property {string} nameEn
 * @property {number|null} displayOrder
 * @property {number} count
 */

/**
 * Источник данных по жанрам.
 *
 * @param {any} pool настоящий Pool или тестовый двойник с `query`
 */
export function pgCatalogueGenres(pool) {
  /**
   * Видимая часть каталога — одно и то же условие в меню и на странице:
   * иначе число в меню и число на странице жанра разъезжались бы.
   */
  const VISIBLE_FIELD = `AND s.publication_state = 'published' AND s.archived_at IS NULL`;

  /**
   * Пункты меню: код, оба названия, порядок и число сериалов.
   *
   * Порядок: `display_order` (пустое — в конце), внутри группы — по алфавиту
   * названия локали (F-10-10 §4). Коллатор на стороне JS: у базы коллация за
   * сменой локали не следит, а `Intl.Collator` выбирает правила по её же
   * таблицам, тем же, что в остальном интерфейсе.
   *
   * @param {string} [locale]
   * @returns {Promise<GenreMenuItem[]>}
   */
  async function menu(locale = 'ru') {
    const { rows } = await pool.query(`
      SELECT g.code, g.name_ru, g.name_en, g.display_order,
             count(s.id)::int AS series_count
        FROM e_genre g
        JOIN e_series_genre sg ON sg.genre_code = g.code
        JOIN e_series s ON s.id = sg.series_id ${VISIBLE_FIELD}
       WHERE g.active AND g.is_raw = FALSE AND g.show_in_menu
       GROUP BY g.code, g.name_ru, g.name_en, g.display_order, g.name_ru, g.name_en
      HAVING count(s.id) > 0
       ORDER BY g.display_order NULLS LAST, g.code`);

    const items = rows.map((row) => ({
      code: row.code,
      nameRu: row.name_ru,
      nameEn: row.name_en,
      displayOrder: row.display_order,
      count: Number(row.series_count),
    }));

    const collator = new Intl.Collator(locale === 'en' ? 'en' : 'ru');
    const nameOf = (item) => (locale === 'en' ? item.nameEn : item.nameRu);
    items.sort((a, b) =>
      ((a.displayOrder ?? Infinity) - (b.displayOrder ?? Infinity))
      || collator.compare(nameOf(a), nameOf(b)));

    return items.slice(0, MENU_LIMIT);
  }

  /**
   * Жанр страницы S-03: и сам жанр, и число видимых сериалов одним запросом.
   *
   * `show_in_menu = FALSE` здесь же означает «нет»: скрытый для меню жанр
   * закрыт и по прямому адресу (F-02-04), поэтому страница его не показывает.
   * LEFT JOIN нужен затем, чтобы пустой жанр вернулся с нулём, а не исчез —
   * пустая страница жанра это состояние страницы, а не ошибка.
   *
   * @param {string} code код жанра из адреса: сверка напрямую с базой
   * @returns {Promise<GenrePage|null>}
   */
  async function one(code) {
    const { rows } = await pool.query(`
      SELECT g.code, g.name_ru, g.name_en, g.description_ru, g.description_en,
             g.display_order, g.show_in_menu,
             count(s.id)::int AS series_count
        FROM e_genre g
        LEFT JOIN e_series_genre sg ON sg.genre_code = g.code
        LEFT JOIN e_series s ON s.id = sg.series_id ${VISIBLE_FIELD}
       WHERE g.code = $1
         AND g.active AND g.is_raw = FALSE AND g.show_in_menu
       GROUP BY g.code, g.name_ru, g.name_en, g.description_ru, g.description_en,
                g.display_order, g.show_in_menu`, [String(code ?? '')]);

    const row = rows[0];
    if (!row) return null;
    return {
      code: row.code,
      nameRu: row.name_ru,
      nameEn: row.name_en,
      descriptionRu: row.description_ru ?? null,
      descriptionEn: row.description_en ?? null,
      displayOrder: row.display_order,
      showInMenu: Boolean(row.show_in_menu),
      count: Number(row.series_count),
    };
  }

  return { menu, one };
}
