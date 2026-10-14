// Отбор кандидатов в каталог из датасетов IMDb (F-12-01).
//
// Файл `title.basics.tsv.gz` весит 218 МБ в сжатом виде и около гигабайта
// в разжатом, поэтому он читается потоком, а в памяти остаётся только то,
// что пережило отсев: накопитель, который при переполнении обрезается до
// `import.top_n` позиций. Правило простое — сортируем по числу голосов и
// сверху оставляем тысячу; держать в памяти все 12,8 миллиона строк ради
// того, чтобы выбросить всё, кроме тысячи, незачем.
//
// Что действительно занимает память — карта рейтингов: в `title.ratings`
// около полутора миллионов строк, и без неё отбирать нечем, ведь популярность
// измеряется голосами, а они лежат во втором файле. На замере 14.10.2026
// полный отбор (12,8 млн строк базового файла) укладывался в 716 МБ
// при пределе кучи около 4 ГБ. Если каталог дойдёт до миллиона позиций,
// порядок чтения придётся поменять: сначала отфильтровать базовый файл до
// претендентов (~280 тысяч), а потом читать рейтинги, оставляя из них только
// эти.
//
// Источники:
//   M12 F-12-01 §3–§5, §8, §9, §10 (EC-I1, EC-I2)
//   M12 §0 — настройки import.*
//   DEC-022 — две проекции списка исключаемых жанров
//   EC-K2 — сериал без жанров не публикуется

import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';

/**
 * Заголовки датасетов IMDb.
 *
 * Сверяются побайтно, а не по числу колонок: при добавлении новой колонки
 * IMDb прежний код продолжил бы читать файл и молча сдвинул бы всё вправо —
 * отзывы и даты выхода приехали бы из чужих полей. §5 требует останавливать
 * прогон при изменении схемы, и это тот случай, где остановка дешевле.
 */
export const BASICS_HEADER = [
  'tconst',
  'titleType',
  'primaryTitle',
  'originalTitle',
  'isAdult',
  'startYear',
  'endYear',
  'runtimeMinutes',
  'genres',
];

export const RATINGS_HEADER = ['tconst', 'averageRating', 'numVotes'];

/** Что считаем сериалом (§3). */
const SERIES_TYPES = new Set(['tvSeries', 'tvMiniSeries']);

/** `\N` в IMDb означает «значения нет» (§7). */
const NOTHING = '\\N';

/** Сколько строк держим перед повторной обрезкой до top_n. */
const TRIM_FACTOR = 4;

/**
 * Разбирает строку `title.basics`.
 *
 * @param {string} line строка без перевода строки
 * @returns {{tconst:string, titleType:string, primaryTitle:string, originalTitle:string,
 *   isAdult:boolean, startYear:number|null, endYear:number|null, genres:string[]}|null}
 *   `null` — строка не наша: разбор не должен ронять прогон из-за одной
 *   испорченной записи среди тринадцати миллионов (§5).
 */
export function parseBasicsLine(line) {
  const cells = line.split('\t');
  if (cells.length !== BASICS_HEADER.length) return null;
  const [tconst, titleType, primaryTitle, originalTitle, isAdult, startYear, endYear, , genres] = cells;
  // Идентификатор и тип обязательны: без них строка не адресуема, а пустой
  // tconst в выборку попадёт как настоящий сериал.
  if (!tconst || tconst === NOTHING || !titleType) return null;
  return {
    tconst,
    titleType,
    primaryTitle,
    originalTitle,
    isAdult: isAdult === '1',
    startYear: startYear === NOTHING ? null : Number(startYear),
    endYear: endYear === NOTHING ? null : Number(endYear),
    genres: genres === NOTHING || genres === '' ? [] : genres.split(','),
  };
}

/**
 * Разбирает строку `title.ratings`.
 *
 * @param {string} line строка без перевода строки
 * @returns {{tconst:string, averageRating:number, numVotes:number}|null}
 */
export function parseRatingsLine(line) {
  const cells = line.split('\t');
  if (cells.length !== RATINGS_HEADER.length) return null;
  const [tconst, averageRating, numVotes] = cells;
  if (!tconst || tconst === NOTHING) return null;
  const votes = Number(numVotes);
  if (!Number.isFinite(votes)) return null;
  return { tconst, averageRating: Number(averageRating), numVotes: votes };
}

/**
 * Отсеивает ли сериал исключённые жанры.
 *
 * Отсеивает только когда запрещены **все** его жанры: таков настоящий смысл
 * «это не сериал» (DEC-022), и именно это сказано в EC-I2. Буквальное
 * прочтение §3 («оставить без жанров из списка») выбросило бы «Arcane»
 * (`Animation, Action & Adventure, Sci-Fi`) вместе с остальными анимационными
 * сериалами — расхождение записано в IMPROVEMENTS.
 *
 * Сериал без жанров тоже отсеивается: публиковать его нельзя (EC-K2), а
 * держать в каталоге позицию, которая никогда не откроется, незачем.
 *
 * @param {{genres:string[]}} row
 * @param {string[]} excluded
 * @returns {boolean}
 */
export function isExcludedByGenre(row, excluded) {
  if (!row.genres.length) return true;
  return row.genres.every((genre) => excluded.includes(genre));
}

/**
 * Порядок каталога: больше голосов — выше, при равенстве по `tconst`.
 *
 * Второй ключ нужен не для красоты: без него две позиции с одинаковым числом
 * голосов могли бы поменяться местами между прогонами, и один и тот же
 * сериал то входил бы в тысячу, то выпадал из неё (EC-D7) без всяких причин.
 *
 * @param {{numVotes:number, tconst:string}} a
 * @param {{numVotes:number, tconst:string}} b
 * @returns {number}
 */
export function compareByPopularity(a, b) {
  if (a.numVotes !== b.numVotes) return b.numVotes - a.numVotes;
  return a.tconst < b.tconst ? -1 : a.tconst > b.tconst ? 1 : 0;
}

/**
 * Сортирует и отсекает до `top_n`, расставляя ранг с единицы.
 *
 * Позиции без числа голосов отбрасываются здесь же, а не на входе: сортировка
 * по неизвестной величине — это не «популярность», а произвольный порядок, и
 * такой сериал в каталог попал бы тем же шансом, что и лидер.
 *
 * @param {object[]} rows позиции с полем `numVotes`
 * @param {number} topN
 * @returns {{items: object[], dropped: number}}
 */
export function selectCandidates(rows, topN) {
  const ranked = rows.filter((row) => Number.isFinite(row.numVotes));
  const sorted = ranked.sort(compareByPopularity);
  const items = sorted.slice(0, topN).map((row, index) => ({ ...row, rank: index + 1 }));
  return { items, dropped: Math.max(0, sorted.length - items.length) };
}

/**
 * Читает сжатый TSV потоком, проверяя заголовок.
 *
 * Файл не грузится в память целиком: `createGunzip` отдаёт куски, `readline`
 * нарезает их на строки. 218 МБ сжатого — примерно 1 МБ в памяти.
 *
 * @param {object} options
 * @param {string} options.path путь к `.tsv.gz`
 * @param {string[]} options.header ожидаемый заголовок
 * @param {(line:string) => object|null} options.parseLine
 * @param {(row:object) => void} [options.onRow] вызывается для каждой разобранной строки
 * @returns {Promise<{lines:number, rows:number, skipped:number}>}
 * @throws {Error} «схема изменилась», если заголовок не тот
 */
export async function readDataset({ path, header, parseLine, onRow = () => {} }) {
  const input = fs.createReadStream(path);
  // Повреждённый архив рвёт поток с кодом Z_DATA_ERROR, а не «неизвестной
  // ошибкой»: так это и видно в отчёте запуска (§5).
  const gunzip = zlib.createGunzip();
  input.pipe(gunzip);

  const lines = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
  let expected = true;
  let stats = { lines: 0, rows: 0, skipped: 0 };

  try {
    for await (const line of lines) {
      if (line === '') continue;
      if (expected) {
        const got = line.split('\t');
        if (got.length !== header.length || got.some((name, i) => name !== header[i])) {
          throw new Error(`схема изменилась: в файле «${path}» ожидался заголовок «${header.join('\t')}», а пришёл «${line}»`);
        }
        expected = false;
        continue;
      }
      stats.lines += 1;
      const row = parseLine(line);
      if (!row) {
        stats.skipped += 1;
        continue;
      }
      stats.rows += 1;
      onRow(row);
    }
  } finally {
    lines.close();
    input.destroy();
    gunzip.destroy();
  }

  return stats;
}

/**
 * Отбор кандидатов из двух файлов датасетов.
 *
 * Порядок чтения выбран по размеру: рейтинги (8 МБ) читаются первыми и
 * складываются в карту, а по базовому файлу идёт поток. Всё, что пережило
 * отсев, попадает в накопитель, который при переполнении обрезается до
 * `top_n` — иначе в памяти снова оказался бы весь датасет.
 *
 * @param {object} options
 * @param {string} options.basicsPath
 * @param {string} options.ratingsPath
 * @param {number} options.topN
 * @param {string[]} options.excludedGenres
 * @returns {Promise<{items: object[], counters: object, stats: object}>}
 */
export async function selectFromDatasets({ basicsPath, ratingsPath, topN, excludedGenres }) {
  const ratings = new Map();
  const ratingsStats = await readDataset({
    path: ratingsPath,
    header: RATINGS_HEADER,
    parseLine: parseRatingsLine,
    onRow: (row) => ratings.set(row.tconst, row),
  });

  const counters = {
    lines: 0,
    wrongType: 0,
    adult: 0,
    excludedGenre: 0,
    noGenres: 0,
    noRating: 0,
    kept: 0,
  };

  let pool = [];
  let basicsStats = { lines: 0, rows: 0, skipped: 0 };

  basicsStats = await readDataset({
    path: basicsPath,
    header: BASICS_HEADER,
    parseLine: parseBasicsLine,
    onRow: (row) => {
      counters.lines += 1;
      if (!SERIES_TYPES.has(row.titleType)) {
        counters.wrongType += 1;
        return;
      }
      if (row.isAdult) {
        counters.adult += 1;
        return;
      }
      if (!row.genres.length) {
        counters.noGenres += 1;
        return;
      }
      if (isExcludedByGenre(row, excludedGenres)) {
        counters.excludedGenre += 1;
        return;
      }
      const rating = ratings.get(row.tconst);
      if (!rating) {
        counters.noRating += 1;
        return;
      }
      pool.push({
        tconst: row.tconst,
        titleType: row.titleType,
        title: row.primaryTitle,
        originalTitle: row.originalTitle,
        startYear: row.startYear,
        endYear: row.endYear,
        genres: row.genres,
        averageRating: rating.averageRating,
        numVotes: rating.numVotes,
      });
      counters.kept += 1;
      if (pool.length > topN * TRIM_FACTOR) {
        pool = selectCandidates(pool, topN).items.map(({ rank, ...rest }) => rest);
      }
    },
  });

  const { items } = selectCandidates(pool, topN);
  return { items, counters, stats: { basics: basicsStats, ratings: ratingsStats } };
}