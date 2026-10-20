// Подборки студии: список (S-77) и правка одной подборки.
//
// Порядок сериалов задаётся кнопками, а не только перетаскиванием: без
// кнопок порядок нельзя было бы изменить с клавиатуры (R-A11Y-09).

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * Список подборок.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object[]} args.list
 * @returns {string}
 */
export function studioCollectionsView({ locale, list = [] }) {
  return html`
<div class="studio">
  <h1 class="studio__title">${t(locale, 'studio.collections.title')}</h1>
  <p class="studio__note">${t(locale, 'studio.collections.note')}</p>

  ${when(list.length === 0, () => html`
  <p class="empty">${t(locale, 'studio.collections.empty')}</p>`)}

  ${when(list.length > 0, () => html`
  <table class="studio__table">
    <caption class="visually-hidden">${t(locale, 'studio.collections.title')}</caption>
    <thead>
      <tr>
        <th scope="col">${t(locale, 'studio.collections.column.title')}</th>
        <th scope="col">${t(locale, 'studio.collections.column.series')}</th>
        <th scope="col">${t(locale, 'studio.collections.column.weight')}</th>
        <th scope="col">${t(locale, 'studio.collections.column.visibility')}</th>
        <th scope="col">${t(locale, 'studio.collections.column.state')}</th>
      </tr>
    </thead>
    <tbody>
      ${list.map((item) => html`
      <tr class="studio__row">
        <th scope="row" class="studio__title-cell">
          <a class="studio__title-link" href="/${locale}/admin/collections/${item.slug}">${item.title}</a>
          <span class="studio__original">/${item.slug}</span>
        </th>
        <td>${item.visibleSeries} / ${item.totalSeries}</td>
        <td>${item.weight}</td>
        <td>${item.active ? t(locale, 'studio.collections.visible') : t(locale, 'studio.collections.hidden')}</td>
        <td>
          ${when(item.publishBlockers.length, () => html`
          <span class="studio__reason studio__reason--warning">${item.publishBlockers.join(', ')}</span>`,
          () => html`<span class="studio__state studio__state--published">${t(locale, 'studio.collections.ready')}</span>`)}
        </td>
      </tr>`)}
    </tbody>
  </table>`)}
</div>`;
}

/**
 * Правка подборки.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.collection
 * @param {string} args.csrf
 * @returns {string}
 */
export function studioCollectionView({ locale, collection, csrf = '' }) {
  return html`
<div class="studio">
  <h1 class="studio__title">${collection.title}</h1>
  <p class="studio__note">
    ${t(locale, 'studio.collections.seriesCount', { count: collection.visibleSeries })} ·
    ${collection.publishBlockers.length
      ? t(locale, 'studio.collections.blocked')
      : t(locale, 'studio.collections.ready')}
  </p>

  <form class="studio-card__form" method="post" action="/${locale}/admin/collections/${collection.slug}">
    <input type="hidden" name="csrf" value="${csrf}">

    <label class="field__label" for="collection-title">${t(locale, 'studio.collections.column.title')}</label>
    <input class="field__input" id="collection-title" name="title_ru" type="text" maxlength="100"
      value="${collection.title}" required>

    <label class="field__label" for="collection-title-en">${t(locale, 'studio.collections.titleEn')}</label>
    <input class="field__input" id="collection-title-en" name="title_en" type="text" maxlength="100"
      value="${collection.titleEn ?? ''}">

    <label class="field__label" for="collection-description">${t(locale, 'studio.collections.description')}</label>
    <textarea class="field__input" id="collection-description" name="description_ru" rows="3"
      maxlength="500">${collection.description ?? ''}</textarea>

    <label class="field__label" for="collection-description-en">${t(locale, 'studio.collections.descriptionEn')}</label>
    <textarea class="field__input" id="collection-description-en" name="description_en" rows="3"
      maxlength="500">${collection.descriptionEn ?? ''}</textarea>

    <label class="field__label" for="collection-weight">${t(locale, 'studio.collections.column.weight')}</label>
    <input class="field__input" id="collection-weight" name="weight" type="number" min="0" max="999"
      value="${collection.weight}">

    <label class="studio-field__origin">
      <input type="checkbox" name="active" value="1" ${collection.active ? 'checked' : ''}>
      <span>${t(locale, 'studio.collections.visible')}</span>
    </label>

    <input type="hidden" name="series_ids"
      value="${collection.items.map((item) => item.seriesId).join(',')}">

    <p class="studio-card__actions">
      <button class="button button--primary" type="submit">${t(locale, 'studio.collections.save')}</button>
    </p>
  </form>

  <section class="studio__section">
    <h2 class="studio__section-title">${t(locale, 'studio.collections.series')}</h2>
    ${when(collection.items.length === 0, () => html`
    <p class="empty">${t(locale, 'studio.collections.noSeries')}</p>`)}
    <ol class="studio-series-list" role="list">
      ${collection.items.map((item, index) => html`
      <li class="studio-series-list__item">
        <span class="studio-series-list__title">
          ${item.title}
          ${when(!item.visible, () => html`
          <span class="studio__reason studio__reason--warning">${t(locale, 'studio.collections.withdrawn')}</span>`)}
        </span>
        <span class="studio-series-list__order">
          <form class="studio-series-list__buttons" method="post"
                action="/${locale}/admin/collections/${collection.slug}/order">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="series_id" value="${item.seriesId}">
            <button class="button button--quiet" type="submit" name="where" value="up"
              ${index === 0 ? 'disabled' : ''}>${t(locale, 'studio.collections.up')}</button>
            <button class="button button--quiet" type="submit" name="where" value="down"
              ${index === collection.items.length - 1 ? 'disabled' : ''}>${t(locale, 'studio.collections.down')}</button>
            <button class="button button--quiet" type="submit" name="where" value="first"
              ${index === 0 ? 'disabled' : ''}>${t(locale, 'studio.collections.first')}</button>
            <button class="button button--quiet" type="submit" name="where" value="last"
              ${index === collection.items.length - 1 ? 'disabled' : ''}>${t(locale, 'studio.collections.last')}</button>
          </form>
        </span>
      </li>`)}
    </ol>
  </section>
</div>`;
}
