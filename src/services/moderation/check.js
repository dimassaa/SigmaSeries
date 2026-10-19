// OP-01 — проверка материала перед публикацией.
// Спецификация: docs/01-product/features/M5-ugc-moderation.md F-05-02.
// Правила стандартов: R-MOD-01…07 (03-standards/MODERATION.md).
//
// Решение не хранит состояние и не ходит в базу: на входе текст и словарь,
// на выходе решение. Всё, что зависит от данных (кластеры, бюджеты, очередь),
// живёт в moderation/cluster.js — иначе эту функцию нельзя покрыть тестом.

// Невидимые символы, которыми текст разбирают на части: нулевая ширина,
// мягкий перенос, направление письма. Без их удаления «п р и в е т»
// и «привет» — это для словаря два разных слова.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u00ad\ufeff]/g;

// Латинские буквы, неотличимые от кириллических. Словарь русский, поэтому
// «пpивет» с латинской p обязана ловиться так же, как «привет».
const HOMOGLYPHS = { a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у' };

// Цифры и символы, которыми подменяют буквы внутри слова. 3 читается и как
// «з», и как «е» («бо3д», но «прив3т»), поэтому проверка пробует обе формы —
// см. normalizeAlt.
const LEET = { '0': 'о', '1': 'л', '3': 'е', '4': 'а', '@': 'а', '$': 'с', '5': 'б', '7': 'т' };
const LEET_ALT = { ...LEET, '3': 'з' };

const LINK_SCHEME = /(?:https?|ftp):\/\//;
const LINK_WWW = /\bw\s*w\s*w\s*\./;
const LINK_DOMAIN = /\b[a-z0-9][a-z0-9-]{0,62}\.(?:ru|com|net|org|io|by|me|tv|info|site|xyz|online|club|pro|biz)\b/;

// «п.р.и.в.е.т», «п р и в е т», «п-р-и-в-е-т».
//
// Три условия, все обязательны. Первое: цепочка должна начинаться на границе
// слова — иначе «привет и прощай» схлопнется в «приветпрощай», и ни одно
// слово словаря не найдётся. Второе: минимум три буквы, иначе «и я» (два
// слова) станет «ия». Третье: сразу за последней буквой цепочки не должно
// стоять ещё буквы — иначе жадная цепочка захватывает пробел и первую букву
// следующего слова: «п р и в е т всем» превращалось в «приветвсем» (F-04-04).
const SEPARATORS = /(?<=^| )(?:\p{L}[.\-_'\s]\s*){2,}\p{L}(?!\p{L})/gu;

/**
 * Общая часть нормализации: регистр, невидимое, пробелы, разделители.
 * Гомоглифы здесь не подставляются — иначе ссылка «https://example.com»
 * превратится в «https://example.com» с кириллическими буквами
 * и перестанет распознаваться как ссылка.
 */
function basic(text) {
  let s = String(text ?? '').normalize('NFKC').toLowerCase();
  s = s.replace(INVISIBLE, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s.replace(SEPARATORS, (m) => m.replace(/[.\-_'\s]+/g, ''));
}

function fold(s, leet) {
  return s
    .replace(/[a-z]/g, (ch) => HOMOGLYPHS[ch] ?? ch)
    .replace(/[013457@$]/g, (ch) => leet[ch] ?? ch)
    .replace(/ё/g, 'е');
}

/**
 * Приводит текст к сравнимой форме.
 *
 * Возвращает НЕ то, что будет храниться: дословный текст автора не
 * подменяется никогда (F-05-02 правило (г)). Форма нужна только для поиска.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalize(text) {
  return fold(basic(text), LEET);
}

/** Вторая форма того же текста: 3 читается как «з». Используется при поиске. */
function normalizeAlt(text) {
  return fold(basic(text), LEET_ALT);
}

/** Схлопывает повторы букв внутри слова: keep=1 — повторы от двух, keep=2 — от трёх. */
function collapseWord(word, keep) {
  return word.replace(new RegExp(`(.)\\1{${keep},}`, 'gu'), '$1');
}

// Слово — буквы и цифры подряд. Знак препинания, приклеенный к слову, — это
// граница, а не часть слова: «привет!» — то же слово, что «привет». Поиск по
// кускам до пробела обходился одним восклицательным знаком (F-04-04).
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Множество слов текста и их схлопнутых форм — чтобы не гонять словарь
 * по всему тексту.
 *
 * Повторы схлопываются у каждого слова отдельно: схлопывание целой строки
 * работало только в однословном тексте и обходилось в многословном (F-04-04).
 */
function wordSet(normalized) {
  const set = new Set();
  for (const m of normalized.matchAll(WORD)) {
    const w = m[0];
    set.add(w);
    set.add(collapseWord(w, 1));
    set.add(collapseWord(w, 2));
  }
  return set;
}

/**
 * Приводит список словаря к единому виду.
 *
 * Слова приходят строками (простой список) или записями с категорией
 * (R-MOD-07 хранит категорию у слова) — наружу это различие не выходит.
 *
 * @param {Array<string|{word:string, category?:string|null}>} list
 * @returns {{word:string, category:string|null}[]}
 */
function asEntries(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (typeof item === 'string') out.push({ word: item, category: null });
    else if (item && typeof item.word === 'string') out.push({ word: item.word, category: item.category ?? null });
  }
  return out;
}

/**
 * Ищет слова списка в тексте.
 *
 * Сложность O(длина текста + размер словаря), а не O(текст × словарь):
 * при словаре в 10 000 слов и бюджете 50 мс вложенный перебор не уложился бы.
 *
 * @param {Set<string>[]} sets формы текста
 * @param {{word:string, category:string|null}[]} entries словарь в исходной форме
 * @returns {{word:string, category:string|null}[]} найденные слова с категориями
 */
function matchBody(sets, entries) {
  if (entries.length === 0) return [];
  const found = [];
  for (const { word: raw, category } of entries) {
    const w = normalize(raw);
    if (!w) continue;
    const c1 = collapseWord(w, 1);
    const c2 = collapseWord(w, 2);
    const hit = sets.some((set) => set.has(w) || set.has(c1) || set.has(c2));
    if (hit) found.push({ word: raw, category });
  }
  return found;
}

// Символ, из которых собираются слова карты смещений, — тот же набор, что
// в WORD: буквы и цифры.
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Нормализация с картой смещений: каждый символ результата помнит индекс
 * своего символа в исходном тексте. На карте строятся позиции находок —
 * «позиции в исходном тексте через карту смещений нормализации» (R-MOD-06).
 *
 * NFKC применяется к каждому символу отдельно: склейки из нескольких
 * символов (комбинирующие знаки) в карту не попадают — для подсветки это
 * допустимо, а единственную форму нормализации портить нельзя.
 *
 * @param {string} text
 * @param {Record<string,string>} leet таблица цифровых замен
 * @returns {{ch:string, at:number}[]}
 */
function mapped(text, leet) {
  const src = String(text ?? '');
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const piece = fold(src[i].normalize('NFKC').replace(INVISIBLE, '').toLowerCase(), leet);
    for (const ch of piece) out.push({ ch, at: i });
  }
  return out;
}

/**
 * Нормализованный текст с картой: пробелы сведены, разделители внутри
 * цепочек удалены — порядок шагов как в basic().
 *
 * @param {string} text
 * @param {Record<string,string>} leet таблица цифровых замен
 * @returns {{ch:string, at:number}[]}
 */
function mappedText(text, leet) {
  const squeezed = [];
  for (const c of mapped(text, leet)) {
    if (/\s/u.test(c.ch)) {
      if (squeezed.length > 0 && squeezed[squeezed.length - 1].ch !== ' ') squeezed.push({ ch: ' ', at: c.at });
      continue;
    }
    squeezed.push(c);
  }
  while (squeezed.length > 0 && squeezed[squeezed.length - 1].ch === ' ') squeezed.pop();

  const s = squeezed.map((c) => c.ch).join('');
  const kill = new Set();
  for (const m of s.matchAll(SEPARATORS)) {
    for (let k = 0; k < m[0].length; k++) {
      if (/[.\-_'\s]/u.test(m[0][k])) kill.add(m.index + k);
    }
  }
  return squeezed.filter((_, idx) => !kill.has(idx));
}

/** Слова нормализованного текста с их позициями в исходном тексте. */
function tokenize(chars) {
  const tokens = [];
  let acc = null;
  for (const c of chars) {
    if (WORD_CHAR.test(c.ch)) {
      if (!acc) acc = { text: '', start: c.at, end: c.at + 1 };
      acc.text += c.ch;
      acc.end = c.at + 1;
    } else if (acc) {
      tokens.push(acc);
      acc = null;
    }
  }
  if (acc) tokens.push(acc);
  return tokens;
}

/** Формы слова: как есть и со схлопнутыми повторами — тот же набор, что в wordSet. */
function formsOf(word) {
  return [word, collapseWord(word, 1), collapseWord(word, 2)];
}

/**
 * Ищет позиции найденных слов в исходном тексте (R-MOD-06).
 *
 * Для каждого слова берётся первое подходящее слово нормализованного текста.
 * Слово, найденное только второй цифровой формой («бо3д» → «бозд»), ищется
 * и по карте второй формы.
 *
 * @param {string} text исходный текст автора
 * @param {string[]} words найденные слова в форме словаря
 * @returns {Map<string, {start:number, end:number}>}
 */
function locateSpans(text, words) {
  const spans = new Map();
  let pending = [];
  for (const raw of words) {
    const w = normalize(raw);
    if (w && !spans.has(raw)) pending.push({ raw, w });
  }
  for (const leet of [LEET, LEET_ALT]) {
    if (pending.length === 0) break;
    const index = new Map();
    for (const t of tokenize(mappedText(text, leet))) {
      for (const f of formsOf(t.text)) if (!index.has(f)) index.set(f, t);
    }
    const next = [];
    for (const item of pending) {
      let best = null;
      for (const f of formsOf(item.w)) {
        const t = index.get(f);
        if (t && (!best || t.start < best.start)) best = t;
      }
      if (best) spans.set(item.raw, { start: best.start, end: best.end });
      else next.push(item);
    }
    pending = next;
  }
  return spans;
}

/**
 * OP-01. Решает судьбу материала.
 *
 * @param {object} input
 * @param {string} input.body исходный текст автора
 * @param {object} input.dictionary
 * @param {Array<string|{word:string, category?:string|null}>} input.dictionary.block
 * @param {Array<string|{word:string, category?:string|null}>} input.dictionary.allow
 * @param {boolean} input.dictionary.available
 * @returns {{decision:'publish'|'queue'|'reject'|'unavailable', reason:string, matched:{word:string,list:string,category:string|null,start?:number,end?:number}[], hasLink:boolean}}
 */
export function checkMaterial({ body, dictionary }) {
  const dict = dictionary ?? { block: [], allow: [], available: false };

  // Словарь недоступен — материал ждёт. Публиковать вслепую нельзя:
  // сбой загрузки превратился бы в обход модерации (F-05-02 правило (а)).
  if (dict.available === false) {
    return { decision: 'unavailable', reason: 'dictionary-unavailable', matched: [], hasLink: false };
  }

  const plain = basic(body);
  if (!plain) {
    return { decision: 'reject', reason: 'empty', matched: [], hasLink: false };
  }

  // Ссылки проверяются независимо от обоих списков. Если бы «разрешённое»
  // слово отменяло и ссылку, правило обходилось бы словом из белого списка.
  const hasLink = LINK_SCHEME.test(plain) || LINK_WWW.test(plain) || LINK_DOMAIN.test(plain);
  if (hasLink) {
    return { decision: 'queue', reason: 'link', matched: [], hasLink: true };
  }

  const sets = [wordSet(normalize(body)), wordSet(normalizeAlt(body))];

  // Белый список раньше чёрного: обратный порядок даёт ложные срабатывания,
  // которые автор лечит заменой слова, а редактор — руками.
  const allowHits = matchBody(sets, asEntries(dict.allow));
  if (allowHits.length > 0) {
    // Позиции здесь не считаются: белый список публикует материал,
    // и подсвечивать автору нечего.
    return {
      decision: 'publish',
      reason: 'allowlisted',
      matched: allowHits.map((h) => ({ word: h.word, list: 'allow', category: h.category })),
      hasLink: false,
    };
  }

  const blockHits = matchBody(sets, asEntries(dict.block));
  if (blockHits.length > 0) {
    const spans = locateSpans(body, blockHits.map((h) => h.word));
    return {
      decision: 'queue',
      reason: 'blocklist',
      matched: blockHits.map((h) => ({ word: h.word, list: 'block', category: h.category, ...(spans.get(h.word) ?? {}) })),
      hasLink: false,
    };
  }

  return { decision: 'publish', reason: 'ok', matched: [], hasLink: false };
}

/**
 * Что показывается автору.
 *
 * Ключ, а не готовый текст: причина переводится на язык интерфейса
 * (измерение 11, M5 §0). Совпавшее слово наружу не отдаётся — иначе обход
 * одной заменой синонима (F-05-02 правило (б)).
 *
 * @param {ReturnType<typeof checkMaterial>} result
 * @param {{final?:boolean, rejected?:boolean}} [opts]
 */
export function authorView(result, opts = {}) {
  if (result.decision === 'publish') {
    return { status: 'published', code: 'ugc.published', params: {} };
  }
  if (result.decision === 'reject') {
    return { status: 'rejected', code: 'ugc.rejected.empty', params: {}, canFix: false, canWait: false };
  }
  if (result.decision === 'unavailable') {
    return { status: 'queued', code: 'ugc.check.unavailable', params: {}, canFix: false, canWait: true };
  }
  if (opts.final && opts.rejected) {
    // Причина обязательна и конкретна — её и объясняют человеку.
    const word = result.matched[0]?.word ?? '';
    return {
      status: 'rejected',
      code: 'ugc.rejected.final',
      params: { word },
      matchedWord: word,
      canFix: false,
      canWait: false,
    };
  }
  return { status: 'queued', code: 'ugc.flagged', params: {}, canFix: true, canWait: true };
}