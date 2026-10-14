// Люди сериала из датасетов IMDb: режиссёры, создатели и «В ролях» (F-12-03 §4(3)).
//
// Три файла: `title.crew` (режиссёры и авторы), `title.principals` (актёры с
// ролями), `name.basics` (имена). Последний весит почти 300 МБ, а нужные
// имена — около десятка тысяч строк, поэтому файлы читаются потоком и
// фильтруются на ходу. Полная загрузка в память означала бы 13 миллионов
// строк ради тех же десяти тысяч.

import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';

/** Сколько актёров берём на сериал (F-12-03 §4(3), §9). */
export const MAX_CAST = 10;

/** Категории `title.principals`, которые считаются актёрами. */
export const CAST_CATEGORIES = new Set(['actor', 'actress', 'self']);

const CREW_HEADER = ['tconst', 'directors', 'writers'];
const PRINCIPALS_HEADER = ['tconst', 'ordering', 'nconst', 'category', 'job', 'characters'];
// `deathYear` в заголовке есть, а в разбор не попадает: `e_person` держит
// только год рождения, и выдумывать вторую колонку ради симметрии незачем.
// Но в проверке заголовка колонка остаётся — пропущенная колонка сдвинула бы
// все индексы вправо незаметно.
const NAME_HEADER = ['nconst', 'primaryName', 'birthYear', 'deathYear', 'primaryProfession', 'knownForTitles'];

/**
 * Разбирает строку `title.crew`.
 *
 * @param {string} line
 * @returns {{tconst:string, directors:string[]}|null}
 */
export function parseCrewLine(line) {
  const cells = line.split('\t');
  if (cells.length !== CREW_HEADER.length) return null;
  const [tconst, directors] = cells;
  if (!tconst || tconst === '\\N') return null;
  return { tconst, directors: directors === '\\N' ? [] : directors.split(',') };
}

/**
 * Разбирает строку `title.principals`.
 *
 * @param {string} line
 * @returns {{tconst:string, ordering:number, nconst:string, category:string, characters:string[]}|null}
 */
export function parsePrincipalsLine(line) {
  const cells = line.split('\t');
  if (cells.length !== PRINCIPALS_HEADER.length) return null;
  const [tconst, ordering, nconst, category, , characters] = cells;
  if (!tconst || !nconst || nconst === '\\N') return null;
  let roles = [];
  if (characters && characters !== '\\N') {
    try {
      const parsed = JSON.parse(characters);
      if (Array.isArray(parsed)) roles = parsed.filter((role) => typeof role === 'string');
    } catch {
      // Роли — справочная часть карточки. Не разобрались — значит их нет,
      // а прогон вставать из-за одной строки не должен.
      roles = [];
    }
  }
  return { tconst, ordering: Number(ordering), nconst, category, characters: roles };
}

/**
 * Разбирает строку `name.basics`.
 *
 * @param {string} line
 * @returns {{nconst:string, name:string, birthYear:number|null}|null}
 */
export function parseNameLine(line) {
  const cells = line.split('\t');
  if (cells.length !== NAME_HEADER.length) return null;
  const [nconst, primaryName, birthYear] = cells;
  if (!nconst || !primaryName || nconst === '\\N') return null;
  return { nconst, name: primaryName, birthYear: birthYear === '\\N' ? null : Number(birthYear) };
}

/** Поток строк из сжатого TSV с проверкой заголовка. */
async function* rows(path, header, parseLine) {
  const input = fs.createReadStream(path);
  const gunzip = zlib.createGunzip();
  input.pipe(gunzip);
  const lines = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
  let expected = true;
  try {
    for await (const line of lines) {
      if (line === '') continue;
      if (expected) {
        const got = line.split('\t');
        if (got.length !== header.length || got.some((name, i) => name !== header[i])) {
          throw new Error(`схема изменилась: в «${path}» ожидался заголовок «${header.join('\t')}»`);
        }
        expected = false;
        continue;
      }
      const row = parseLine(line);
      if (row) yield row;
    }
  } finally {
    lines.close();
    input.destroy();
    gunzip.destroy();
  }
}

/**
 * Собирает режиссёров и актёров для набора сериалов.
 *
 * @param {object} options
 * @param {Set<string>|string[]} options.tconsts какие сериалы разбираем
 * @param {string} options.dataDir каталог с датасетами IMDb
 * @param {number} [options.maxCast]
 * @returns {Promise<Map<string, {directors: object[], cast: object[]}>>}
 */
export async function collectPeople({ tconsts, dataDir, maxCast = MAX_CAST }) {
  const wanted = new Set(tconsts);
  const people = new Map();
  const slot = (tconst) => {
    if (!people.has(tconst)) people.set(tconst, { directors: [], cast: [] });
    return people.get(tconst);
  };

  // Режиссёры. Если режиссёра нет, в каталоге он будет пуст — создателей
  // дописывает F-12-06 из `created_by` TMDB, а выдумывать тут нечего.
  for await (const row of rows(`${dataDir}/title.crew.tsv.gz`, CREW_HEADER, parseCrewLine)) {
    if (!wanted.has(row.tconst) || !row.directors.length) continue;
    slot(row.tconst).directors = row.directors.map((nconst) => ({ nconst, name: null }));
  }

  // Актёры: порядок в файле и есть порядок в карточке, лишние отбрасываем.
  const wantedNames = new Set();
  for (const entry of people.values()) {
    for (const person of entry.directors) wantedNames.add(person.nconst);
  }
  for await (const row of rows(`${dataDir}/title.principals.tsv.gz`, PRINCIPALS_HEADER, parsePrincipalsLine)) {
    if (!wanted.has(row.tconst) || !CAST_CATEGORIES.has(row.category)) continue;
    const entry = slot(row.tconst);
    if (entry.cast.length >= maxCast) continue;
    entry.cast.push({ nconst: row.nconst, name: null, characters: row.characters, order: row.ordering });
    wantedNames.add(row.nconst);
  }

  // Имена одним проходом: `name.basics` — 297 МБ, а нужны десятки тысяч строк.
  const names = new Map();
  for await (const row of rows(`${dataDir}/name.basics.tsv.gz`, NAME_HEADER, parseNameLine)) {
    if (!wantedNames.has(row.nconst)) continue;
    names.set(row.nconst, row);
  }
  for (const entry of people.values()) {
    for (const person of [...entry.directors, ...entry.cast]) {
      const found = names.get(person.nconst);
      if (found) person.name = found.name;
    }
  }

  return people;
}