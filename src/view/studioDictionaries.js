// Справочники студии: жанры, платформы рейтингов, страны (S-80).
//
// Правка идёт по строке: форма под строкой, без отдельной страницы на
// каждую запись — справочник читают целиком, а не по одному ключу.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * @typedef {object} StudioGenre
 * @property {string} code
 * @property {string|null} nameRu
 * @property {string|null} nameEn
 * @property {boolean} active
 * @property {number} seriesCount
 * @property {boolean} raw сырой жанр импорта: правке не подлежит
 */

/**
 * @typedef {object} StudioPlatform
 * @property {string} code
 * @property {string} name
 * @property {number} scaleMax
 * @property {number} ratings
 * @property {boolean} active
 */

/**
 * @typedef {object} StudioCountry
 * @property {string} code
 * @property {string} title
 */

/**
 * Справочники.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {StudioGenre[]} [args.genres]
 * @param {StudioPlatform[]} [args.platforms]
 * @param {StudioCountry[]} [args.countries]
 * @param {string} [args.csrf]
 * @returns {any}
 */
export function studioDictionariesView({
  locale, genres = [], platforms = [], countries = [], csrf = '',
}) {
  return html`
<div class="studio">
  <h1 class="studio__title">${t(locale, 'studio.dictionaries.title')}</h1>
  <p class="studio__note">${t(locale, 'studio.dictionaries.note')}</p>

  <section class="studio__section">
    <h2 class="studio__section-title">${t(locale, 'studio.dictionaries.genres')}</h2>
    <table class="studio__table">
      <caption class="visually-hidden">${t(locale, 'studio.dictionaries.genres')}</caption>
      <thead>
        <tr>
          <th scope="col">${t(locale, 'studio.dictionaries.column.code')}</th>
          <th scope="col">${t(locale, 'studio.dictionaries.column.nameRu')}</th>
          <th scope="col">${t(locale, 'studio.dictionaries.column.nameEn')}</th>
          <th scope="col">${t(locale, 'studio.dictionaries.column.series')}</th>
          <th scope="col">${t(locale, 'studio.dictionaries.column.active')}</th>
        </tr>
      </thead>
      <tbody>
        ${genres.map((genre) => html`
        <tr class="studio__row">
          <th scope="row" class="studio__title-cell">
            <code>${genre.code}</code>
            ${when(genre.raw, () => html`
            <span class="studio__reason studio__reason--info">${t(locale, 'studio.dictionaries.raw')}</span>`)}
          </th>
          <td>${genre.nameRu ?? ''}</td>
          <td>${genre.nameEn ?? ''}</td>
          <td>${genre.seriesCount}</td>
          <td>${genre.active ? t(locale, 'studio.dictionaries.yes') : t(locale, 'studio.dictionaries.no')}</td>
        </tr>`)}
      </tbody>
    </table>

    <form class="studio-dictionary__form" method="post" action="/${locale}/admin/dictionaries">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="kind" value="genre">
      <h3 class="studio__subsection-title">${t(locale, 'studio.dictionaries.addGenre')}</h3>
      <label class="field__label" for="genre-code">${t(locale, 'studio.dictionaries.column.code')}</label>
      <input class="field__input" id="genre-code" name="code" type="text" pattern="[a-z0-9-]+" required>
      <label class="field__label" for="genre-ru">${t(locale, 'studio.dictionaries.column.nameRu')}</label>
      <input class="field__input" id="genre-ru" name="name_ru" type="text" maxlength="100" required>
      <label class="field__label" for="genre-en">${t(locale, 'studio.dictionaries.column.nameEn')}</label>
      <input class="field__input" id="genre-en" name="name_en" type="text" maxlength="100">
      <p class="studio-card__actions">
        <button class="button button--primary" type="submit">${t(locale, 'studio.dictionaries.save')}</button>
      </p>
    </form>
  </section>

  <section class="studio__section">
    <h2 class="studio__section-title">${t(locale, 'studio.dictionaries.platforms')}</h2>
    <table class="studio__table">
      <caption class="visually-hidden">${t(locale, 'studio.dictionaries.platforms')}</caption>
      <thead>
        <tr>
          <th scope="col">${t(locale, 'studio.dictionaries.column.code')}</th>
          <th scope="col">${t(locale, 'studio.dictionaries.column.name')}</th>
          <th scope="col">${t(locale, 'studio.dictionaries.column.scale')}</th>
          <th scope="col">${t(locale, 'studio.dictionaries.column.ratings')}</th>
          <th scope="col">${t(locale, 'studio.dictionaries.column.active')}</th>
        </tr>
      </thead>
      <tbody>
        ${platforms.map((platform) => html`
        <tr class="studio__row">
          <th scope="row" class="studio__title-cell"><code>${platform.code}</code></th>
          <td>${platform.name}</td>
          <td>0–${platform.scaleMax}</td>
          <td>${platform.ratings}</td>
          <td>${platform.active ? t(locale, 'studio.dictionaries.yes') : t(locale, 'studio.dictionaries.no')}</td>
        </tr>`)}
      </tbody>
    </table>

    <form class="studio-dictionary__form" method="post" action="/${locale}/admin/dictionaries">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="kind" value="platform">
      <h3 class="studio__subsection-title">${t(locale, 'studio.dictionaries.addPlatform')}</h3>
      <label class="field__label" for="platform-code">${t(locale, 'studio.dictionaries.column.code')}</label>
      <input class="field__input" id="platform-code" name="code" type="text" required>
      <label class="field__label" for="platform-name">${t(locale, 'studio.dictionaries.column.name')}</label>
      <input class="field__input" id="platform-name" name="name" type="text" maxlength="100" required>
      <label class="field__label" for="platform-scale">${t(locale, 'studio.dictionaries.column.scale')}</label>
      <input class="field__input" id="platform-scale" name="scale_max" type="number" step="0.1" min="1" value="10" required>
      <p class="studio-card__actions">
        <button class="button button--primary" type="submit">${t(locale, 'studio.dictionaries.save')}</button>
      </p>
    </form>
  </section>

  <section class="studio__section">
    <h2 class="studio__section-title">${t(locale, 'studio.dictionaries.countries')}</h2>
    <p class="studio__note">${t(locale, 'studio.dictionaries.countriesNote')}</p>
    <ul class="studio-countries" role="list">
      ${countries.map((country) => html`
      <li class="studio-countries__item"><code>${country.code}</code> ${country.title}</li>`)}
    </ul>
  </section>
</div>`;
}
