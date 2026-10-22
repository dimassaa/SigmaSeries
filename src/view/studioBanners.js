// «Выбор редакции» и предпросмотр баннеров (S-78, F-10-08).
//
// Экран показывает месяц с назначениями и предпросмотр трёх баннеров на
// выбранный день. Предпросмотр считает тот же отбор, что и главная, поэтому
// расходиться с ней он не может.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * Назначение «Выбор редакции» на день.
 *
 * @typedef {object} EditorialPick
 * @property {number} id
 * @property {string} day
 * @property {number} seriesId
 * @property {string} slug
 * @property {string} title
 * @property {string|null} note
 * @property {string|Date|null} setAt
 * @property {boolean} withdrawn сериал ушёл в архив
 * @property {boolean} noBackdrop у сериала нет фона
 */

/**
 * Баннер в предпросмотре.
 *
 * @typedef {object} BannerPreview
 * @property {string} kind
 * @property {number} seriesId
 * @property {string} slug
 * @property {string} title
 * @property {number|null} year
 * @property {number|null} imdb
 */

/**
 * Сериал, годный для баннера.
 *
 * @typedef {object} BannerCandidate
 * @property {number} id
 * @property {string} slug
 * @property {string} title
 * @property {number|null} year
 * @property {number|null} imdb
 */

/**
 * Экран баннеров.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {{year: number, month: number}} args.month
 * @param {Map<string, EditorialPick>} args.picks назначения по датам
 * @param {BannerPreview[]} [args.preview] три баннера на выбранный день
 * @param {BannerCandidate[]} [args.candidates] сериалы, годные для баннера
 * @param {string} args.date выбранный день
 * @param {string} [args.csrf]
 * @returns {object}
 */
export function studioBannersView({ locale, month, picks, preview = [], candidates = [], date, csrf = '' }) {
  const today = new Date().toISOString().slice(0, 10);
  return html`
<div class="studio studio--banners">
  <h1 class="studio__title">${t(locale, 'studio.banners.title')}</h1>
  <p class="studio__note">${t(locale, 'studio.banners.note')}</p>

  <div class="studio-banners">
    <section class="studio-banners__calendar" aria-labelledby="h-banners-calendar">
      <h2 class="studio__section-title" id="h-banners-calendar">
        ${t(locale, 'studio.banners.month', {
          month: t(locale, `studio.month.${month.month}`),
          year: month.year,
        })}
      </h2>
      <table class="studio-calendar">
        <caption class="visually-hidden">${t(locale, 'studio.banners.title')}</caption>
        <thead>
          <tr>
            ${['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((code) => html`
            <th scope="col" class="studio-calendar__weekday">${t(locale, `studio.weekday.${code}`)}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${calendarRows(month).map((week) => html`
          <tr>
            ${week.map((day) => {
              if (!day) return html`<td class="studio-calendar__cell studio-calendar__cell--empty"></td>`;
              const pick = picks.get(day);
              const broken = pick && (pick.withdrawn || pick.noBackdrop);
              return html`
              <td class="studio-calendar__cell${day === date ? ' is-current' : ''}${broken ? ' is-broken' : ''}">
                <a class="studio-calendar__day" href="/${locale}/admin/banners?date=${day}&month=${month.month}&year=${month.year}">
                  <span class="studio-calendar__number">${Number(day.slice(-2))}</span>
                  ${when(pick, () => html`
                  <span class="studio-calendar__pick" title="${pick.title}">${pick.title}</span>`)}
                  ${when(!pick, () => html`<span class="studio-calendar__auto">${t(locale, 'studio.banners.auto')}</span>`)}
                </a>
              </td>`;
            })}
          </tr>`)}
        </tbody>
      </table>
    </section>

    <section class="studio-banners__side">
      <h2 class="studio__section-title">${t(locale, 'studio.banners.preview', { date })}</h2>
      <ul class="studio-preview" role="list">
        ${preview.map((banner) => html`
        <li class="studio-preview__item">
          <span class="studio-preview__reason">${t(locale, `home.banners.reason.${banner.kind}`)}</span>
          <span class="studio-preview__title">${banner.title}</span>
          <span class="studio-preview__meta">${banner.year ?? ''}${banner.imdb !== null ? ` · IMDb ${String(banner.imdb).replace('.', ',')}` : ''}</span>
        </li>`)}
      </ul>
      ${when(preview.length === 0, () => html`
      <p class="empty">${t(locale, 'studio.banners.previewEmpty')}</p>`)}

      <h2 class="studio__section-title">${t(locale, 'studio.banners.assign', { date })}</h2>
      <form class="studio-banners__form" method="post" action="/${locale}/admin/banners">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="date" value="${date}">
        <label class="field__label" for="banners-series">${t(locale, 'studio.banners.series')}</label>
        <select class="field__input" id="banners-series" name="series_id" required>
          <option value="">${t(locale, 'studio.banners.choose')}</option>
          ${candidates.map((candidate) => html`
          <option value="${candidate.id}" ${String(candidate.id) === String(picks.get(date)?.seriesId ?? '') ? 'selected' : ''}>
            ${candidate.title} (${candidate.year ?? '—'})${candidate.imdb !== null ? ` · IMDb ${String(candidate.imdb).replace('.', ',')}` : ''}
          </option>`)}
        </select>
        <label class="field__label" for="banners-note">${t(locale, 'studio.banners.note2')}</label>
        <input class="field__input" id="banners-note" name="note" type="text" maxlength="200">
        <p class="studio-banners__actions">
          <button class="button button--primary" type="submit">${t(locale, 'studio.banners.save')}</button>
        </p>
      </form>

      ${when(picks.get(date), () => html`
      <form class="studio-banners__form" method="post" action="/${locale}/admin/banners/clear">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="date" value="${date}">
        <button class="button" type="submit">${t(locale, 'studio.banners.clear')}</button>
      </form>`)}
    </section>
  </div>
</div>`;
}

/**
 * Недели месяца: каждая — семь ячеек, первые и последние пустые.
 *
 * @param {{year: number, month: number}} month
 * @returns {string[][]}
 */
function calendarRows(month) {
  const first = new Date(Date.UTC(month.year, month.month - 1, 1));
  const days = new Date(Date.UTC(month.year, month.month, 0)).getUTCDate();
  // Неделя начинается с понедельника: день недели в UTC, понедельник — 1.
  const offset = (first.getUTCDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < offset; i += 1) cells.push(null);
  for (let day = 1; day <= days; day += 1) {
    cells.push(`${month.year}-${String(month.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
