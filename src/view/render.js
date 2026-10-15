// Экранирование и сборка разметки.
//
// Безопасность шаблонов держится на одном решении: тег html экранирует всё,
// что в него подставляется. Свои строки — не исключение (R-SEC-10), поэтому
// чтобы вставить готовый фрагмент разметки, нужно явно сказать raw().

/** Экранирует текст для содержимого элемента. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Экранирует значение для атрибута.
 *
 * Отдельная функция, а не тот же esc: обратный слэш и пробел важны в
 * JavaScript-обработчиках вида onclick, и без их экранирования строка
 * «вырывается» из атрибута обратно в разметку.
 */
export function attr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Помечает строку как готовую разметку: экранироваться не будет.
 *
 * Идемпотентна: на вход уже готовый фрагмент — возвращается он же. Без
 * этого вложенный вызов тихо превращал разметку в строку «[object Object]»,
 * и страница отдавалась пустой при зелёных тестах вида «страница отвечает».
 */
export function raw(value) {
  if (isRaw(value)) return value;
  return { __raw: String(value ?? '') };
}

function isRaw(v) {
  return v && typeof v === 'object' && typeof v.__raw === 'string';
}

function render(v) {
  if (isRaw(v)) return v.__raw;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

/**
 * Шаблон разметки. Все подстановки экранируются.
 *
 * Массивы склеиваются подряд — это позволяет строить списки без обёрток.
 *
 * @example html`<p>${userText}</p>`  →  <p>&lt;b&gt;…&lt;/b&gt;</p>
 * @example html`<div>${raw(card)}</div>`
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return { __raw: out };
}

/**
 * Условный блок: ничего не выводит, если условие ложно.
 *
 * Третий аргумент — блок «иначе». Раньше он молча игнорировался, и места,
 * где он написан, выглядели недоделанными: подпись «описания пока нет» и
 * заглушка фона на странице сериала просто не появлялись.
 *
 * Возвращает готовую разметку, а не строку: результат подставляется в тег
 * html, и строка была бы экранирована повторно — вместе с разметкой внутри.
 *
 * @param {unknown} condition
 * @param {() => unknown} fn ветка «если»
 * @param {() => unknown} [otherwise] ветка «иначе»
 */
export function when(condition, fn, otherwise) {
  if (condition) return raw(render(fn()));
  if (otherwise) return raw(render(otherwise()));
  return raw('');
}