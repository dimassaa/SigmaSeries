// Дозагрузка стран и сетей сериалам, у которых их нет (F-12-03 §4(4)).
//
// При первом импорте эти поля не собирались, и переписывать весь каталог ради
// двух связей — это тысячи запросов к TMDB плюс полный пересчёт полноты,
// состояния выхода и сезонов. Здесь обходится ровно то, чего не хватает.
//
// Каждый сериал — своя транзакция: сбой одного не обрывает дозагрузку
// (F-12-06 §5).

import { writeOriginsForSeries } from './write.js';
import { isKeyRejected } from './tmdb.js';

/**
 * Проставляет страны и сети сериалам, у которых их нет.
 *
 * @param {object} deps
 * @param {object} deps.pool
 * @param {object} deps.tmdb
 * @param {number} [deps.limit] сколько сериалов за раз; `Infinity` — все
 * @param {string|null} [deps.tconst] один сериал по ключу IMDb
 * @param {(line: string) => void} [deps.log]
 * @param {() => void} [deps.onProgress]
 * @returns {Promise<{scanned: number, filled: number, withoutCountry: number, errors: number}>}
 */
export async function fillOrigins({
  pool, tmdb, limit = Infinity, tconst = null, log = () => {}, onProgress = () => {},
}) {
  // Параметры подставляются по факту: `$1` без использования PostgreSQL
  // не считает — «не удалось определить тип параметра».
  const bounded = Number.isFinite(limit);
  const { rows } = await pool.query(
    `SELECT s.id, s.tmdb_id
       FROM e_series s
      WHERE s.tmdb_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM e_series_country sc WHERE sc.series_id = s.id)
        AND ($${bounded ? 2 : 1}::text IS NULL OR s.imdb_key = $${bounded ? 2 : 1})
      ORDER BY s.id
      LIMIT ${bounded ? '$1' : 'ALL'}`,
    bounded ? [limit, tconst] : [tconst],
  );

  let filled = 0;
  let withoutCountry = 0;
  let errors = 0;

  for (const [index, row] of rows.entries()) {
    let card;
    try {
      card = await tmdb.getDetailsLocalized(row.tmdb_id, 'ru-RU');
    } catch (error) {
      errors += 1;
      // Ключ истёк или сеть легла: останавливаемся, а не тратим остальные
      // попытки на заведомо бесполезные запросы (F-12-09 §3).
      if (isKeyRejected(error)) {
        log(`[страны] ключ TMDB отвергнут: ${error.message}`);
        break;
      }
      log(`[страны] ${row.tmdb_id}: ${error.message}`);
      continue;
    }

    const countries = (card?.origin_country ?? []).map((code) => String(code).toUpperCase());
    if (!countries.length) withoutCountry += 1;

    try {
      await writeOriginsForSeries({
        pool,
        seriesId: row.id,
        countries,
        networks: (card?.networks ?? [])
          .filter((network) => Number.isInteger(network?.id) && network?.name)
          .map((network) => ({
            id: network.id,
            name: String(network.name),
            countryCode: network.origin_country ? String(network.origin_country).toUpperCase() : null,
          })),
      });
      filled += 1;
    } catch (error) {
      errors += 1;
      log(`[страны] запись ${row.id}: ${error.message}`);
    }

    onProgress(index + 1, rows.length);
  }

  return { scanned: rows.length, filled, withoutCountry, errors };
}

export function parseArgs(argv) {
  const args = { limit: Infinity, tconst: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1]);
    if (argv[i] === '--tconst') args.tconst = String(argv[i + 1] ?? '');
    if (argv[i] === '--all') args.limit = Infinity;
  }
  if (args.tconst !== null && !/^tt\d{5,}$/.test(args.tconst)) {
    throw new Error(`--tconst должен быть идентификатором IMDb вида tt1234567, получено «${args.tconst}»`);
  }
  // Без `--all` число ограничивается по умолчанию: случайно без спроса обойти
  // весь каталог и потратить тысячу запросов не должен никто.
  if (args.limit !== Infinity && (!Number.isInteger(args.limit) || args.limit <= 0)) {
    throw new Error(`--limit должен быть положительным числом, получено «${args.limit}»`);
  }
  return { limit: args.limit, tconst: args.tconst };
}
