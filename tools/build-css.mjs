// Сборка таблиц стилей по экранам.
//
// Исходники разделены по маршрутам и компонентам — одна таблица на шестьдесят
// экранов нечитаема уже к ноябрю. Сборщик собирает их в группы (список групп
// — в `src/config/styles.js`) и кладёт в `public/css/<группа>.css`: страница
// подключает общую часть и те группы, что ей нужны.
//
// Запуск:
//   node tools/build-css.mjs           пересобрать public/css/*.css
//   node tools/build-css.mjs --check   только проверить, ничего не писая

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STYLE_GROUPS } from '../src/config/styles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'styles');
const OUT = path.join(ROOT, 'public', 'css');
const TOKENS_FILE = '00-tokens.css';

const names = (await readdir(SRC)).filter((n) => n.endsWith('.css')).sort();
if (names.length === 0) {
  console.error(`В ${SRC} нет ни одного .css`);
  process.exit(1);
}

// Каждый исходник должен попасть ровно в одну группу: забытый файл молча
// выпал бы из сборки, и страница потеряла бы стили без единого сообщения.
const grouped = STYLE_GROUPS.flatMap((group) => group.files);
const missing = names.filter((name) => !grouped.includes(name));
const unknown = grouped.filter((name) => !names.includes(name));
const twice = grouped.filter((name, i) => grouped.indexOf(name) !== i);
if (missing.length || unknown.length || twice.length) {
  console.error('Файлы и группы не сходятся:');
  for (const name of missing) console.error(`  нет группы для ${name}`);
  for (const name of unknown) console.error(`  в группе есть несуществующий ${name}`);
  for (const name of twice) console.error(`  файл в двух группах: ${name}`);
  process.exit(1);
}

// Порядок групп должен совпадать с порядком файлов: иначе правила из
// разных экранов перебивают друг друга иначе, чем в одной общей таблице.
const order = STYLE_GROUPS.flatMap((group) => group.files);
if (order.join(',') !== names.join(',')) {
  console.error('Порядок групп не совпадает с порядком файлов:');
  console.error(`  файлы:   ${names.join(', ')}`);
  console.error(`  группы: ${order.join(', ')}`);
  process.exit(1);
}

const parts = new Map();
for (const name of names) {
  parts.set(name, (await readFile(path.join(SRC, name), 'utf8')).trim());
}

// Проверка: цвет вне файла токенов — ошибка, тема не переключится (TOKENS §8).
// Ловится здесь, а не на ревью: к моменту, когда это всплывёт на защите,
// переключатель темы уже будет выглядеть как «работает, но криво».
// Комментарии пропускаются: в них пишутся номера находок (`#121`, `#133`),
// а они состоят из цифр и выглядят как цвет. Проверять надо правила, а не
// пояснения к ним.
const offToken = [];
for (const [name, body] of parts) {
  if (name === TOKENS_FILE) continue;
  const rules = body.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
  rules.split('\n').forEach((line, i) => {
    if (/#[0-9a-f]{3,8}\b/i.test(line)) offToken.push(`${name}:${i + 1}`);
  });
}
if (offToken.length) {
  console.error('Цвет записан вне файла токенов — тема не переключится:');
  for (const where of offToken) console.error(`  ${where}`);
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

const outputs = new Map();
for (const group of STYLE_GROUPS) {
  const header = [
    `/* SigmaSeries — таблица стилей «${group.name}».`,
    '   Этот файл НЕ ПРАВИТСЯ РУКАМИ.',
    '   Источник: src/styles/*.css, состав — src/config/styles.js.',
    '   Сборка:   node tools/build-css.mjs',
    '   Проверка: npm run css:check',
    `   Частей: ${group.files.length}`,
    '*/',
  ].join('\n');
  const body = group.files
    .map((name) => `/* ─── ${name} ─── */\n${parts.get(name)}`)
    .join('\n\n');
  outputs.set(path.join(OUT, `${group.name}.css`), `${header}\n\n${body}\n`);
}

// Версия файлов: хэш содержимого собранных таблиц и клиентского скрипта.
// Ссылка на стиль с этой версией меняется после каждой сборки, и браузер
// перезапрашивает файл, а не держит старый до истечения кэша.
const version = createHash('sha256')
  .update([...outputs.values()].join('\n'))
  .update(await readFile(path.join(ROOT, 'public', 'app.js'), 'utf8'))
  .digest('hex')
  .slice(0, 12);
const VERSION_FILE = path.join(ROOT, 'public', 'asset-version.txt');

if (process.argv.includes('--check')) {
  let broken = 0;
  for (const [file, expected] of outputs) {
    let current = null;
    try {
      current = await readFile(file, 'utf8');
    } catch {
      /* файла нет — расхождение */
    }
    if (current !== expected) {
      console.error(`Расхождение: ${path.relative(ROOT, file)} не соответствует src/styles/*.css`);
      broken += 1;
    }
  }
  if (broken) {
    console.error('Пересоберите: node tools/build-css.mjs');
    process.exit(1);
  }
  const lines = [...outputs.values()].reduce((sum, text) => sum + text.split('\n').length, 0);
  const currentVersion = (await readFile(VERSION_FILE, 'utf8').catch(() => '')).trim();
  if (currentVersion !== version) {
    console.error('Версия файлов не совпадает: соберите стили заново (node tools/build-css.mjs)');
    process.exit(1);
  }
  console.log(`Стили синхронны: ${STYLE_GROUPS.length} таблиц, ${lines} строк, частей ${names.length}.`);
} else {
  await mkdir(OUT, { recursive: true });
  for (const [file, text] of outputs) await writeFile(file, text, 'utf8');
  // Устаревшие таблицы убираются: группа переименована или состав изменился —
  // и старый файл остался бы в каталоге навсегда, занимая место и путая
  // страницу, которая его просит.
  const wanted = new Set([...outputs.keys()].map((file) => path.basename(file)));
  for (const name of await readdir(OUT)) {
    if (name.endsWith('.css') && !wanted.has(name)) {
      await rm(path.join(OUT, name));
      console.log(`Удалён устаревший public/css/${name}`);
    }
  }
  await writeFile(VERSION_FILE, `${version}\n`, 'utf8');
  const lines = [...outputs.values()].reduce((sum, text) => sum + text.split('\n').length, 0);
  console.log(`Записано ${STYLE_GROUPS.length} таблиц в public/css: ${lines} строк из ${names.length} частей. Версия ${version}.`);
}
