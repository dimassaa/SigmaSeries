// Карточка ряда «Для вас»: постер, причина и «Не интересно» (M11).
//
// Одна и та же карточка работает на главной (S-01) и на отдельной странице
// /for-you (S-34). Разметка описана один раз, чтобы формулировка причины и
// скрывающая кнопка не разъезжались между двумя адресами: у многих постеров
// причина приходит прямо в данных, а кнопка обязана вернуть на ту страницу,
// где её нажали — адрес этот и есть `back`.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * Адрес картинки.
 *
 * Собирается в представлении: адрес содержит локали, а источник данных о ней
 * не знает (ADR-003). Роль и ширину источник отдаёт готовыми.
 */
const imageUrl = (locale, slug, role, width) => (width ? `/${locale}/images/${slug}/${role}-${width}.webp` : null);

/**
 * Причина рекомендации — текстом интерфейса (M11 §11).
 *
 * Название сериала или жанра — данные каталога, они на двух языках; сама
 * формулировка причины переводима.
 *
 * @param {string} locale
 * @param {{kind: string, titleRu: string, titleEn: string}} reason
 * @returns {string}
 */
function reasonText(locale, reason) {
  const title = locale === 'en' ? reason.titleEn : reason.titleRu;
  if (reason.kind === 'like') return t(locale, 'reco.reason.like', { title });
  if (reason.kind === 'genre') return t(locale, 'reco.reason.genre', { title });
  return t(locale, 'reco.reason.marked', { title });
}

/**
 * Ряд постеров с причинами: самой страницы или строки главной.
 *
 * Кнопка «Не интересно» есть только у карточек с причиной: популярное скрыть
 * нельзя — оно одинаково для всех, скрывать нечего (F-11-03 §3).
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {any[]} args.items позиции с готовой причиной
 * @param {string} [args.csrf] токен формы «Не интересно»; у гостя форм нет
 * @param {string} [args.back] адрес возврата после скрытия
 * @returns {{__raw: string}}
 */
export function posterList({ locale, items, csrf = '', back = `/${locale}/` }) {
  return html`<ol class="posters" role="list">
    ${items.map((s) => html`
    <li class="posters__item">
      <a class="poster" href="/${locale}/series/${s.slug}" data-poster-card="${s.slug}" data-poster-info="${t(locale, 'poster.card.info')}"
         data-track-impression="reco_impression" data-track-click="reco_click"
         aria-label="${t(locale, 'home.fresh.itemLabel', { title: s.title, year: s.year })}">
        <span class="poster__frame">
          ${when(s.posterWidth, () => html`<img class="poster__img" src="${imageUrl(locale, s.slug, 'poster', s.posterWidth)}"
             alt="" width="185" height="278" loading="lazy" decoding="async">`)}
          ${when(!s.posterWidth, () => html`<span class="poster__fallback" aria-hidden="true"></span>`)}
        </span>
        <span class="poster__title">${s.title}</span>
        ${when(s.reason, () => html`
        <span class="poster__reason">${reasonText(locale, s.reason)}</span>`)}
        <span class="poster__meta">${s.year}</span>
      </a>
      ${when(s.reason, () => html`
      <form class="posters__dismiss" method="post" action="/${locale}/reco/dismiss">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="series" value="${s.slug}">
        <input type="hidden" name="back" value="${back}">
        <button class="button button--quiet" type="submit" data-track-click="reco_dismiss"
          >${t(locale, 'reco.dismiss')}</button>
      </form>`)}
    </li>`)}
  </ol>`;
}
