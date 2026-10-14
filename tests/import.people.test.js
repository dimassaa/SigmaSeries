// Люди сериала из IMDb (F-12-03 §4(3)).
//
// Тесты работают на крошечных сжатых файлах: настоящие `title.principals` —
// 750 МБ, и проверять на них было бы медленно, а разбор строки от размера
// файла не зависит.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  collectPeople,
  parseCrewLine,
  parsePrincipalsLine,
  parseNameLine,
  MAX_CAST,
} from '../src/services/import/people.js';

const gz = (text) => zlib.gzipSync(Buffer.from(text, 'utf8'));
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'imdb-people-'));

function fixture(rows) {
  const dirPath = dir();
  for (const [name, text] of Object.entries(rows)) {
    fs.writeFileSync(path.join(dirPath, name), gz(text));
  }
  return dirPath;
}

const CREW = ['tconst\tdirectors\twriters'].join('\n');
const PRINCIPALS = ['tconst\tordering\tnconst\tcategory\tjob\tcharacters'].join('\n');
const NAMES = ['nconst\tprimaryName\tbirthYear\tdeathYear\tprimaryProfession\tknownForTitles'].join('\n');

// ─── Разбор строк ─────────────────────────────────────────────────────────────

test('режиссёры читаются из своей колонки', () => {
  const row = parseCrewLine('tt1\tnm0001,nm0002\tnm0003');
  assert.deepEqual(row.directors, ['nm0001', 'nm0002']);
});

test('\\N в директорах — это «нет», а не имя из одного символа', () => {
  assert.deepEqual(parseCrewLine('tt1\t\\N\tnm0003').directors, []);
  assert.equal(parseCrewLine('tt1\tnm1\tnm2\tлишняя колонка'), null);
});

test('битые роли актёра не роняют строку', () => {
  const row = parsePrincipalsLine('tt1\t1\tnm0009\tactor\t\tне json');
  assert.deepEqual(row.characters, []);
});

test('роли актёра разбираются из JSON-массива', () => {
  const row = parsePrincipalsLine('tt1\t1\tnm0009\tactor\t\t["Walter","Jr."]');
  assert.deepEqual(row.characters, ['Walter', 'Jr.']);
  assert.equal(row.ordering, 1);
});

test('актёром считается только actor, actress и self', () => {
  const wanted = new Set(['actor', 'actress', 'self']);
  assert.equal(wanted.has('composer'), false);
  assert.equal(wanted.has('director'), false);
});

test('имя читается с годом рождения, \\N — это отсутствие', () => {
  assert.deepEqual(parseNameLine('nm0001\tVince Gilligan\t1967\t\\N\tWriter\ttt0903747'), {
    nconst: 'nm0001',
    name: 'Vince Gilligan',
    birthYear: 1967,
  });
  assert.equal(parseNameLine('nm0001\tVince Gilligan\t\\N\t\\N\tWriter\ttt0903747').birthYear, null);
});

// ─── Сбор по трём файлам ──────────────────────────────────────────────────────

test('директоры и актёры собираются вместе с именами', async () => {
  const dataDir = fixture({
    'title.crew.tsv.gz': `${CREW}\ntt1\tnm0001\t\ntt2\tnm0002\t\ntt_other\tnm0009\t\n`,
    'title.principals.tsv.gz': `${PRINCIPALS}\n`
      + 'tt1\t1\tnm0010\tactor\t\t["Walter"]\n'
      + 'tt1\t2\tnm0011\tactress\t\t["Skyler"]\n'
      + 'tt1\t3\tnm0099\tcomposer\t\t[]\n'
      + 'tt2\t1\tnm0012\tself\t\t[]\n',
    'name.basics.tsv.gz': `${NAMES}\n`
      + 'nm0001\tVince Gilligan\t1967\t\\N\tWriter\t\n'
      + 'nm0002\tDavid Chase\t1945\t\\N\tWriter\t\n'
      + 'nm0010\tBryan Cranston\t1956\t\\N\tActor\t\n'
      + 'nm0011\tAnna Gunn\t1968\t\\N\tActress\t\n'
      + 'nm0012\tДжон Смит\t1980\t\\N\tActor\t\n'
      + 'nm0099\tСлучайный человек\t1970\t\\N\tComposer\t\n',
  });

  const people = await collectPeople({ tconsts: ['tt1', 'tt2'], dataDir });

  assert.deepEqual(people.get('tt1').directors, [{ nconst: 'nm0001', name: 'Vince Gilligan' }]);
  assert.deepEqual(people.get('tt1').cast.map((c) => c.name), ['Bryan Cranston', 'Anna Gunn']);
  assert.deepEqual(people.get('tt1').cast[0].characters, ['Walter']);
  assert.equal(people.get('tt2').cast[0].name, 'Джон Смит');
});

test('случайный сериал из файла не попадает в выдачу', async () => {
  const dataDir = fixture({
    'title.crew.tsv.gz': `${CREW}\ntt1\tnm0001\t\ntt_other\tnm0009\t\n`,
    'title.principals.tsv.gz': `${PRINCIPALS}\ntt_other\t1\tnm0099\tactor\t\t[]\n`,
    'name.basics.tsv.gz': `${NAMES}\nnm0001\tVince Gilligan\t1967\t\\N\tWriter\t\n`,
  });
  const people = await collectPeople({ tconsts: ['tt1'], dataDir });
  assert.equal(people.has('tt_other'), false);
});

test('актёров больше десяти не берём', async () => {
  const many = Array.from({ length: 25 }, (_, i) => `tt1\t${i + 1}\tnm${i}\tactor\t\t[]`).join('\n');
  const dataDir = fixture({
    'title.crew.tsv.gz': `${CREW}\ntt1\t\\N\t\n`,
    'title.principals.tsv.gz': `${PRINCIPALS}\n${many}\n`,
    'name.basics.tsv.gz': `${NAMES}\n${Array.from({ length: 25 }, (_, i) => `nm${i}\tАктёр ${i}\t1980\t\\N\tActor\t`).join('\n')}\n`,
  });
  const people = await collectPeople({ tconsts: ['tt1'], dataDir });
  assert.equal(people.get('tt1').cast.length, MAX_CAST);
  assert.deepEqual(people.get('tt1').cast.map((c) => c.name), Array.from({ length: 10 }, (_, i) => `Актёр ${i}`));
});

test('сериал без людей получает пустые списки, а не пропадает', async () => {
  const dataDir = fixture({
    'title.crew.tsv.gz': `${CREW}\ntt1\tnm0001\t\n`,
    'title.principals.tsv.gz': `${PRINCIPALS}\ntt1\t1\tnm0010\tactor\t\t[]\n`,
    'name.basics.tsv.gz': `${NAMES}\nnm0001\tVince Gilligan\t1967\t\\N\tWriter\t\nnm0010\tBryan Cranston\t1956\t\\N\tActor\t\n`,
  });
  const people = await collectPeople({ tconsts: ['tt1', 'tt_missing'], dataDir });
  assert.equal(people.has('tt_missing'), false, 'о нём просто ничего не знаем');
  assert.deepEqual(people.get('tt1').directors.length, 1);
});

test('испорченная строка не роняет разбор', async () => {
  const dataDir = fixture({
    'title.crew.tsv.gz': `${CREW}\ntt1\tnm0001\t\nмусор\n`,
    'title.principals.tsv.gz': `${PRINCIPALS}\ntt1\t1\tnm0010\tactor\t\t[]\n`,
    'name.basics.tsv.gz': `${NAMES}\nnm0001\tVince Gilligan\t1967\t\\N\tWriter\t\nnm0010\tBryan Cranston\t1956\t\\N\tActor\t\n`,
  });
  const people = await collectPeople({ tconsts: ['tt1'], dataDir });
  assert.equal(people.get('tt1').directors[0].name, 'Vince Gilligan');
});

test('чужой заголовок останавливает разбор', async () => {
  const dataDir = fixture({
    'title.crew.tsv.gz': 'a\tb\tc\ntt1\tnm1\tnm2\n',
    'title.principals.tsv.gz': `${PRINCIPALS}\n`,
    'name.basics.tsv.gz': `${NAMES}\n`,
  });
  await assert.rejects(() => collectPeople({ tconsts: ['tt1'], dataDir }), /схема изменилась/);
});