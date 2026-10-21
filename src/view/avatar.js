// Инициалы для плашки аватара.
//
// Аватара как загруженной картинки в P0 нет (H-52), но плашка обязательна:
// пустое место в списке отметок выглядит как поломка.

/**
 * Две буквы ника для плашки аватара.
 *
 * @param {string|null|undefined} nickname
 * @returns {string}
 */
export function initialsOf(nickname) {
  const letters = String(nickname ?? '').replace(/[^\p{L}\p{N}]/gu, '');
  return (letters.slice(0, 2) || '?').toUpperCase();
}
