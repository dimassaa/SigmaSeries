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
    async season(slug, seasonNumber) {
      const series = await visibleSeries(pool, slug);
      if (!series) return null;

      const season = await pool.query(
        'SELECT id, number, title_ru FROM e_season WHERE series_id = $1 AND number = $2',
        [series.id, seasonNumber],
      );
      if (!season.rows.length) return null;

      const episodes = await episodesOf(pool, season.rows[0].id);
      const siblings = await seasonNumbersOf(pool, series.id);

      return {
        series: {
          slug: series.slug,
          title: series.title,
          titleOriginal: series.title_original,
        },
        season: {
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
    async episode(slug, seasonNumber, episodeNumber) {
      const seasonPage = await this.season(slug, seasonNumber);
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
  };
}

/**
 * Сериал, видимый посетителю.
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
  return series;
}

/**
 * Серии сезона с описанием, датой и длительностью.
 *
 * Описание серии — это и есть её содержимое, поэтому оно берётся целиком и
 * решается на странице, а не здесь: правило скрытия (H-37) живёт в представлении.
 */
async function episodesOf(pool, seasonId) {
  const { rows } = await pool.query(
    `SELECT e.number,
            coalesce(e.title_ru, e.title_en) AS title,
            coalesce(e.description_ru, e.description_en) AS description,
            e.runtime_min,
            r.release_date::text AS date
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
    [seasonId, EPISODES_LIMIT],
  );

  return rows.map((row) => ({
    number: row.number,
    title: row.title || '',
    description: row.description || '',
    descriptionRu: row.description,
    runtime: row.runtime_min,
    date: row.date,
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