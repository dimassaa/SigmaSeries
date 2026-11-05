// S-34 — страница «Для вас».
// Спецификация: docs/01-product/features/M11-recommendations.md, F-11-01.
//
// Тот же ряд, что и на главной, вынесен в отдельный адрес: страницу можно
// открыть и вернуться, а «Не интересно» возвращает именно сюда (F-11-03 §3).
// Заголовок один, меняется только слово: «Для вас» — с причинами и кнопками,
// «Популярное» — без них (F-06-06 §19). Какую строку получит человек, решает
// источник данных — вид только подписывает заголовок.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';
import { posterList } from './seriesCards.js';

/**
 * @param {object} page
 * @param {string} page.locale
 * @param {{items: any[], personalized: boolean}} page.data готовая строка `data.forYou(userId)`
 * @param {string} [page.csrf] токен для кнопок «Не интересно»
 * @returns {{__raw: string}}
 */
export function forYouView({ locale, data, csrf = '' }) {
  // Строка без единой позиции — каталог кончился; страница объясняет это
  // текстом, а не пустой рамкой (F-11-01 §5: скрытая строка — тоже ответ).
  return html`
<section class="block block--foryou">
  <h1 class="block__title">${t(locale, data.personalized ? 'foryou.title' : 'home.foryou.popular')}</h1>
  ${when(data.items.length === 0, () => html`
  <p class="empty">${t(locale, 'foryou.empty')}</p>`)}
  ${when(data.items.length > 0, () =>
    posterList({ locale, items: data.items, csrf, back: `/${locale}/for-you` }))}
</section>`;
}
