// F-12-01 «Отбор кандидатов из датасетов IMDb». Тесты.
// Спецификация: docs/01-product/features/M12-import.md, §3–§5, §8, §10, §18.
//
// Тесты идут на маленьких файлах, собранных на лету: настоящий title.basics
// весит 218 МБ, и проверять на нём было бы медленно и дорого, а разбор
// строки ничего не меняется от размера файла.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  BASICS_HEADER,
  RATINGS_HEADER,
  parseBasicsLine,
  parseRatingsLine,
  isExcludedByGenre,
  selectCandidates,
  readDataset,
  selectFromDatasets,
} from '../src/services/import/imdb.js';
import { IMPORT_SETTINGS, EXCLUDED_GENRES_IMDB } from '../src/config/settings.js';

// ─── Справка ──────────────────────────────────────────────────────────────────

/** Строка title.basics в порядке заголовка. */
const basicsRow = (tconst, type, title, adult = '0', start = '2008', end = '\\N', genres = 'Drama,Crime') =>
  [tconst, type, title, title, adult, start, end, '47', genres].join('\t');

const basicsFile = (rows) =>
  [BASICS_HEADER.join('\t'), ...rows].join('\n') + '\n';

const ratingsFile = (rows) =>
  [RATINGS_HEADER.join('\t'), ...rows].join('\n') + '\n';

/** Кладёт сжатый TSV во временный каталог и возвращает путь. */
function writeGz(dir, name, text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(text, 'utf8')));
  return file;
}

/** И наоборот: прочитать сжатый файл строкой. */
const readGz = (file) => zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'imdb-sel-'));

// ─── §8. Что попадает в каталог ───────────────────────────────────────────────

test('в отбор попадают только сериалы и мини-сериалы', () => {
  const row = parseBasicsLine(basicsRow('tt0903747', 'tvSeries', 'Breaking Bad'));
  assert.equal(isExcludedByGenre(row, ['Drama']), false);

  const episode = parseBasicsLine(basicsRow('tt1234', 'tvEpisode', 'Pilot'));
  assert.ok(episode, 'строка разбирается — её отбрасывает отбор, а не разбор');
});

test('год \\N читается как отсутствие, а не как строка', () => {
  const row = parseBasicsLine(basicsRow('tt1', 'tvSeries', 'X', '0', '\\N'));
  assert.equal(row.startYear, null);
  assert.equal(row.isAdult, false);
});

test('сериал без рейтинга не ранжируется — голосов нет', () => {
  const rows = [
    { tconst: 'tt1', numVotes: 10 },
    { tconst: 'tt2', numVotes: null },
  ];
  const { items } = selectCandidates(rows, 10);
  assert.deepEqual(items.map((i) => i.tconst), ['tt1']);
});

// ─── §8, DEC-022. Исключённые жанры ───────────────────────────────────────────

test('сериал, у которого все жанры исключены, не входит (EC-I2)', () => {
  assert.equal(isExcludedByGenre({ genres: ['Talk-Show'] }, EXCLUDED_GENRES_IMDB), true);
  assert.equal(isExcludedByGenre({ genres: ['Animation', 'Talk-Show'] }, EXCLUDED_GENRES_IMDB), true);
});

test('сериал со смешанными жанрами остаётся, даже если один жанр исключён', () => {
  // Arcane: Animation, Action & Adventure, Sci-Fi. По букве §3 он выпадал бы,
  // по EC-I2 («его жанр целиком из исключённых») — остаётся.
  assert.equal(isExcludedByGenre({ genres: ['Animation', 'Sci-Fi'] }, EXCLUDED_GENRES_IMDB), false);
});

test('сериал без жанров не входит: публиковать его нельзя (EC-K2)', () => {
  assert.equal(isExcludedByGenre({ genres: [] }, EXCLUDED_GENRES_IMDB), true);
});

// ─── §8. Порядок и отсечение ──────────────────────────────────────────────────

test('порядок по голосам убывающий, при равенстве — по tconst', () => {
  // Порядок на входе задан НАМЕРЕННО обратным ожидаемому: `sort` в Node
  // устойчив, и без второго ключа равные голоса сохранили бы входной порядок
  // (tt2 перед tt1). Тест с «правильным» входом проходил бы и при мёртвом
  // ключе — это проверялось мутацией.
  const rows = [
    { tconst: 'tt2', numVotes: 900 },
    { tconst: 'tt1', numVotes: 900 },
    { tconst: 'tt3', numVotes: 500 },
  ];
  const { items } = selectCandidates(rows, 10);
  assert.deepEqual(items.map((i) => i.tconst), ['tt1', 'tt2', 'tt3']);
});

test('берётся ровно import.top_n', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    tconst: `tt${String(i).padStart(7, '0')}`,
    numVotes: 1000 - i,
  }));
  const { items } = selectCandidates(rows, 10);
  assert.equal(items.length, 10);
  assert.equal(items[0].numVotes, 1000);
  assert.equal(items.at(-1).numVotes, 991);
  assert.equal(IMPORT_SETTINGS.topN, 1000);
});

// ─── §5. Разбор строки и заголовка ────────────────────────────────────────────

test('строка с чужим числом колонок пропускается и считается', () => {
  assert.equal(parseBasicsLine('tt1\ttvSeries\tShort\tLine'), null);
  assert.equal(parseRatingsLine('tt1\t8.5'), null);
});

test('заголовок совпадает с ожидаемым — иначе «схема изменилась»', async () => {
  const dir = tmpDir();
  const wrong = path.join(dir, 'wrong.tsv.gz');
  fs.writeFileSync(wrong, zlib.gzipSync(Buffer.from('a\tb\tc\n1\t2\t3\n', 'utf8')));
  await assert.rejects(
    () => readDataset({ path: wrong, header: BASICS_HEADER, parseLine: parseBasicsLine }),
    /схема изменилась/,
  );
});

test('неразобранные строки считаются, а не роняют прогон', async () => {
  const dir = tmpDir();
  const file = writeGz(dir, 'basics.tsv.gz', basicsFile([
    basicsRow('tt1', 'tvSeries', 'Good'),
    'мусор',
    basicsRow('tt2', 'tvSeries', 'Also good'),
  ]));
  const seen = [];
  const stats = await readDataset({
    path: file,
    header: BASICS_HEADER,
    parseLine: parseBasicsLine,
    onRow: (row) => seen.push(row.tconst),
  });
  assert.deepEqual(seen, ['tt1', 'tt2']);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.lines, 3);
});

// ─── §4. Отбор целиком ────────────────────────────────────────────────────────

test('отбор снимает взрослые, чужие типы и исключённые жанры, ранг сохраняется', async () => {
  const dir = tmpDir();
  const basics = writeGz(dir, 'title.basics.tsv.gz', basicsFile([
    basicsRow('tt0303', 'tvMiniSeries', 'Chernobyl', '0', '2019', '2019', 'Drama'),
    basicsRow('tt0944947', 'tvSeries', 'Game of Thrones', '0', '2011', '2019', 'Drama,Fantasy'),
    basicsRow('tt9999', 'tvSeries', 'Adult thing', '1', '2015', '\\N', 'Drama'),
    basicsRow('tt8888', 'tvSeries', 'A talk show', '0', '2015', '\\N', 'Talk-Show'),
    basicsRow('tt7777', 'tvEpisode', 'Pilot', '0', '2011', '2011', 'Drama'),
    basicsRow('tt6666', 'movie', 'Some movie', '0', '2011', '2011', 'Drama'),
  ]));
  const ratings = writeGz(dir, 'title.ratings.tsv.gz', ratingsFile([
    'tt0303\t9.3\t3000',
    'tt0944947\t8.9\t3000000',
    'tt9999\t7.0\t1000',
    'tt8888\t6.0\t500',
    'tt6666\t5.0\t9000',
  ]));

  const result = await selectFromDatasets({
    basicsPath: basics,
    ratingsPath: ratings,
    topN: IMPORT_SETTINGS.topN,
    excludedGenres: EXCLUDED_GENRES_IMDB,
  });

  assert.deepEqual(result.items.map((i) => i.tconst), ['tt0944947', 'tt0303']);
  assert.deepEqual(result.items.map((i) => i.rank), [1, 2]);
  assert.equal(result.items[0].averageRating, 8.9);
  assert.equal(result.counters.adult, 1);
  assert.equal(result.counters.wrongType, 2);
  assert.equal(result.counters.excludedGenre, 1);
  assert.equal(result.counters.noGenres, 0);
  assert.equal(result.counters.noRating, 0);
});

test('отбор не держит в памяти весь датасет: стримит и режет', async () => {
  // Много строк при маленьком top_n: если бы код копил всё, тест был бы
  // медленным на любой приличной машине. Здесь важно, что он проходит.
  const dir = tmpDir();
  const many = Array.from({ length: 20000 }, (_, i) =>
    basicsRow(`tt${String(i).padStart(7, '0')}`, 'tvSeries', `Series ${i}`, '0', '2020', '\\N', 'Drama'));
  const basics = writeGz(dir, 'b.tsv.gz', basicsFile(many));
  const ratings = writeGz(dir, 'r.tsv.gz', ratingsFile(
    many.map((_, i) => `tt${String(i).padStart(7, '0')}\t7.0\t${i}`)));

  const result = await selectFromDatasets({
    basicsPath: basics,
    ratingsPath: ratings,
    topN: 5,
    excludedGenres: EXCLUDED_GENRES_IMDB,
  });
  assert.deepEqual(result.items.map((i) => i.tconst), ['tt0019999', 'tt0019998', 'tt0019997', 'tt0019996', 'tt0019995']);
});

test('сериал без единого голоса в каталог не попадает, но считается', async () => {
  const dir = tmpDir();
  const basics = writeGz(dir, 'b.tsv.gz', basicsFile([
    basicsRow('tt1', 'tvSeries', 'Rated', '0', '2020', '\\N', 'Drama'),
    basicsRow('tt2', 'tvSeries', 'Unrated', '0', '2021', '\\N', 'Drama'),
  ]));
  const ratings = writeGz(dir, 'r.tsv.gz', ratingsFile(['tt1\t8.0\t100']));

  const result = await selectFromDatasets({
    basicsPath: basics,
    ratingsPath: ratings,
    topN: 10,
    excludedGenres: EXCLUDED_GENRES_IMDB,
  });
  assert.deepEqual(result.items.map((i) => i.tconst), ['tt1']);
  assert.equal(result.counters.noRating, 1);
});

// ─── §9. Файл на диске ────────────────────────────────────────────────────────

test('прочитанный файл возвращается в исходном виде', async () => {
  const dir = tmpDir();
  const file = writeGz(dir, 'b.tsv.gz', basicsFile([basicsRow('tt1', 'tvSeries', 'X')]));
  assert.equal(readGz(file), basicsFile([basicsRow('tt1', 'tvSeries', 'X')]));
});