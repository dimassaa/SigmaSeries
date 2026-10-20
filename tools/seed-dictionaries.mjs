// Сид справочников: жанры и платформы рейтингов (F-10-10, P0).
//
// Справочники нужны всему каталогу: фильтрам, странице жанра и правилам
// отбора баннеров. Стартовые значения — из таблицы сида фичи F-10-10 §7.
//
// Скрипт идемпотентен: запускать его можно сколько угодно раз, он только
// дополняет недостающее и не трогает то, что админ правил вручную.

import pg from 'pg';

/** Двадцать жанров: название IMDb, код и название ru. */
const GENRES = [
  ['Drama', 'drama', 'Драма'],
  ['Crime', 'crime', 'Криминал'],
  ['Comedy', 'comedy', 'Комедия'],
  ['Action', 'action', 'Боевик'],
  ['Mystery', 'mystery', 'Детектив'],
  ['Adventure', 'adventure', 'Приключения'],
  ['Romance', 'romance', 'Мелодрама'],
  ['Thriller', 'thriller', 'Триллер'],
  ['Music', 'music', 'Музыка'],
  ['War', 'war', 'Военный'],
  ['Musical', 'musical', 'Мюзикл'],
  ['Fantasy', 'fantasy', 'Фэнтези'],
  ['Sci-Fi', 'sci-fi', 'Фантастика'],
  ['Horror', 'horror', 'Ужасы'],
  ['Biography', 'biography', 'Биография'],
  ['History', 'history', 'История'],
  ['Documentary', 'documentary', 'Документальный'],
  ['Family', 'family', 'Семейный'],
  ['Sport', 'sport', 'Спорт'],
  ['Western', 'western', 'Вестерн'],
];

/** Платформы: код, название, шкала, порядок, активна ли. */
const PLATFORMS = [
  ['imdb', 'IMDb', 10, 10, true],
  ['tmdb', 'TMDB', 10, 20, true],
  ['kp', 'Кинопоиск', 10, 30, true],
  ['rt_critics', 'Rotten Tomatoes — критики', 100, 40, true],
  ['rt_audience', 'Rotten Tomatoes — зрители', 100, 50, true],
];

const pool = new pg.Pool();

try {
  for (const [code, nameRu, nameEn] of GENRES) {
    await pool.query(
      `INSERT INTO e_genre (code, name_ru, name_en, active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (code) DO NOTHING`,
      [code, nameRu, nameEn],
    );
  }
  for (const [code, name, scaleMax, priority, active] of PLATFORMS) {
    await pool.query(
      `INSERT INTO e_rating_platform (code, name, scale_max, priority, active)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (code) DO NOTHING`,
      [code, name, scaleMax, priority, active],
    );
  }
  const { rows: [genres] } = await pool.query(
    'SELECT count(*)::int AS n FROM e_genre WHERE code NOT LIKE \'imdb:%\'',
  );
  const { rows: [platforms] } = await pool.query(
    'SELECT count(*)::int AS n FROM e_rating_platform',
  );
  console.log(`Справочники: жанров ${genres.n}, платформ ${platforms.n}.`);
} finally {
  await pool.end();
}
