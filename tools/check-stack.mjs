// Список библиотек против кода (STACK §3, DEC-021).
//
// Запуск: node tools/check-stack.mjs
//
// Смысл тот же, что у схемы и у токенов: список зависимостей — обещание перед
// комиссией, и обещание, которое не выполняется, хуже отсутствия библиотеки.
// Документ обещал `zod`, `helmet`, `multer`, `lucide-static`, `marked`,
// `esbuild` и `sass`, которых в сборке нет: на вопрос «где у вас валидация
// входа» отвечать было нечем.
//
// Проверка ловит расхождение в обе стороны: описанного, но не установленного
// и установленного, но не описанного.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const installed = Object.keys(pkg.dependencies ?? {}).sort();

const whole = await readFile(path.join(ROOT, 'docs/05-architecture/STACK.md'), 'utf8');
// Проверяются только таблицы установленных пакетов: §3 от «### Серверные» до
// раздела «Чем заменены». В других разделах документа backticked-имена — это
// типы данных, названия решений и пакеты, которых в сборке нет и быть не
// должно, — сверять их с `package.json` бессмысленно.
const from = whole.indexOf('### Серверные');
const to = whole.indexOf('### Чем заменены', from);
const stack = whole.slice(from, to === -1 ? undefined : to);
// Первая ячейка строки таблицы §3: «| `пакет` | задача | …». В ячейке может
// быть несколько пакетов («`express-session` + `connect-pg-simple`») — берутся
// все. Безымянные строки вроде «| **Без UI-фреймворка** |» пакетами не считаются.
const described = [...stack.matchAll(/^\|([^|]*)\|/gm)]
  .flatMap((match) => [...match[1].matchAll(/`([a-z][a-z0-9-]*)`/g)].map((found) => found[1]))
  .filter((name) => name !== 'bytes');

const problems = [
  ...described.filter((name) => !installed.includes(name))
    .map((name) => `${name}: описан в §3, но не установлен`),
  ...installed.filter((name) => !described.includes(name))
    .map((name) => `${name}: установлен, но не описан в §3`),
];

if (problems.length) {
  console.error('Список зависимостей разошёлся с кодом:');
  for (const line of problems) console.error(`  ${line}`);
  process.exit(1);
}

console.log(`Зависимости совпадают: описан и установлен ${installed.length} пакет(ов).`);