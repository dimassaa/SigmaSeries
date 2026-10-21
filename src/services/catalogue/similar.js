// Похожие сериалы (F-02-08).
//
// Сходство — по общим признакам с весом редкости признака (IDF): чем признак
// встречается реже, тем сильнее он говорит о сходстве. Признаки — жанры,
// ключевые слова, страна, десятилетие и общие люди (режиссёр или создатель).
//
// Значения считаются после импорта и лежат в базе: страница сериала читает
// готовые веса, а тяжёлый расчёт не идёт в веб-запрос (R-PERF-09).

/** Сколько сериалов показываем. */
export const SIMILAR_LIMIT = 6;

/**
 * Вес признака: редкий весит больше.
 *
 * `log(N / df)` — классический IDF: у признака, который есть у всех, вес
 * нулевой, и он ничего не различает.
 *
 * @param {{documents: number, frequency: number}} input
 * @returns {number}
 */
export function idfWeight({ documents, frequency }) {
  if (!documents || !frequency) return 0;
  const weight = Math.log(documents / frequency);
  return weight > 0 ? weight : 0;
}

/**
 * Пары «сериал → похожий» с весами.
 *
 * Считается по перевёрнутому индексу: у каждого признака — список сериалов,
 * где он есть, и один проход по признакам сериала копит вес у всех, кто этот
 * признак разделяет. Одинаковые весы разбиваются голосами IMDb: больше
 * голосов — сериал известнее, и при равенстве он и ближе.
 *
 * @param {object} input
 * @param {Map<number, Set<string>>} input.features признаки по сериалам
 * @param {Map<number, number>} [input.votes] голоса IMDb по сериалам
 * @param {number} [input.limit] сколько пар на сериал
 * @returns {Map<number, Array<{similarId: number, weight: number}>>}
 */
export function similarityPairs({ features, votes = new Map(), limit = SIMILAR_LIMIT }) {
  // Перевёрнутый индекс: признак → сериалы, где он есть.
  const postings = new Map();
  for (const [seriesId, list] of features) {
    for (const feature of list) {
      if (!postings.has(feature)) postings.set(feature, []);
      postings.get(feature).push(seriesId);
    }
  }

  const documents = features.size;
  const pairs = new Map();

  for (const [seriesId, list] of features) {
    const weights = new Map();
    for (const feature of list) {
      const posting = postings.get(feature) ?? [];
      const weight = idfWeight({ documents, frequency: posting.length });
      if (!weight) continue;
      for (const other of posting) {
        if (other === seriesId) continue;
        weights.set(other, (weights.get(other) ?? 0) + weight);
      }
    }
    if (!weights.size) continue;

    const ranked = [...weights.entries()]
      .map(([similarId, weight]) => ({ similarId, weight }))
      .sort((a, b) => (
        b.weight - a.weight
        || (votes.get(b.similarId) ?? 0) - (votes.get(a.similarId) ?? 0)
        || a.similarId - b.similarId
      ))
      .slice(0, limit);
    pairs.set(seriesId, ranked);
  }

  return pairs;
}

/**
 * Источник данных «похожих».
 *
 * @param {import('pg').Pool} pool
 * @returns {object}
 */
export function pgSimilar(pool) {
  /**
   * Признаки опубликованных сериалов.
   *
   * Архивные и неопубликованные в выдачу не попадают: показывать «похожие»
   * на то, чего читатель не увидит, незачем.
   *
   * @returns {Promise<{features: Map<number, Set<string>>, votes: Map<number, number>}>}
   */
  async function features() {
    const { rows } = await pool.query(
      `SELECT s.id, s.year_start,
              (SELECT array_agg(g.genre_code) FROM e_series_genre g WHERE g.series_id = s.id) AS genres,
              (SELECT array_agg(k.keyword_id::text) FROM e_series_keyword k WHERE k.series_id = s.id) AS keywords,
              (SELECT array_agg(c.country_code) FROM e_series_country c WHERE c.series_id = s.id) AS countries,
              (SELECT array_agg(sp.person_id::text) FROM e_series_person sp
                WHERE sp.series_id = s.id AND sp.role IN ('director','creator')) AS people,
              (SELECT er.votes FROM e_external_rating er
                WHERE er.series_id = s.id AND er.platform = 'imdb') AS imdb_votes
         FROM e_series s
        WHERE s.publication_state = 'published' AND s.archived_at IS NULL`,
    );

    const map = new Map();
    const votes = new Map();
    for (const row of rows) {
      const list = new Set();
      for (const genre of row.genres ?? []) list.add(`genre:${genre}`);
      for (const keyword of row.keywords ?? []) list.add(`keyword:${keyword}`);
      for (const country of row.countries ?? []) list.add(`country:${country}`);
      for (const person of row.people ?? []) list.add(`person:${person}`);
      if (row.year_start !== null) list.add(`decade:${Math.floor(row.year_start / 10)}`);
      if (list.size) map.set(Number(row.id), list);
      if (row.imdb_votes !== null) votes.set(Number(row.id), Number(row.imdb_votes));
    }
    return { features: map, votes };
  }

  /**
   * Пересчитать и сохранить пары.
   *
   * Старые пары удаляются целиком: сериал, потерявший признаки, больше не
   * похож ни на кого, и его прежняя строка в выдаче была бы враньём.
   *
   * @param {{limit?: number}} [options]
   * @returns {Promise<{series: number, pairs: number}>}
   */
  async function recompute({ limit = SIMILAR_LIMIT } = {}) {
    const { features: map, votes } = await features();
    const pairs = similarityPairs({ features: map, votes, limit });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM e_series_similar');
      for (const [seriesId, list] of pairs) {
        for (const pair of list) {
          await client.query(
            `INSERT INTO e_series_similar (series_id, similar_id, weight)
             VALUES ($1, $2, $3)`,
            [seriesId, pair.similarId, pair.weight.toFixed(4)],
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return { series: pairs.size, pairs: [...pairs.values()].reduce((sum, list) => sum + list.length, 0) };
  }

  /**
   * Похожие сериалы для одного сериала.
   *
   * @param {number} seriesId
   * @param {{limit?: number}} [options]
   * @returns {Promise<object[]>}
   */
  async function forSeries(seriesId, { limit = SIMILAR_LIMIT } = {}) {
    const { rows } = await pool.query(
      `SELECT s.id, s.slug, s.title_ru, s.title_original, s.year_start, s.exit_state,
              sm.weight,
              (SELECT iv.width FROM e_image i
                 JOIN e_image_variant iv ON iv.image_id = i.id
                WHERE i.series_id = s.id AND i.role = 'poster'
                ORDER BY iv.width LIMIT 1) AS poster_width
         FROM e_series_similar sm
         JOIN e_series s ON s.id = sm.similar_id
        WHERE sm.series_id = $1
          AND s.publication_state = 'published' AND s.archived_at IS NULL
        ORDER BY sm.weight DESC, s.id
        LIMIT $2`,
      [seriesId, limit],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      slug: row.slug,
      title: row.title_ru || row.title_original,
      yearStart: row.year_start,
      exitState: row.exit_state,
      posterWidth: row.poster_width ? Number(row.poster_width) : null,
      weight: Number(row.weight),
    }));
  }

  return { features, recompute, forSeries };
}
