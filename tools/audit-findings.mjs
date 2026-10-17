// Аудит находок против кода: `tools/audit-findings.mjs`.
//
// `IMPROVEMENTS.md` живёт руками, и за месяцы в нём накопились строки, которые
// описывают давно исправленное: находку закрывают, но строку не трогают, а
// позже появляется новая с тем же содержанием и другим номером. На защите
// список открытых находок перестаёт быть списком.
//
// Скрипт не решает, закрыта находка или нет: он лишь отмечает строки, где
// предмет жалобы в коде отсутствует. Решение принимает человек, читая строку.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const findings = await readFile(path.join(ROOT, 'IMPROVEMENTS.md'), 'utf8');
const cut = findings.indexOf('\n## Закрыто');

const code = new Map();
for await (const file of walk(ROOT)) {
  const relative = path.relative(ROOT, file);
  if (!/^(src|public|tools|tests|db)\//.test(relative)) continue;
  if (!/\.(js|mjs|css|sql)$/.test(relative)) continue;
  code.set(relative, await readFile(file, 'utf8').catch(() => ''));
}

/** Файлы по дереву каталога: обход вглубь, а не только верхний уровень. */
async function* walk(dir) {
  const { readdir } = await import('node:fs/promises');
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Имена, по которым можно проверить находку в коде. */
const SYMBOLS = [
  /`([a-z][\w/.-]+\.(?:js|mjs|css|sql|md))`/gi,
  /`([a-z_]+)`/gi,
];

const rows = findings.split('\n');
const closedCut = cut === -1 ? rows.length : findings.slice(0, cut).split('\n').length;

const report = [];
rows.forEach((line, index) => {
  const match = line.match(/^\|\s*~{0,2}(\d+)~{0,2}\s*\|/);
  if (!match) return;
  const closed = line.includes('~~') || index >= closedCut;
  if (closed) return;

  const cells = line.split('|').map((cell) => cell.trim());
  const number = Number(match[1]);
  const subject = cells[2] ?? '';

  const names = new Set();
  for (const [, value] of subject.matchAll(SYMBOLS[0])) names.add(value);
  const known = [...names].filter((name) => [...code.keys()].some((file) => file.endsWith(name)));
  const missing = [...names].filter((name) => ![...code.keys()].some((file) => file.endsWith(name)));

  report.push({ number, known, missing, subject: subject.slice(0, 90) });
});

console.log('Открытых строк:', report.length);
console.log('');
for (const row of report) {
  const state = row.known.length === 0 && row.missing.length === 0
    ? '— нет имён для проверки'
    : (row.missing.length ? `нет файла: ${row.missing.slice(0, 3).join(', ')}` : `файлы на месте: ${row.known.slice(0, 2).join(', ')}`);
  console.log(`#${String(row.number).padStart(3)}  ${state}`);
  console.log(`        ${row.subject}`);
}