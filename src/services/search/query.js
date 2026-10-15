// Нормализация поискового запроса (F-02-06 §3).
//
// Одна функция нормализует и запрос, и названия из базы. Если правила для них
// разойдутся, поиск перестанет находить то, что человек видит своими глазами,
// и это не будет выглядеть поломкой — просто «ничего не найдено».
//
// Порядок правил задан спецификацией и не переставляется: точное совпадение
// названия → начало названия → начало слова → опечатка → остальное.
//
// Исправление раскладки живёт отдельной функцией, а не внутри `normalize`.
// Человек набирает «ghbdtn» и ждёт «привет», но латинское «the wire» переводить
// нельзя, а по алфавиту одно от другого не отличить: оба состоят из латиницы.
// Решает результат — сначала ищем как введено, и только если ничего не нашлось,
// пробуем другую раскладку и показываем пометку (F-02-06 §3).
//
// Что здесь НЕ делается и почему:
//
//  • Полноценная морфология (pymorphy, Snowball) не подключается: это внешний
//    сервис, а `STACK` §3 его не разрешает. Основа вырезается здесь — «сериалы»
//    и «сериала» находят друг друга.
//  • Регистр и `ё → е` — обязательны: пользователь пишет «Ешь» так же, как
//    «еш», и вправе получить тот же результат.

/**
 * Ряды клавиатуры: русский и латинский на одних и тех же клавишах.
 *
 * Порядок символов в обоих рядах совпадает с настоящей раскладкой, поэтому
 * `ghbdtn` переводится в «привет», а не в «гривет». Русский ряд кончается
 * точкой — на её клавише в латинском стоит `/`, а запятая и точка в русском
 * стоят там, где в латинском `,` и `.`.
 */
const LAYOUTS = [
  ['йцукенгшщзхъ', 'qwertyuiop[]'],
  ['фывапролджэ', "asdfghjkl;'"],
  ['ячсмитьбю.', 'zxcvbnm,./'],
];

/** Символы, которые не несут смысла для поиска. */
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;

const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /\p{Script=Latin}/u;

/**
 * Приводит строку к сравнимому виду.
 *
 * Порядок обязателен: NFKD раскладывает диакритику и должен идти до снятия
 * диакритики, а `ё → е` — после lowerCase, иначе `Ё` не преобразуется.
 *
 * @param {string} value
 * @returns {string} пустая строка, если из входа не осталось ничего значимого
 */
export function normalize(value) {
  let text = String(value ?? '').toLowerCase().normalize('NFC');

  // Диакритика снимается только у латиницы: `NFKD` раскладывает и кириллицу, а
  // у `й` это превращает в `и` с галочкой — «мой» становился «мои», а «край» —
  // «краи». Латиница раскладывается и собирается обратно без надстрочных.
  text = text.replace(/[\p{Script=Latin}\p{M}]+/gu, (chunk) => chunk.normalize('NFKD').replace(/\p{M}+/gu, ''));

  text = text.replace(/ё/g, 'е');
  text = text.replace(PUNCTUATION, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Переводит буквы на соседние клавиши, в обе стороны.
 *
 * Обе стороны нужны для проверки: человек ищет по-русски, а ошибается в
 * латинской раскладке; но и наоборот — русские буквы, набранные при включённой
 * английской раскладке, встречаются на телефонах.
 */
function fixLayout(text) {
  let out = '';
  let converted = false;
  for (const char of text) {
    let replaced = char;
    for (const [ru, en] of LAYOUTS) {
      // Сначала латиница → кириллица, затем наоборот: порядок не важен, потому
      // что буквы разных алфавитов никогда не совпадают на одной клавише.
      const inLatin = en.indexOf(char);
      if (inLatin !== -1) {
        replaced = ru[inLatin];
        converted = true;
        break;
      }
      const inRussian = ru.indexOf(char);
      if (inRussian !== -1) {
        replaced = en[inRussian];
        converted = true;
        break;
      }
    }
    out += replaced;
  }
  return converted ? out : text;
}

/**
 * Переводит запрос в другую раскладку.
 *
 * Решение о том, нужен ли перевод, принимает не эта функция, а вызывающий код:
 * по алфавиту «the wire» и «ghbdtn» неразличимы — оба состоят из латиницы, и
 * единственный способ понять, что человек ошибся, это найти результат и
 * посмотреть, пусто ли было (F-02-06 §3).
 *
 * Смешанный запрос (сериал + актёр) не переводится: половина слов станет мусором,
 * а человек увидит не то, что набирал.
 *
 * @param {string} value
 * @returns {string|null} перевод или `null`, если перевода нет
 */
export function otherLayout(value) {
  const raw = String(value ?? '');
  const letters = raw.replace(PUNCTUATION, ' ').trim();
  if (!letters) return null;
  if (CYRILLIC.test(letters) && LATIN.test(letters)) return null;

  const fixed = fixLayout(raw.toLowerCase());
  return fixed === raw.toLowerCase() ? null : fixed;
}

/**
 * Падежные формы, которые не сходятся срезом окончания.
 *
 * Список короткий и только для слов, которые встречаются в названиях чаще
 * всего: полная морфология — это внешний сервис, а `STACK` §3 его не
 * разрешает. Форма, которой здесь нет, ищется как есть: человек допечатает
 * слово целиком, и это работает.
 */
const FALLBACK_STEMS = {
  сериа: 'сериал',
  сериалов: 'сериал',
  сериала: 'сериал',
  сериалы: 'сериал',
  сериалом: 'сериал',
  сериале: 'сериал',
  фильм: 'фильм',
  фильма: 'фильм',
  фильмы: 'фильм',
  фильмов: 'фильм',
  человек: 'человек',
  человека: 'человек',
  люди: 'человек',
  людям: 'человек',
};

/**
 * Основа слова: отрезает окончание.
 *
 * Грубая и предсказуемая. Русская морфология в приложении не нужна: поиск идёт
 * по названиям, а «Игра престолов» ищется как «игра престоло», «во все тяжкие»
 * — как «во все тяжк». Ошибка в одну букву даёт ложное совпадение, которого
 * человек не заметит, — ошибка в две отсекает лишнее и прячет результат.
 *
 * @param {string} word
 * @returns {string}
 */
export function stem(word) {
  const text = normalize(word);
  if (text.length <= 4) return text;
  if (FALLBACK_STEMS[text]) return FALLBACK_STEMS[text];

  // Окончания отсекаются от длинных к коротким, и только когда остаток остаётся
  // не короче трёх знаков: «кот» и «друг» остаются собой.
  //
  // Окончаний из одного знака и «ие» в списке нет намеренно. Срезав «е» из
  // «тяжкие», получим «тяжк» — и опечатка в одну букву перестанет отличаться от
  // другой формы того же слова: поиск станет либо слепым, либо шумным. Падеж
  // закрывается словарём ниже, а не порчей основы.
  const endings = [
    'иями', 'ями', 'ами', 'ыми', 'ими', 'ого', 'его', 'ому', 'ему',
    'ете', 'ешь', 'ах', 'ях', 'ом', 'ем', 'ев', 'ью',
    'ой', 'ей', 'ый', 'ий', 'ая', 'яя', 'ое', 'ее', 'ые', 'ам', 'ям',
    'ть', 'ся', 'сь', 'ов', 'ла', 'ло', 'ли', 'на', 'но', 'ны',
  ];
  for (const ending of endings) {
    if (text.length - ending.length >= 3 && text.endsWith(ending)) {
      return text.slice(0, -ending.length);
    }
  }
  return text;
}

/**
 * Основы всех слов строки.
 *
 * @param {string} value
 * @returns {string[]}
 */
export function wordsOf(value) {
  return normalize(value)
    .split(' ')
    .filter(Boolean)
    .map((word) => FALLBACK_STEMS[word] ?? stem(word));
}

/**
 * Слова запроса как основы, но не короче двух знаков.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function queryStems(query) {
  return wordsOf(query).filter((word) => word.length >= 2);
}

/**
 * Запрос из одних знаков препинания считается пустым (EC-K9).
 *
 * @param {string} query
 * @returns {boolean}
 */
export function isEmptyQuery(query) {
  return normalize(query).length === 0;
}

/**
 * Запрос длиннее лимита обрезается (F-02-06 §5): обрезанный запрос всё ещё
 * ищет, а отклонённый — нет.
 *
 * @param {string} query
 * @param {number} [max]
 * @returns {{query: string, truncated: boolean}}
 */
export function trimQuery(query, max = 100) {
  const text = String(query ?? '');
  if (text.length <= max) return { query: text, truncated: false };
  return { query: text.slice(0, max), truncated: true };
}

/**
 * Ранг совпадения (F-02-06 §3): меньше — лучше.
 *
 * @param {string[]} haystems основы всех слов названия
 * @param {string[]} needles основы слов запроса
 * @returns {number|null} `null`, если совпадения нет
 */
export function rankOf(haystems, needles) {
  if (!needles.length || !haystems.length) return null;
  const joined = haystems.join(' ');
  const full = needles.join(' ');

  // 1. Точное совпадение названия целиком.
  if (joined === full) return 0;
  // 2. Название начинается с запроса.
  if (joined.startsWith(full)) return 1;
  // 3. Каждое слово запроса начинает слово названия.
  if (needles.every((needle) => haystems.some((hay) => hay.startsWith(needle)))) return 2;
  // 4. Опечатка: слово от пяти знаков совпадает по одной правке (Левенштейн).
  if (needles.some((needle) => needle.length >= 5
    && haystems.some((hay) => hay !== needle && withinOneEdit(hay, needle)))) return 3;
  // 5. Остальное: все основы запроса встречаются среди слов названия.
  if (needles.every((needle) => haystems.some((hay) => hay.startsWith(needle.slice(0, Math.min(3, needle.length)))
    || hay.startsWith(needle)))) return 4;
  return null;
}

/**
 * Расстояние Левенштейна не больше одной правки.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function withinOneEdit(a, b) {
  if (a === b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    // Пропуск или замена двигают короткую строку, вставка — длинную.
    if (short.length === long.length) i += 1;
    j += 1;
  }
  return edits + (long.length - j) <= 1;
}