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
// Два условия, оба обязательны. Первое: цепочка должна начинаться на границе
// слова — иначе «привет и прощай» схлопнется в «приветпрощай», и ни одно
// слово словаря не найдётся. Второе: минимум три буквы, иначе «и я» (два
// слова) станет «ия».
const SEPARATORS = /(?<=^| )(?:\p{L}[.\-_'\s]\s*){2,}\p{L}/gu;

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

/** Схлопывает повторы: «прииивет» → «привет». Допускаем 1 и 2 подряд. */
function collapse(s, keep) {
  return s
    .split(' ')
    .map((word) => word.replace(new RegExp(`(.)\\1{${keep},}`, 'gu'), '$1'))
    .join(' ');
}

/** Множество слов текста — чтобы не гонять словарь по всему тексту. */
function wordSet(normalized) {
  const set = new Set();
  for (const w of normalized.split(' ')) if (w) set.add(w);
  set.add(collapse(normalized, 1));
  set.add(collapse(normalized, 2));
  return set;
}

/**
 * Ищет слова списка в тексте.
 *
 * Сложность O(длина текста + размер словаря), а не O(текст × словарь):
 * при словаре в 10 000 слов и бюджете 50 мс вложенный перебор не уложился бы.
 *
 * @param {Set<string>[]} sets формы текста
 * @param {string[]} list словарь в исходной форме
 * @returns {string[]} найденные слова в исходной форме словаря
 */
function matchBody(sets, list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const found = [];
  for (const raw of list) {
    const w = normalize(raw);
    if (!w) continue;
    const c1 = collapse(w, 1);
    const c2 = collapse(w, 2);
    const hit = sets.some((set) => set.has(w) || set.has(c1) || set.has(c2));
    if (hit) found.push(raw);
  }
  return found;
}

/**
 * OP-01. Решает судьбу материала.
 *
 * @param {object} input
 * @param {string} input.body исходный текст автора
 * @param {{block:string[], allow:string[], available:boolean}} input.dictionary
 * @returns {{decision:'publish'|'queue'|'reject'|'unavailable', reason:string, matched:{word:string,list:string}[], hasLink:boolean}}
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
  const allowHits = matchBody(sets, dict.allow);
  if (allowHits.length > 0) {
    return {
      decision: 'publish',
      reason: 'allowlisted',
      matched: allowHits.map((word) => ({ word, list: 'allow' })),
      hasLink: false,
    };
  }

  const blockHits = matchBody(sets, dict.block);
  if (blockHits.length > 0) {
    return {
      decision: 'queue',
      reason: 'blocklist',
      matched: blockHits.map((word) => ({ word, list: 'block' })),
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