// Карточка сериала в студии (S-75, F-10-03).
//
// Рядом с каждым полем — откуда его значение: «из импорта» или «вручную».
// Ручное значение закрыто от перезаписи импортом, и рядом же кнопка «вернуть
// как было в импорте» (F-10-03 §8а). Справа — панель полноты: уровень,
// причины и то, куда сериал можно поставить.
//
// Форм на странице несколько, и ни одна не вложена в другую: HTML этого не
// допускает — браузер выбрасывает тег внутренней формы, её поля приклеиваются
// к внешней форме, и в теле запроса появляются два поля csrf. Тогда проверка
// CSRF видит не строку, а массив, и любое сохранение уходит в «сессия
// устарела». Поэтому кнопки, которые делают другое действие, живут в своей
// форме, а кнопки внутри формы правки задают formaction.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/** Вкладки карточки. */
const TABS = [
  { id: 'primary', title: 'studio.card.tab.primary' },
  { id: 'texts', title: 'studio.card.tab.texts' },
  { id: 'genres', title: 'studio.card.tab.genres' },
  { id: 'ratings', title: 'studio.card.tab.ratings' },
  { id: 'schedule', title: 'studio.card.tab.schedule' },
  { id: 'images', title: 'studio.card.tab.images' },
  { id: 'service', title: 'studio.card.tab.service' },
];

/** Вкладки, на которых редактируются поля карточки. */
const FIELD_TABS = ['primary', 'texts', 'genres'];

/**
 * Дата для поля формы.
 *
 * @param {Date|string|null} value
 * @returns {string}
 */
function dayOf(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  // Дата выхода — местная: база отдаёт её в поясе сервера, а UTC сдвинул бы
  // её на день назад.
  const text = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  // 1900-01-01 — это «дата снята», а не настоящая дата выхода.
  return text.startsWith('1900') ? '' : text;
}

/**
 * Поле формы с происхождением.
 *
 * @param {object} args
 * @returns {string}
 */
function field({ locale, card, name, label, type = 'text', value = '', rows = null, hint = '' }) {
  const manual = card.origins[name] === 'manual';
  const id = `f-${name}`;
  return html`
  <span class="studio-field">
    <label class="field__label" for="${id}">${t(locale, label)}</label>
    ${rows
      ? html`<textarea class="field__input" id="${id}" name="f_${name}" rows="${rows}">${value}</textarea>`
      : html`<input class="field__input" id="${id}" name="f_${name}" type="${type}" value="${value}">`}
    <span class="studio-field__origin">
      ${manual
        ? html`<span class="studio-origin studio-origin--manual">${t(locale, 'studio.card.origin.manual')}</span>`
        : html`<span class="studio-origin">${t(locale, 'studio.card.origin.import')}</span>`}
      ${when(manual, () => html`
      <button class="button button--quiet studio-field__reset" type="submit"
        name="field" value="${name}"
        formaction="/${locale}/admin/catalog/${card.id}/reset-field">${t(locale, 'studio.card.reset')}</button>`)}
    </span>
    ${when(hint, () => html`<span class="studio-field__hint">${hint}</span>`)}
  </span>`;
}

/**
 * Экран карточки.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.card
 * @param {object[]} args.history
 * @param {string} args.tab
 * @param {string} args.csrf
 * @returns {string}
 */
export function studioCardView({
  locale, card, history = [], genres = [], schedule = [], images = [],
  tab = 'primary', csrf = '',
}) {
  const cardWith = { ...card, csrf };
  const saveAction = `/${locale}/admin/catalog/${card.id}`;
  return html`
<div class="studio studio--card">
  <h1 class="studio__title">${card.fields.title_ru || card.fields.title_original}</h1>
  <p class="studio__note">
    ${t(locale, `studio.publication.${card.publicationState}`)} ·
    ${t(locale, `studio.exit.${card.fields.exit_state}`)} ·
    ${t(locale, `studio.level.${card.level}`)} ·
    ${card.version !== undefined ? t(locale, 'studio.card.version', { version: card.version }) : ''}
  </p>

  <nav class="studio-tabs" aria-label="${t(locale, 'studio.card.tabs')}">
    ${TABS.map((item) => html`
    <a class="studio-tabs__tab${item.id === tab ? ' is-current' : ''}"
       href="/${locale}/admin/catalog/${card.id}?tab=${item.id}"
       ${item.id === tab ? 'aria-current="page"' : ''}>${t(locale, item.title)}</a>`)}
  </nav>

  <div class="studio-card">
    ${when(FIELD_TABS.includes(tab), () => html`
    <form class="studio-card__form" method="post" action="${saveAction}">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="version" value="${card.version}">

      ${when(tab === 'primary', () => html`
      <section class="studio-card__section">
        <h2 class="studio__section-title">${t(locale, 'studio.card.tab.primary')}</h2>
        ${field({ locale, card: cardWith, name: 'title_ru', label: 'studio.card.titleRu', value: card.fields.title_ru })}
        ${field({ locale, card: cardWith, name: 'title_en', label: 'studio.card.titleEn', value: card.fields.title_en })}
        ${field({ locale, card: cardWith, name: 'title_original', label: 'studio.card.titleOriginal', value: card.fields.title_original })}
        ${field({ locale, card: cardWith, name: 'year_start', label: 'studio.card.yearStart', type: 'number', value: card.fields.year_start })}
        ${field({ locale, card: cardWith, name: 'year_end', label: 'studio.card.yearEnd', type: 'number', value: card.fields.year_end })}
        ${field({ locale, card: cardWith, name: 'slug', label: 'studio.card.slug', value: card.fields.slug })}
      </section>`)}

      ${when(tab === 'texts', () => html`
      <section class="studio-card__section">
        <h2 class="studio__section-title">${t(locale, 'studio.card.tab.texts')}</h2>
        ${field({ locale, card: cardWith, name: 'description_ru', label: 'studio.card.descriptionRu', value: card.fields.description_ru, rows: 10 })}
        ${field({ locale, card: cardWith, name: 'description_en', label: 'studio.card.descriptionEn', value: card.fields.description_en, rows: 10 })}
      </section>`)}

      ${when(tab === 'genres', () => html`
      <section class="studio-card__section">
        <h2 class="studio__section-title">${t(locale, 'studio.card.tab.genres')}</h2>
        <p class="studio-card__note">${t(locale, 'studio.card.genresNote')}</p>
        <div class="studio-genres">
          ${genres.map((genre) => html`
          <label class="studio-genres__item">
            <input type="checkbox" name="genres" value="${genre.code}"
              ${card.genres.includes(genre.code) ? 'checked' : ''}>
            <span>${genre.title}</span>
          </label>`)}
        </div>
      </section>`)}

      <p class="studio-card__actions">
        <button class="button button--primary" type="submit">${t(locale, 'studio.card.save')}</button>
      </p>
    </form>`)}

    ${when(tab === 'ratings', () => html`
    <section class="studio-card__section">
      <h2 class="studio__section-title">${t(locale, 'studio.card.tab.ratings')}</h2>
      <dl class="studio-facts">
        <dt>IMDb</dt>
        <dd>${card.imdb !== null ? String(card.imdb).replace('.', ',') : '—'}
          ${when(card.imdbVotes !== null && card.imdbVotes !== undefined, () => html`<span class="studio-facts__note">${card.imdbVotes}</span>`)}
          ${when(card.measuredOn, () => html`<span class="studio-facts__note">${String(card.measuredOn).slice(0, 10)}</span>`)}
        </dd>
        <dt>${t(locale, 'studio.card.imdbKey')}</dt>
        <dd>${card.imdbKey ?? '—'}</dd>
        <dt>TMDB</dt>
        <dd>${card.tmdbId ?? '—'}</dd>
      </dl>
      <p class="studio-card__note">${t(locale, 'studio.card.ratingsNote')}</p>
    </section>`)}

    ${when(tab === 'schedule', () => html`
    <section class="studio-card__section">
      <h2 class="studio__section-title">${t(locale, 'studio.card.tab.schedule')}</h2>
      ${when(!schedule || schedule.length === 0, () => html`
      <p class="empty">${t(locale, 'studio.card.scheduleEmpty')}</p>`)}
      ${when(schedule && schedule.length > 0, () => html`
      ${schedule.map((season) => html`
      <div class="studio-season">
        <h3 class="studio__subsection-title">${t(locale, 'studio.card.season', { number: season.number })}</h3>
        <table class="studio__table">
          <thead>
            <tr>
              <th scope="col">${t(locale, 'studio.card.episode')}</th>
              <th scope="col">${t(locale, 'studio.card.date')}</th>
              <th scope="col">${t(locale, 'studio.card.state')}</th>
            </tr>
          </thead>
          <tbody>
            ${season.episodes.map((episode) => html`
            <tr class="studio__row">
              <th scope="row" class="studio__title-cell">
                ${t(locale, 'studio.card.episodeNumber', { number: episode.number })}
                ${when(episode.locked, () => html`
                <span class="studio__origin studio-origin--manual">${t(locale, 'studio.card.locked')}</span>`)}
              </th>
              <td>
                <form class="studio-inline-form" method="post"
                      action="/${locale}/admin/catalog/${card.id}/schedule">
                  <input type="hidden" name="csrf" value="${csrf}">
                  <input type="hidden" name="season_id" value="${season.id}">
                  <input type="hidden" name="episode_id" value="${episode.id}">
                  <input class="field__input" type="date" name="date"
                    value="${dayOf(episode.date)}">
                  <button class="button button--quiet" type="submit">${t(locale, 'studio.card.saveDate')}</button>
                </form>
              </td>
              <td>${episode.state ? t(locale, `studio.release.${episode.state}`) : '—'}</td>
            </tr>`)}
          </tbody>
        </table>
      </div>`)}`)}
    </section>`)}

    ${when(tab === 'service', () => html`
    <section class="studio-card__section">
      <h2 class="studio__section-title">${t(locale, 'studio.card.tab.service')}</h2>

      <form class="studio-card__actions" method="post" action="${saveAction}">
        <input type="hidden" name="csrf" value="${csrf}">
        ${when(card.publicationState !== 'published', () => html`
        <button class="button button--primary" type="submit" formaction="${saveAction}/publish"
          ${when(card.publishBlockers.length, () => 'disabled')}>
          ${t(locale, 'studio.card.publish')}
        </button>`)}
        ${when(card.publicationState === 'published' && !card.archived, () => html`
        <button class="button" type="submit" formaction="${saveAction}/archive">
          ${t(locale, 'studio.card.archive')}
        </button>`)}
        ${when(card.archived, () => html`
        <button class="button" type="submit" formaction="${saveAction}/restore">
          ${t(locale, 'studio.card.restore')}
        </button>`)}
      </form>

      ${when(card.publishBlockers.length, () => html`
      <p class="studio-card__blockers">
        ${t(locale, 'studio.card.publishBlockers')}: ${card.publishBlockers.join(', ')}
      </p>`)}

      <h3 class="studio__subsection-title">${t(locale, 'studio.card.dependencies')}</h3>
      <dl class="studio-facts">
        <dt>${t(locale, 'studio.card.dep.banners')}</dt><dd>${card.dependencies.banners}</dd>
        <dt>${t(locale, 'studio.card.dep.collections')}</dt><dd>${card.dependencies.collections}</dd>
        <dt>${t(locale, 'studio.card.dep.watchers')}</dt><dd>${card.dependencies.watchers}</dd>
        <dt>${t(locale, 'studio.card.dep.marks')}</dt><dd>${card.dependencies.marks}</dd>
        <dt>${t(locale, 'studio.card.dep.reviews')}</dt><dd>${card.dependencies.reviews}</dd>
        <dt>${t(locale, 'studio.card.dep.ratings')}</dt><dd>${card.dependencies.ratings}</dd>
        <dt>${t(locale, 'studio.card.dep.releases')}</dt><dd>${card.dependencies.releases}</dd>
      </dl>

      <h3 class="studio__subsection-title">${t(locale, 'studio.card.history')}</h3>
      ${when(history.length, () => html`
      <ul class="studio-history" role="list">
        ${history.map((item) => html`
        <li class="studio-history__item">
          <span class="studio-history__action">
            ${t(locale, item.source === 'manual' ? 'studio.card.history.manual' : 'studio.card.history.import')}
            · ${t(locale, 'studio.card.version', { version: item.version })}
          </span>
          <span class="studio-history__actor">${item.actor ?? '—'}</span>
          <span class="studio-history__at">${String(item.at).slice(0, 16).replace('T', ' ')}</span>
          ${when(Object.keys(item.diff ?? {}).length, () => html`
          <span class="studio-history__reason">${Object.keys(item.diff).join(', ')}</span>`)}
          ${when(Object.keys(item.diff ?? {}).length, () => html`
          <form class="studio-history__restore" method="post"
                action="/${locale}/admin/catalog/${card.id}/versions/${item.version}/restore"
                data-confirm="${t(locale, 'studio.card.restoreConfirm')}">
            <input type="hidden" name="csrf" value="${csrf}">
            <button class="button button--quiet" type="submit">${t(locale, 'studio.card.restore')}</button>
          </form>`)}
        </li>`)}
      </ul>`, () => html`<p class="empty">${t(locale, 'studio.card.historyEmpty')}</p>`)}
    </section>`)}

    ${when(tab === 'images', () => html`
    <section class="studio-card__section">
      <h2 class="studio__section-title">${t(locale, 'studio.card.tab.images')}</h2>

      <form class="studio-image__upload" method="post" enctype="multipart/form-data"
            action="/${locale}/admin/catalog/${card.id}/images">
        <input type="hidden" name="csrf" value="${csrf}">
        <label class="field__label" for="image-role">${t(locale, 'studio.card.imageRole')}</label>
        <select class="field__input" id="image-role" name="role">
          <option value="poster">${t(locale, 'studio.card.image.poster')}</option>
          <option value="backdrop">${t(locale, 'studio.card.image.backdrop')}</option>
          <option value="banner">${t(locale, 'studio.card.image.banner')}</option>
          <option value="splash">${t(locale, 'studio.card.image.splash')}</option>
        </select>
        <label class="field__label" for="image-file">${t(locale, 'studio.card.imageFile')}</label>
        <input class="field__input" id="image-file" name="file" type="file"
          accept="image/jpeg,image/png,image/webp" required>
        <label class="studio-field__origin">
          <input type="checkbox" name="has_text" value="1">
          <span>${t(locale, 'studio.card.imageHasText')}</span>
        </label>
        <p class="studio-image__actions">
          <button class="button button--primary" type="submit">${t(locale, 'studio.card.upload')}</button>
        </p>
        <p class="studio-card__note">${t(locale, 'studio.card.uploadNote')}</p>
      </form>
      ${when(!images || images.length === 0, () => html`
      <p class="empty">${t(locale, 'studio.card.imagesEmpty')}</p>`)}
      ${when(images && images.length > 0, () => html`
      ${images.map((image) => html`
      <div class="studio-image">
        <div class="studio-image__preview">
          <img class="studio-image__frame" alt=""
               src="/${locale}/images/${card.slug}/${image.role}-${image.variantWidth ?? image.width}.webp"
               style="object-position: ${image.focalX}% ${image.focalY}%">
          <span class="studio-image__point"
            style="inset-inline-start: ${image.focalX}%; inset-block-start: ${image.focalY}%"></span>
        </div>
        <form class="studio-image__form" method="post"
              action="/${locale}/admin/catalog/${card.id}/images/focal">
          <input type="hidden" name="csrf" value="${csrf}">
          <input type="hidden" name="role" value="${image.role}">
          <span class="studio-image__name">
            ${t(locale, `studio.card.image.${image.role}`)} · ${image.width}×${image.height}
          </span>
          <label class="field__label" for="focal-x-${image.id}">${t(locale, 'studio.card.focalX')}</label>
          <input class="field__input" id="focal-x-${image.id}" name="focal_x" type="number"
            min="0" max="100" value="${image.focalX}">
          <label class="field__label" for="focal-y-${image.id}">${t(locale, 'studio.card.focalY')}</label>
          <input class="field__input" id="focal-y-${image.id}" name="focal_y" type="number"
            min="0" max="100" value="${image.focalY}">
          <p class="studio-image__actions">
            <button class="button button--primary" type="submit">${t(locale, 'studio.card.saveFocal')}</button>
            <button class="button" type="submit" name="reset" value="1"
              formaction="/${locale}/admin/catalog/${card.id}/images/focal/reset">${t(locale, 'studio.card.resetFocal')}</button>
          </p>
        </form>
      </div>`)}`)}
    </section>`)}

    <aside class="studio-card__panel" aria-labelledby="h-card-panel">
      <h2 class="studio__section-title" id="h-card-panel">${t(locale, 'studio.card.panel')}</h2>
      <p class="studio-panel__level">
        <span class="studio__level studio__level--${card.level}">${t(locale, `studio.level.${card.level}`)}</span>
      </p>
      <p class="studio-panel__reasons">
        ${when(card.reasons.length, () => html`
        ${card.reasons.map((reason) => html`
        <span class="studio__reason studio__reason--info">${reason}</span>`)}`,
        () => html`<span class="studio-panel__empty">${t(locale, 'studio.card.noReasons')}</span>`)}
      </p>
      <h3 class="studio__subsection-title">${t(locale, 'studio.card.placement')}</h3>
      <p class="studio-panel__places">
        ${when(!card.reasons.includes('no_backdrop'), () => html`<span class="studio__place">${t(locale, 'studio.place.banner')}</span>`)}
        ${when(!card.reasons.includes('schedule_gap'), () => html`<span class="studio__place">${t(locale, 'studio.place.calendar')}</span>`)}
      </p>
      <h3 class="studio__subsection-title">${t(locale, 'studio.card.mini')}</h3>
      <p class="studio-panel__mini">
        <span class="studio-panel__mini-title">${card.fields.title_ru || card.fields.title_original}</span>
        <span class="studio-panel__mini-meta">${card.fields.year_start ?? ''}</span>
      </p>
    </aside>
  </div>
</div>`;
}
