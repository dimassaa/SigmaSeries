// Обновление рейтингов IMDb по каталогу (F-12-07 §4, задача `ratings_sync`).
//
// Зачем отдельная задача: `title.ratings` меняется каждую неделю, а голосов в
// нём десятки миллионов. Обход всего файла ради тысячи строк каталога дешевле,
// чем тысяча запросов к API, и не тратит лимит ключа.
//
// Что здесь важно и неочевидно:
//
//   • Строка без пары в каталоге ничего не создаёт. Рейтинги не заводят
//     сериалы — это дело отбора (F-12-01): иначе один только файл рейтингов,
//     где лежат все фильмы IMDb, раздул бы каталог до миллионов записей.
//   • `measured_on` — сегодняшняя дата, а не дата файла: «когда мы это узнали»
//     отличается от «когда IMDb обновил числа», и на карточке показано первое.
//   • Оценка и голоса пишутся только в строку `platform = 'imdb'`: рейтинг
//     TMDB обновляет ночной прогон расписания, и перезапись здесь его стёрла бы.

import { RATINGS_HEADER, parseRatingsLine, readDataset } from './imdb.js';

/** Сколько строк обновляем одной командой. */
const CHUNK = 500;

/**
 * Обновляет рейтинг и число голосов IMDb для сериалов каталога.
 *
 * @param {object} options
 * @param {object} options.pool
 * @param {string} options.path файл `title.ratings.tsv.gz`
 * @param {Date} [options.now]
 * @returns {Promise<{inCatalogue: number, matched: number, updated: number}>}
 * @throws {Error} файла нет или его схема изменилась
 */
export async function refreshRatings({ pool, path, now = new Date() }) {
  const { rows } = await pool.query(
    'SELECT id, imdb_key FROM e_series WHERE imdb_key IS NOT NULL',
  );
  const byKey = new Map(rows.map((row) => [row.imdb_key, row.id]));

  const matched = [];
  await readDataset({
    path,
    header: RATINGS_HEADER,
    parseLine: parseRatingsLine,
    onRow: (row) => {
      const seriesId = byKey.get(row.tconst);
      if (seriesId) matched.push({ seriesId, ...row });
    },
  });

  const measuredOn = now.toISOString().slice(0, 10);
  let updated = 0;
  for (let from = 0; from < matched.length; from += CHUNK) {
    const chunk = matched.slice(from, from + CHUNK);
    const { rowCount } = await pool.query(
      `INSERT INTO e_external_rating (series_id, platform, value, votes, measured_on)
       SELECT t.series_id, 'imdb', t.value, t.votes, $4::date
         FROM unnest($1::bigint[], $2::numeric[], $3::int[]) AS t(series_id, value, votes)
       ON CONFLICT (series_id, platform) DO UPDATE SET
         value = EXCLUDED.value, votes = EXCLUDED.votes, measured_on = EXCLUDED.measured_on`,
      [
        chunk.map((row) => row.seriesId),
        chunk.map((row) => row.averageRating),
        chunk.map((row) => row.numVotes),
        measuredOn,
      ],
    );
    updated += rowCount;
  }

  return { inCatalogue: byKey.size, matched: matched.length, updated };
}
