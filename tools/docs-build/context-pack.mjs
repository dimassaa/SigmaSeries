#!/usr/bin/env node
// context-pack.mjs — «пакет контекста» для агента: всё нужное для одной фичи в одном файле.
// Без зависимостей, Node.js 18+. Запуск из корня репозитория (рядом с папкой docs/).
//   node tools/docs-build/context-pack.mjs F-01-03            пакет фичи
//   node tools/docs-build/context-pack.mjs --module M1        обзор модуля и список его фич
//   node tools/docs-build/context-pack.mjs --neighbors F-01-03 соседние фичи и модули
//   node tools/docs-build/context-pack.mjs --where E-Session  где определено и где упоминается
//   node tools/docs-build/context-pack.mjs --all --out docs/_packs   собрать все пакеты
//   node tools/docs-build/context-pack.mjs --check            проверка: размеры, ссылки, дубли ID
import fs from 'node:fs';
import path from 'node:path';

const DOCS = process.env.DOCS_DIR ?? 'docs';
const MAX_LINES = 700;
const die = (m, code = 2) => { console.error('Ошибка: ' + m); process.exit(code); };

// ---- строгая проверка аргументов: вывод вставляется в запрос агента через shell ----
const FEATURE = /^F-\d\d-\d\d$/, MODULE = /^M\d{1,2}$/;
const TOKEN = /^(?:[A-Z]{1,4}-[A-Za-z0-9]+(?:-\d+)?|[a-z]+(?:\.[a-z_]+)+)$/;
const OUTDIR = /^[\w./-]+$/;
const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const val = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
if (!args.length || flag('help')) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 11).join('\n')); process.exit(0); }
if (!fs.existsSync(DOCS)) die(`нет папки ${DOCS} (запускайте из корня репозитория)`);

// ---- чтение документов ----
const norm = p => p.split(path.sep).join('/');
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('_')) continue; const p = path.join(d, e.name); e.isDirectory() ? walk(p, out) : e.name.endsWith('.md') && out.push(p); } return out; };
const files = walk(DOCS);
const texts = new Map(files.map(f => [norm(path.relative(DOCS, f)), fs.readFileSync(f, 'utf8')]));
const GENERATED = new Set(['00-process/COVERAGE.md', '00-process/EDGE-CASES.md', '01-product/FEATURES.md', 'STATUS.md']);

const registry = re => { const m = new Map(); for (const [f, t] of texts) { if (GENERATED.has(f)) continue; t.split('\n').forEach((l, i) => { const x = l.match(re); if (x) { if (!m.has(x[1])) m.set(x[1], []); m.get(x[1]).push({ line: l, file: f, n: i + 1 }); } }); } return m; };
const REG = {
  R: registry(/^\| (R-[A-Z0-9]+-\d+) \|/), EC: registry(/^\| (EC-[A-Z]\d+) \|/), H: registry(/^\| (H-\d+) \|/),
  DEC: registry(/^\| (DEC-\d+) \|/), EV: registry(/^\| (EV-\d+) \|/), OP: registry(/^\| (OP-\d+) \|/),
  S: registry(/^\| (S-\d\d) \|/), UI: registry(/^\| (UI-\d\d) \|/), J: registry(/^\| (J-\d\d) \|/),
};
const bullet = (id, e) => { const cols = e.line.split('|').slice(1, -1).map(s => s.trim()); return `- **${id}** — ${cols.slice(1).filter(Boolean).join(' · ')} _(${e.file})_`; };

// ---- фичи и модули ----
const FEATS = new Map(), MODS = new Map();
for (const [f, t] of texts) {
  const mm = f.match(/^01-product\/features\/(M\d+)-/); if (!mm) continue;
  const parts = t.split(/\n(?=## F-\d\d-\d\d )/);
  MODS.set(mm[1], { file: f, intro: parts[0].replace(/\n---\s*$/, '').trimEnd() });
  for (const p of parts.slice(1)) {
    const h = p.split('\n', 1)[0].match(/^## (F-\d\d-\d\d) (.+?) · (.+)$/); if (!h) continue;
    const cut = p.indexOf('\n---\n');
    FEATS.set(h[1], { id: h[1], title: h[2], tier: h[3], mod: mm[1], file: f, body: (cut > 0 ? p.slice(0, cut) : p).trimEnd() });
  }
}

// ---- извлечение ссылок ----
const KINDS = 'DES|SEC|SEO|PERF|I18N|A11Y|AN|MOD|TST';
function refs(text, selfId) {
  const o = { R: new Set(), EC: new Set(), H: new Set(), DEC: new Set(), EV: new Set(), OP: new Set(), S: new Set(), UI: new Set(), J: new Set(), F: new Set(), M: new Set() };
  const re = new RegExp('R-(' + KINDS + ')-(\\d+)(?:…(\\d+))?((?:`?,\\s*`?\\d+(?:…\\d+)?`?)*)', 'g');
  for (const m of text.matchAll(re)) {
    const add = (a, b) => { for (let n = +a; n <= +(b ?? a); n++) o.R.add(`R-${m[1]}-${String(n).padStart(2, '0')}`); };
    add(m[2], m[3]); for (const x of (m[4] || '').matchAll(/(\d+)(?:…(\d+))?/g)) add(x[1], x[2]);
  }
  const grab = (set, r) => { for (const m of text.matchAll(r)) set.add(m[0]); };
  grab(o.EC, /EC-[A-Z]\d+/g); grab(o.H, /\bH-\d+\b/g); grab(o.DEC, /\bDEC-\d+\b/g); grab(o.EV, /\bEV-\d+\b/g);
  grab(o.OP, /\bOP-\d+\b/g); grab(o.S, /\bS-\d\d\b/g); grab(o.UI, /\bUI-\d\d\b/g); grab(o.J, /\bJ-\d\d\b/g);
  grab(o.F, /\bF-\d\d-\d\d\b/g); grab(o.M, /\bM\d{1,2}\b/g); o.F.delete(selfId);
  return o;
}
const unresolved = r => { const u = []; for (const k of Object.keys(REG)) for (const id of r[k]) if (!REG[k].has(id)) u.push(id); for (const f of r.F) if (!FEATS.has(f)) u.push(f); return u; };

// ---- вспомогательное: разделы стандартов и чек-листы ----
const section = (file, headRe) => { const t = texts.get(file) ?? ''; const i = t.split('\n').findIndex(l => headRe.test(l)); if (i < 0) return null; const ls = t.split('\n').slice(i); const j = ls.slice(1).findIndex(l => l.startsWith('## ')); return (j < 0 ? ls : ls.slice(0, j + 1)).join('\n').trimEnd(); };
const CHECK = {
  design: ['02-design/PRINCIPLES.md', /^## 13\./], a11y: ['03-standards/A11Y.md', /^## 3\./], seo: ['03-standards/SEO.md', /^## 3\./],
  perf: ['03-standards/PERFORMANCE.md', /^## 5\./], i18n: ['03-standards/I18N.md', /^## 4\./], analytics: ['03-standards/ANALYTICS.md', /^## 6\./],
  moderation: ['03-standards/MODERATION.md', /^## 7\./], testing: ['03-standards/TESTING.md', /^## 6\./], security: ['03-standards/SECURITY.md', /^## 5\./],
};
function coverageMarks(id) { const t = texts.get('00-process/COVERAGE.md') ?? ''; const l = t.split('\n').find(x => x.startsWith(`| ${id} |`)); if (!l) return null; const c = l.split('|').slice(1, -1).map(s => s.trim()); const m = {}; for (let d = 1; d <= 20; d++) m[d] = c[1 + d]; return m; }

const glossary = []; for (const l of (texts.get('00-process/GLOSSARY.md') ?? '').split('\n')) { const c = l.split('|').slice(1, -1).map(s => s.trim()); if (c.length === 4 && c[0].length >= 6 && !/^(Сериал|Сезон|Серия|Жанр|Термин)$/.test(c[0]) && !c[0].startsWith('---')) glossary.push(c); }

// ---- сборка пакета ----
function pack(id) {
  const f = FEATS.get(id); if (!f) die(`нет фичи ${id}`);
  const mod = MODS.get(f.mod), intro = mod.intro;
  const r = refs(f.body + '\n' + intro, id), un = unresolved(r);
  const L = [];
  L.push(`# PACK ${id} — ${f.title} · ${f.tier}`, '', `> Собрано \`context-pack.mjs\`. **Не править.** Здесь всё, что нужно для задачи по этой фиче. Нужно больше — раздел «Куда смотреть дальше».`, '');
  L.push('## 1. Фича', '', f.body, '', `## 2. Модуль ${f.mod}: общее для всех его фич (${mod.file})`, '', intro.split('\n').filter(l => !/^> v\d/.test(l)).join('\n').replace(/^# .*\n+/, ''), '');
  const sec = (title, set, key, fmt = bullet) => { const items = [...set].filter(x => REG[key].has(x)).sort(); if (items.length) { L.push(`## ${title}`, ''); for (const x of items) L.push(fmt(x, REG[key].get(x)[0])); L.push(''); } };
  sec('3. Правила стандартов, на которые ссылается фича', r.R, 'R'); sec('4. Граничные случаи', r.EC, 'EC');
  sec('5. Решения', r.DEC, 'DEC'); sec('6. Гипотезы (ждут подтверждения автора)', r.H, 'H');
  sec('7. События аналитики', r.EV, 'EV'); sec('8. Бизнес-операции', r.OP, 'OP'); sec('9. Экраны', r.S, 'S'); sec('10. Компоненты оболочки', r.UI, 'UI'); sec('11. Пути пользователей', r.J, 'J');
  const text = (f.body + intro).toLowerCase(), terms = glossary.filter(g => text.includes(g[0].toLowerCase())).slice(0, 12);
  if (terms.length) { L.push('## 12. Термины', ''); for (const g of terms) L.push(`- **${g[0]}** (${g[1]}) — ${g[2]}`); L.push(''); }
  const roles = section('01-product/ROLES-PERMISSIONS.md', /^## 1\./); if (roles) L.push('## 13. Модель ролей (полная матрица — `ROLES-PERMISSIONS.md` §2)', '', roles.replace(/^## .*\n+/, ''), '');
  const m = coverageMarks(id) ?? {}, ok = d => m[d] && m[d] !== '—';
  const picks = [['testing', true], ['design', ok(19)], ['a11y', ok(12)], ['seo', ok(13)], ['perf', ok(14)], ['i18n', ok(11)], ['analytics', ok(16)], ['security', ok(15)], ['moderation', f.mod === 'M5']];
  L.push('## 14. Как ревьюить (чек-листы по применимым измерениям)', '');
  for (const [k, use] of picks) { if (!use) continue; const s = section(...CHECK[k]); if (s) L.push(s.replace(/^## /, '### '), ''); }
  const nb = [...r.F].filter(x => FEATS.has(x)), mods = [...r.M].filter(x => MODS.has(x) && x !== f.mod);
  L.push('## 15. Куда смотреть дальше', '');
  if (nb.length) { L.push('Связанные фичи (полный пакет — `node tools/docs-build/context-pack.mjs <ID>`):'); for (const x of nb.sort()) L.push(`- ${x} — ${FEATS.get(x).title} (${FEATS.get(x).mod}, ${FEATS.get(x).tier})`); }
  if (mods.length) L.push(`Упомянутые модули: ${mods.sort().join(', ')} — обзор: \`--module <M>\`.`);
  L.push('Где определено или используется: `--where <ID или ключ настройки>`. Конфликт, расхождение, блокер — протокол «оспорить документ» (`PLAN` §11), решения — `DECISIONS.md`.', '');
  if (un.length) L.push('## Не найдено в документах', '', un.join(', '), '');
  return { text: L.join('\n'), lines: L.join('\n').split('\n').length, unresolved: un };
}

function moduleOverview(m) {
  const mod = MODS.get(m); if (!mod) die(`нет модуля ${m} среди описанных: ${[...MODS.keys()].join(', ')}`);
  const L = [`# Модуль ${m} (${mod.file})`, '', mod.intro, '', '## Фичи', '', '| ID | Фича | Уровень |', '|---|---|---|'];
  for (const x of FEATS.values()) if (x.mod === m) L.push(`| ${x.id} | ${x.title} | ${x.tier} |`);
  return L.join('\n');
}
function neighbors(id) {
  const f = FEATS.get(id); if (!f) die(`нет фичи ${id}`);
  const r = refs(f.body + '\n' + MODS.get(f.mod).intro, id), L = [`# Соседи ${id}`, ''];
  for (const x of [...r.F].sort()) if (FEATS.has(x)) L.push(`- ${x} — ${FEATS.get(x).title} (${FEATS.get(x).mod}, ${FEATS.get(x).tier})`);
  for (const m of [...r.M].sort()) if (MODS.has(m) && m !== f.mod) { L.push('', `Модуль ${m}:`); for (const x of FEATS.values()) if (x.mod === m) L.push(`- ${x.id} — ${x.title}`); }
  return L.join('\n');
}
function where(tok) {
  const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), re = new RegExp('(?<![A-Za-z0-9-])' + esc + '(?![A-Za-z0-9])');
  const defs = [], uses = [];
  for (const [f, t] of texts) { if (GENERATED.has(f)) continue; t.split('\n').forEach((l, i) => { if (!re.test(l)) return; (l.startsWith(`| ${tok} |`) || l.startsWith(`| \`${tok}\``) || l.startsWith(`## ${tok} `) ? defs : uses).push(`${f}:${i + 1}: ${l.trim().slice(0, 150)}`); }); }
  return [`# ${tok}`, '', '## Определение', ...(defs.length ? defs : ['(строки-определения не найдено)']), '', `## Упоминания (${uses.length}, показано до 40)`, ...uses.slice(0, 40)].join('\n');
}

// ---- режимы ----
const out = val('out');
if (out !== undefined && (!OUTDIR.test(out) || out.includes('..'))) die('недопустимый путь --out');
if (flag('module')) { const m = val('module'); if (!MODULE.test(m ?? '')) die('формат: --module M1'); console.log(moduleOverview(m)); }
else if (flag('neighbors')) { const x = val('neighbors'); if (!FEATURE.test(x ?? '')) die('формат: --neighbors F-01-03'); console.log(neighbors(x)); }
else if (flag('where')) { const x = val('where'); if (!TOKEN.test(x ?? '')) die('формат: --where E-Session | EV-05 | R-SEC-04 | auth.token_ttl_min'); console.log(where(x)); }
else if (flag('all') || flag('check')) {
  let bad = 0; const rows = [];
  for (const id of FEATS.keys()) { const p = pack(id); rows.push(`${id}\t${p.lines}${p.lines > MAX_LINES ? '  ПРЕВЫШЕН ЛИМИТ' : ''}${p.unresolved.length ? '  не найдено: ' + p.unresolved.join(',') : ''}`); if (p.lines > MAX_LINES || p.unresolved.length) bad++; if (flag('all') && out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, id + '.md'), p.text + '\n'); } }
  const dups = new Map(); for (const [f, t] of texts) { if (GENERATED.has(f)) continue; t.split('\n').forEach((l, i) => { const x = l.match(/^\| ((?:[A-Z]{1,3}-[A-Z]?\d+)|(?:R-[A-Z0-9]+-\d+)) \|/); if (x) { if (!dups.has(x[1])) dups.set(x[1], new Set()); dups.get(x[1]).add(f); } }); }
  const dd = [...dups].filter(([, s]) => s.size > 1).map(([k, s]) => `${k} (${[...s].join(', ')})`);
  console.log(rows.join('\n')); console.log(`\nФич: ${FEATS.size}; макс. строк в пакете: ${Math.max(...rows.map(r => +r.split('\t')[1].split(' ')[0]))}; проблемных: ${bad}; ID, определённых в нескольких файлах: ${dd.length ? dd.join('; ') : 'нет'}`);
  if (flag('check') && (bad || dd.length)) process.exit(1);
}
else { const id = args[0]; if (!FEATURE.test(id)) die('формат: F-01-03 (или см. --help)'); const p = pack(id); console.log(p.text); if (p.unresolved.length) console.error('Не найдено: ' + p.unresolved.join(', ')); }
