// Режим `devbox` и демо-помощник (F-01-12 §4, §8(в), H-51).
//
// В режиме `devbox` письмо не уходит провайдеру: оно остаётся в `e_mail` и
// показывается в интерфейсе. Это единственный способ показать регистрацию без
// интернета — на защите именно так и будет.
//
// Демо-помощник показывает человеку только то письмо, которое создал его же
// браузер: иначе это был бы способ читать чужие письма, а «помощник» стоял
// бы рядом со страницей входа.

/**
 * Текст предупреждения о режиме (EC-A23).
 *
 * @param {string} mode
 * @returns {string|null} null в обычном режиме
 */
export function devboxBadge(mode) {
  if (mode !== 'devbox') return null;
  return 'Письма не отправляются: режим devbox';
}

/**
 * Письмо этого браузера для демо-помощника (H-51).
 *
 * Берётся последнее: человек обычно ждёт именно свежее, а старое могло быть
 * уже применено.
 *
 * @param {Array<{browserId:string, kind:string, token:string, createdAt?:string}>} letters
 * @param {string} browserId отметка браузера из подписанной cookie
 * @returns {object|null}
 */
export function demoMailFor(letters, browserId) {
  if (!browserId) return null;
  const mine = (letters ?? []).filter((letter) => letter.browserId === browserId);
  return mine.length ? mine[mine.length - 1] : null;
}

/**
 * Ссылка для вставки в письмо из `e_mail.body`.
 *
 * Берётся из тела письма, а не из отдельного столбца: токен живёт внутри
 * ссылки один раз, и второй столбец с ним был бы вторым местом, где он лежит.
 *
 * Понимаются и относительные ссылки: без `baseUrl` в окружении письмо
 * собирается с адресом вида `/ru/verify?token=…`, и в демо-режиме такая
 * ссылка работает — браузер откроет её относительно текущего адреса.
 *
 * @param {string} body
 * @returns {string|null}
 */
export function linkFromBody(body) {
  const match = String(body ?? '').match(/(?:https?:\/\/|\/)\S+/);
  return match ? match[0].replace(/[.,)\]]+$/, '') : null;
}