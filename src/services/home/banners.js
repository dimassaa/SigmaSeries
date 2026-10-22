// Отбор трёх баннеров дня (F-06-02).
//
// Три баннера — единственное место на сайте, где текст лежит поверх
// фотографии, поэтому к отбору два требования: места всегда три и сериалы
// всегда разные. Оба обеспечиваются здесь, а не в представлении.
//
// Отбор — чистая функция от каталога и выходов: правила проверяются без базы,
// а результат сохраняется в `e_banner`. Пересчитывать на каждый запрос нельзя:
// главная — самая частая страница, и она стоит на агрегате (F-06-02 §8г).

/**
 * Правила отбора — чистая функция.
 *
 * Кандидаты приходят уже отсортированными (по рейтингу, затем по адресу),
 * поэтому выбор — первый свободный: одинаковые входные данные дают
 * одинаковую тройку, и главная не «моргает» при каждом заходе (F-06-02 §8а).
 *
 * @param {object} input кандидаты по правилам
 * @param {any[]} input.newToday выходы сегодня
 * @param {any[]} input.newWindow выходы за окно запасного правила
 * @param {any[]} input.classicRated старые с рейтингом не ниже порога
 * @param {any[]} input.classicAny любые старые
 * @param {any[]} input.editorial активные выборы редакции
 * @param {any[]} input.editorialLast последний выбор, даже истёкший
 * @param {any} settings настройки главной
 * @returns {any[]} баннеры: `{kind, seriesId, slug, title, yearStart, imdb}`
 */
export function selectBanners(input, settings = {}) {
  const {
    newToday = [], newWindow = [], classicRated = [], classicAny = [],
    editorial = [], editorialLast = [],
  } = input ?? {};

  const taken = new Set();
  /**
   * Первый свободный кандидат из списка.
   *
   * @param {any[]} list
   * @returns {any|null}
   */
  const firstFree = (list) => {
    for (const candidate of list) {
      if (!taken.has(candidate.seriesId)) {
        taken.add(candidate.seriesId);
        return candidate;
      }
    }
    return null;
  };

  const picked = [];

  // 1. Новинка: лучший рейтинг среди сериалов, у которых сегодня вышла
  //    серия. Запасное правило — то же, но по окну в семь дней.
  const fresh = firstFree(newToday.length ? newToday : newWindow);
  if (fresh) picked.push({ kind: 'new', ...fresh });

  // 2. Классика: старше десяти лет и с рейтингом выше порога. Запасное — любой
  //    старше десяти лет, даже без рейтинга.
  const classic = firstFree(classicRated.length ? classicRated : classicAny);
  if (classic) picked.push({ kind: 'classic', ...classic });

  // 3. Выбор редакции: назначенный админом сериал. Если выбора нет — второй
  //    круг новинки или классики, но не тот же сериал дважды.
  const editorialPick = firstFree(editorial.length ? editorial : editorialLast);
  if (editorialPick) {
    picked.push({ kind: 'editorial', ...editorialPick });
  } else {
    const second = firstFree(newToday.length ? newToday : newWindow)
      ?? firstFree(classicRated.length ? classicRated : classicAny);
    if (second) picked.push({ kind: 'editorial', ...second });
  }

  return picked;
}

/**
 * Отбор баннеров и хранение результата.
 *
 * @param {import('pg').Pool} pool
 */
export function pgBannerSelection(pool) {
  /**
   * Кандидаты по правилам на дату.
   *
   * Дата приходит извне: локальная дата сервера и дата в базе могут
   * различаться, а «сегодня» для посетителя — это местное время.
   *
   * @param {{date?: string, settings?: any}} args
   * @returns {Promise<any>}
   */
  async function candidates({ date = localDate(), settings = {} } = {}) {
    const classicMinYear = settings.classicMinYear ?? 2016;
    const classicMinRating = settings.classicMinRating ?? 8.5;
    const windowDays = settings.newReleaseWindowDays ?? 7;

    const [today, recent, classic, classics, picks, lastPick] = await Promise.all([
      // Новинка: сериалы, у которых сегодня вышла серия. Рейтинг обязателен:
      // без рейтинга сортировать нечем (F-06-02 §5).
      pool.query(
        `SELECT s.id AS series_id, s.slug,
                coalesce(s.title_ru, s.title_original) AS title,
                s.year_start, r.value::float AS imdb
           FROM e_series s
           JOIN e_season se ON se.series_id = s.id
           JOIN e_release rel ON rel.season_id = se.id
           JOIN e_external_rating r ON r.series_id = s.id AND r.platform = 'imdb'
          WHERE s.archived_at IS NULL
            AND s.publication_state = 'published'
            AND s.exit_state = 'airing'
            AND rel.release_date = $1
          GROUP BY s.id, r.value
          ORDER BY r.value DESC, s.slug`,
        [date],
      ),
      // Запасное окно: те же сериалы, но за последние дни.
      pool.query(
        `SELECT s.id AS series_id, s.slug,
                coalesce(s.title_ru, s.title_original) AS title,
                s.year_start, r.value::float AS imdb
           FROM e_series s
           JOIN e_season se ON se.series_id = s.id
           JOIN e_release rel ON rel.season_id = se.id
           JOIN e_external_rating r ON r.series_id = s.id AND r.platform = 'imdb'
          WHERE s.archived_at IS NULL
            AND s.publication_state = 'published'
            AND s.exit_state = 'airing'
            AND rel.release_date BETWEEN $1::date - ($2 || ' days')::interval AND $1::date
          GROUP BY s.id, r.value
          ORDER BY r.value DESC, s.slug`,
        [date, String(windowDays)],
      ),
      // Классика: старше порога года и с рейтингом не ниже порога.
      pool.query(
        `SELECT s.id AS series_id, s.slug,
                coalesce(s.title_ru, s.title_original) AS title,
                s.year_start, r.value::float AS imdb
           FROM e_series s
           JOIN e_external_rating r ON r.series_id = s.id AND r.platform = 'imdb'
          WHERE s.archived_at IS NULL
            AND s.publication_state = 'published'
            AND s.exit_state = 'airing'
            AND s.year_start <= $1
            AND r.value >= $2
          ORDER BY r.value DESC, s.slug`,
        [classicMinYear, classicMinRating],
      ),
      // Запасное правило классики: любой старше десяти лет, рейтинг не нужен.
      pool.query(
        `SELECT s.id AS series_id, s.slug,
                coalesce(s.title_ru, s.title_original) AS title,
                s.year_start, r.value::float AS imdb
           FROM e_series s
           LEFT JOIN e_external_rating r ON r.series_id = s.id AND r.platform = 'imdb'
          WHERE s.archived_at IS NULL
            AND s.publication_state = 'published'
            AND s.exit_state = 'airing'
            AND s.year_start <= $1
          ORDER BY r.value DESC NULLS LAST, s.slug`,
        [classicMinYear],
      ),
      // Выбор редакции: активная запись — без срока или со сроком в будущем.
      pool.query(
        `SELECT s.id AS series_id, s.slug,
                coalesce(s.title_ru, s.title_original) AS title,
                s.year_start, r.value::float AS imdb
           FROM e_editorial_pick p
           JOIN e_series s ON s.id = p.series_id
           LEFT JOIN e_external_rating r ON r.series_id = s.id AND r.platform = 'imdb'
          WHERE p.active_from <= $1
            AND (p.active_until IS NULL OR p.active_until >= $1)
            AND s.archived_at IS NULL
            AND s.publication_state = 'published'
          ORDER BY p.set_at DESC, s.slug`,
        [date],
      ),
      // Запасной выбор: последний назначенный, даже если срок истёк.
      pool.query(
        `SELECT s.id AS series_id, s.slug,
                coalesce(s.title_ru, s.title_original) AS title,
                s.year_start, r.value::float AS imdb
           FROM e_editorial_pick p
           JOIN e_series s ON s.id = p.series_id
           LEFT JOIN e_external_rating r ON r.series_id = s.id AND r.platform = 'imdb'
          WHERE s.archived_at IS NULL
            AND s.publication_state = 'published'
          ORDER BY p.set_at DESC, s.slug
          LIMIT 1`,
      ),
    ]);

    return {
      newToday: today.rows.map(toCandidate),
      newWindow: recent.rows.map(toCandidate),
      classicRated: classic.rows.map(toCandidate),
      classicAny: classics.rows.map(toCandidate),
      editorial: picks.rows.map(toCandidate),
      editorialLast: lastPick.rows.map(toCandidate),
    };
  }

  /**
   * Выбрать баннеры на дату.
   *
   * @param {{date?: string, settings?: any}} args
   * @returns {Promise<any[]>}
   */
  async function select({ date = localDate(), settings = {} } = {}) {
    const pool2 = await candidates({ date, settings });
    return selectBanners(pool2, settings);
  }

  /**
   * Сохранить выбор.
   *
   * Пересчёт заменяет баннеры дня целиком: иначе после смены правил старый
   * третий баннер остался бы висеть рядом с новым.
   *
   * @param {any[]} picked
   * @param {{date?: string}} args
   * @returns {Promise<void>}
   */
  async function save(picked, { date = localDate() } = {}) {
    await pool.query('DELETE FROM e_banner WHERE show_on = $1', [date]);
    for (const banner of picked) {
      await pool.query(
        `INSERT INTO e_banner (kind, series_id, show_on, active)
         VALUES ($1, $2, $3, TRUE)`,
        [banner.kind, banner.seriesId, date],
      );
    }
  }

  /**
   * Пересчитать баннеры дня и сохранить.
   *
   * @param {{date?: string, settings?: any}} args
   * @returns {Promise<any[]>} выбранные баннеры
   */
  async function recompute({ date = localDate(), settings = {} } = {}) {
    const picked = await select({ date, settings });
    await save(picked, { date });
    return picked;
  }

  /**
   * Есть ли уже баннеры на дату.
   *
   * @param {string} [date]
   * @returns {Promise<number>}
   */
  async function countFor(date = localDate()) {
    const { rows: [row] } = await pool.query(
      'SELECT count(*)::int AS n FROM e_banner WHERE show_on = $1 AND active', [date],
    );
    return Number(row.n);
  }

  return { candidates, select, save, recompute, countFor };
}

/**
 * Строка из базы в вид кандидата.
 *
 * @param {any} row
 * @returns {any}
 */
function toCandidate(row) {
  return {
    seriesId: row.series_id,
    slug: row.slug,
    title: row.title,
    yearStart: row.year_start,
    imdb: row.imdb === null || row.imdb === undefined ? null : Number(row.imdb),
  };
}

/**
 * Локальная дата сервера в формате `YYYY-MM-DD`.
 *
 * Локальная, а не дата в базе: у посетителя «сегодня» — местное время, и
 * между двумя базами часовой пояс может разойтись.
 *
 * @param {Date} [at]
 * @returns {string}
 */
export function localDate(at = new Date()) {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
