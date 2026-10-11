// Сборка одной таблицы стилей из частей.
//
// Требование задания: ко всему веб-приложению применяется одна каскадная
// таблица стилей. Исходники разделены по маршрутам и компонентам — иначе
// одна таблица на шестьдесят экранов станет нечитаемой уже к ноябрю, — но
// пользователю отдаётся ровно один файл. Требование выполняется буквально:
// на этапе сборки части соединяются в один документ.
//
// Порядок задаётся именами файлов: 00-tokens идёт первым, чтобы токены были
// доступны всем ниже, 40-messages последним, чтобы не перебивал компоненты.
//
// Запуск:
//   node tools/build-css.mjs           пересобрать public/app.css
//   node tools/build-css.mjs --check   только проверить, ничего не писая

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'styles');
const OUT = path.join(ROOT, 'public', 'app.css');
const TOKENS_FILE = '00-tokens.css';

const names = (await readdir(SRC)).filter((n) => n.endsWith('.css')).sort();
if (names.length === 0) {
  console.error(`В ${SRC} нет ни одного .css`);
  process.exit(1);
}

const parts = [];
for (const name of names) {
  parts.push([name, (await readFile(path.join(SRC, name), 'utf8')).trim()]);
}

// Проверка: цвет вне файла токенов — ошибка, тема не переключится (TOKENS §8).
// Ловится здесь, а не на ревью: к моменту, когда это всплывёт на защите,
// переключатель темы уже будет выглядеть как «работает, но криво».
const offToken = [];
for (const [name, body] of parts) {
  if (name === TOKENS_FILE) continue;
  body.split('\n').forEach((line, i) => {
    if (/#[0-9a-f]{3,8}\b/i.test(line)) offToken.push(`${name}:${i + 1}`);
  });
}
if (offToken.length) {
  console.error('Цвет записан вне файла токенов — тема не переключится:');
  for (const where of offToken) console.error('  ' + where);
  process.exit(1);
}

// Проверка: переменная, которую используют, но нигде не задали.
// Браузер отбрасывает такое правило целиком и не пишет об этом ни слова:
// страница выглядит как «стиль не применился», а причина находится не в
// том файле, где её видно. Именно так в проекте молча пропал отступ
// сообщения: --space-9 использовался, но не был определён.
const defined = new Set();
const used = new Map();
for (const [name, body] of parts) {
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1]);
  for (const m of body.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
    if (!used.has(m[1])) used.set(m[1], name);
  }
}
const undefinedVars = [...used].filter(([prop]) => !defined.has(prop));
if (undefinedVars.length) {
  console.error('Переменная используется, но не задана — правило будет отброшено:');
  for (const [prop, name] of undefinedVars) console.error(`  var(${prop}) в ${name}`);
  console.error('Задайте её в 00-tokens.css или 10-base.css.');
  process.exit(1);
}

const header = [
  '/* SigmaSeries — собранная таблица стилей.',
  '   Этот файл НЕ ПРАВИТСЯ РУКАМИ.',
  '   Источник: src/styles/*.css, порядок по имени файла.',
  '   Сборка:   node tools/build-css.mjs',
  '   Проверка: npm run css:check',
  `   Частей: ${names.length}`,
  '*/',
].join('\n');

const out = [header, ...parts.map(([n, b]) => `/* ─── ${n} ─── */\n${b}`)].join('\n\n') + '\n';

if (process.argv.includes('--check')) {
  let current = null;
  try {
    current = await readFile(OUT, 'utf8');
  } catch {
    /* файла нет — расхождение */
  }
  if (current !== out) {
    console.error('Расхождение: public/app.css не соответствует src/styles/*.css');
    console.error('Пересоберите: node tools/build-css.mjs');
    process.exit(1);
  }
  console.log(`Стили синхронны: ${out.split('\n').length} строк, частей ${names.length}.`);
} else {
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, out, 'utf8');
  console.log(`Записано public/app.css: ${out.split('\n').length} строк из ${names.length} частей.`);
}