// Таблицы стилей по экранам.
//
// Исходники лежат в `src/styles` и собраны в группы: страница подключает
// общую часть (`base`) и те группы, которые ей действительно нужны. Порядок
// групп совпадает с порядком файлов — иначе правила перестали бы перебивать
// друг друга не так, как задумано, и страница выглядела бы иначе в зависимости
// от того, какие группы подключены.
//
// Список групп — единственный источник правды: и сборщик
// (`tools/build-css.mjs`), и вёрстка (`src/view/layout.js`) берут его отсюда.

/**
 * @typedef {object} StyleGroup
 * @property {string} name имя группы: имя файла в `public/css`
 * @property {string[]} files файлы исходников группы
 */

/** @type {StyleGroup[]} */
export const STYLE_GROUPS = [
  // Общие блоки, сетка постеров и пустое состояние нужны не только главной,
  // но и каталогу, поиску, подборкам и регистрации — поэтому они в базе.
  { name: 'base', files: ['00-tokens.css', '10-base.css', '20-shell.css', '25-messages.css', '26-components.css'] },
  { name: 'identity', files: ['35-identity.css'] },
  { name: 'series', files: ['45-series.css'] },
  { name: 'catalogue', files: ['46-catalog.css'] },
  { name: 'search', files: ['47-search.css'] },
  { name: 'collection', files: ['48-collection.css'] },
  { name: 'calendar', files: ['49-calendar.css'] },
  { name: 'tracking', files: ['50-tracking.css'] },
  { name: 'notifications', files: ['51-notifications.css'] },
  {
    name: 'reviews',
    files: [
      '52-reviews.css',
      '53-review-list.css',
      '54-review-vote.css',
      '55-review-report.css',
      '56-review-page.css',
    ],
  },
  { name: 'moderation', files: ['57-moderation.css'] },
];

/** Имена групп в порядке следования: `base` — всегда первая. */
export const STYLE_ORDER = STYLE_GROUPS.map((group) => group.name);

/**
 * Группы для страницы: общая плюс запрошенные, в порядке следования.
 *
 * Запрошенная группа, которой нет, игнорируется — опечатка в списке не должна
 * оставлять страницу без стилей целиком: `base` подключается всегда.
 *
 * @param {string[]|null|undefined} wanted имена нужных групп
 * @returns {string[]} имена групп в порядке подключения
 */
export function styleGroups(wanted) {
  const asked = new Set(wanted ?? []);
  const groups = STYLE_ORDER.filter((name) => name === 'base' || asked.has(name));
  // Страница без списка получает всё: так ни один экран не останется без
  // стилей из-за забытого объявления.
  return wanted === undefined || wanted === null ? STYLE_ORDER : groups;
}
