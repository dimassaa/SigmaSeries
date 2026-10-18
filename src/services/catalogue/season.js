// Страницы сезона и серии (F-02-02, S-07 и S-08).
//
// Данные те же, что у карточки сериала, но читаются иначе: там сезоны ради
// якорей, здесь — целая страница с адресом, который можно переслать, и со
// ссылками на соседние серии. Поэтому источник свой: он отдаёт всё дерево
// сезона сразу, а не собирает его по частям.

/** Серий в сезоне больше этого — список обрезается (страница не резиновая). */
const EPISODES_LIMIT = 200;

/**
 * Источник данных страниц сезона и серии.
 *
 * @param {import('pg').Pool} pool
 */
export function pgSeasons(pool) {
  return {
    /**
     * Сезон с сериями и соседями.
     *
     * @param {string} slug
     * @param {number} seasonNumber
     * @returns {Promise<object|null>}
     */
    async season(slug, seasonNumber, { userId = null, today = null } = {}) {
      const series = await visibleSeries(pool, slug);
      if (!series) return null;

      const season = await pool.query(
        'SELECT id, number, title_ru FROM e_season WHERE series_id = $1 AND number = $2',
        [series.id, seasonNumber],
      );
      if (!season.rows.length) return null;

      const episodes = await episodesOf(pool, season.rows[0].id, { userId, today });
      const siblings = await seasonNumbersOf(pool, series.id);

      return {
        series: {
          slug: series.slug,
          title: series.title,
          titleOriginal: series.title_original,
        },
        season: {
          id: season.rows[0].id,
          number: season.rows[0].number,
          title: season.rows[0].title_ru || '',
          episodes,
          // Группа «все серии вышли» появляется только когда выходы совпали:
          // восемь серий одной датой — это премьера сезона, а не восемь разных
          // дат (приёмка F-02-02 §8).
          allOutOn: sameDay(episodes),
        },
        prevSeason: siblings.includes(seasonNumber - 1) ? seasonNumber - 1 : null,
        nextSeason: siblings.includes(seasonNumber + 1) ? seasonNumber + 1 : null,
      };
    },

    /**
     * Серия со соседями по сезону.
     *
     * @param {string} slug
     * @param {number} seasonNumber
     * @param {number} episodeNumber
     * @returns {Promise<object|null>}
     */
    async episode(slug, seasonNumber, episodeNumber, options = {}) {
      const seasonPage = await this.season(slug, seasonNumber, options);
      if (!seasonPage) return null;

      const episode = seasonPage.season.episodes.find((item) => item.number === episodeNumber);
      if (!episode) return null;

      const numbers = seasonPage.season.episodes.map((item) => item.number);
      return {
        ...seasonPage,
        episode: {
          ...episode,
          hasDate: Boolean(episode.date),
          // H-35: тонкая страница (нет описания или дата в будущем) в индексе не
          // нужна. Здесь решается, индексировать ли страницу.
          thin: !episode.descriptionRu || !episode.date || episode.date > todayIso(),
        },
        prevEpisode: numbers.includes(episodeNumber - 1) ? episodeNumber - 1 : null,
        nextEpisode: numbers.includes(episodeNumber + 1) ? episodeNumber + 1 : null,
      };
    },

    /**
     * Серия по адресу — идентификаторы и дата выхода, без страницы.
     *
     * Нужна записи оценки серии (F-04-02): страница целиком строится ради
     * показа, а записи нужен только адрес строки и правило «сериал невиден —
     * оценивать нечего». Читать ради этого весь сезон с соседями значило бы
     * делать работу, которую никто не увидит.
     *
     * @param {string} slug
     * @param {number} seasonNumber
     * @param {number} episodeNumber
     * @param {{today?: string|null}} [options] сегодняшняя дата посетителя
     * @returns {Promise<{seriesId: number, episodeId: number, aired: boolean}|null>}
     */
    async episodeRef(slug, seasonNumber, episodeNumber, { today = null } = {}) {
      const series = await visibleSeries(pool, slug);
      if (!series) return null;

      const { rows } = await pool.query(
        `SELECT e.id AS episode_id,
                (SELECT rl.release_date::text
                   FROM e_release rl
                   JOIN e_release_episode rle ON rle.release_id = rl.id
                  WHERE rle.episode_id = e.id
                  ORDER BY rl.release_date
                  LIMIT 1) AS date
           FROM e_episode e
           JOIN e_season s ON s.id = e.season_id
          WHERE s.series_id = $1 AND s.number = $2 AND e.number = $3`,
        [series.id, seasonNumber, episodeNumber],
      );
      const row = rows[0];
      if (!row) return null;

      return {
        seriesId: series.id,
        episodeId: row.episode_id,
        aired: row.date !== null && (today === null || row.date <= today),
      };
    },
  };
}

/**
 * Сериал, видимый посетителю.
 *
 * Снятый с публикации не виден здесь же, а не в маршруте: отозванный контент
 * не должен уезжать из слоя данных вообще, даже по прямой ссылке на сезон или
 * серию. Иначе редактор снимает сериал с публикации, а его страницы продолжают
 * отдаваться — и тот, кто это сделал, уверен, что всё убрано (EC-T8, EC-C1).
 *
 * @returns {Promise<object|null>}
 */
async function visibleSeries(pool, slug) {
  const { rows } = await pool.query(
    `SELECT id, slug, title_ru, title_original, publication_state, archived_at
       FROM e_series WHERE slug = $1`,
    [slug],
  );
  const series = rows[0];
  if (!series || series.publication_state === 'imported') return null;
  if (series.archived_at) return null;
  return series;
}

/**
 * Серии сезона с описанием, датой, длительностью и отметкой зрителя.
 *
 * Описание серии — это и есть её содержимое, поэтому оно берётся целиком и
 * решается на странице, а не здесь: правило скрытия (H-37) живёт в представлении.
 *
 * «Вышла» считается по дате в поясе зрителя: без этого флажок был бы доступен
 * накануне премьеры, а чужой пояс сдвинул бы его на сутки (OP-08а).
 */
async function episodesOf(pool, seasonId, { userId = null, today = null } = {}) {
  const { rows } = await pool.query(
    `SELECT e.id, e.number,
            coalesce(e.title_ru, e.title_en) AS title,
            coalesce(e.description_ru, e.description_en) AS description,
            e.runtime_min,
            r.release_date::text AS date,
            (SELECT m.precision FROM e_watch_mark m
              WHERE m.user_id = $3 AND m.episode_id = e.id) AS mark_precision
       FROM e_episode e
       LEFT JOIN LATERAL (
         SELECT rl.release_date
           FROM e_release rl
           JOIN e_release_episode rle ON rle.release_id = rl.id
          WHERE rle.episode_id = e.id
          ORDER BY rl.release_date
          LIMIT 1
       ) r ON true
      WHERE e.season_id = $1
      ORDER BY e.number
      LIMIT $2`,
    [seasonId, EPISODES_LIMIT, userId],
  );

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title || '',
    description: row.description || '',
    descriptionRu: row.description,
    runtime: row.runtime_min,
    date: row.date,
    marked: row.mark_precision !== null,
    precision: row.mark_precision,
    aired: row.date !== null && (today === null || row.date <= today),
  }));
}

async function seasonNumbersOf(pool, seriesId) {
  const { rows } = await pool.query(
    'SELECT number FROM e_season WHERE series_id = $1 AND number > 0 ORDER BY number',
    [seriesId],
  );
  return rows.map((row) => row.number);
}

/**
 * Дата, в которую вышли все серии сезона.
 *
 * @param {object[]} episodes
 * @returns {string|null} дата или `null`, если выходы разные или их нет
 */
function sameDay(episodes) {
  const dated = episodes.filter((episode) => episode.date);
  if (!dated.length || dated.length !== episodes.length) return null;
  const [first] = dated;
  return dated.every((episode) => episode.date === first.date) ? first.date : null;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}