// Карточка сериала в студии (S-75, F-10-03).
//
// Рядом с каждым полем — откуда его значение: «из импорта» или «вручную».
// Ручное значение закрыто от перезаписи импортом, и рядом же кнопка «вернуть
// как было в импорте» (F-10-03 §8а). Справа — панель полноты: уровень,
// причины и то, куда сериал можно поставить.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/** Вкладки карточки. */
const TABS = [
  { id: 'primary', title: 'studio.card.tab.primary' },
  { id: 'texts', title: 'studio.card.tab.texts' },
  { id: 'genres', title: 'studio.card.tab.genres' },
  { id: 'ratings', title: 'studio.card.tab.ratings' },
  { id: 'service', title: 'studio.card.tab.service' },
];

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
      <form class="studio-field__reset" method="post" action="/${locale}/admin/catalog/${card.id}/reset-field">
        <input type="hidden" name="csrf" value="${card.csrf}">
        <input type="hidden" name="field" value="${name}">
        <button class="button button--quiet" type="submit">${t(locale, 'studio.card.reset')}</button>
      </form>`)}
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
export function studioCardView({ locale, card, history = [], genres = [], tab = 'primary', csrf = '' }) {
  const cardWith = { ...card, csrf };
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
    <form class="studio-card__form" method="post" action="/${locale}/admin/catalog/${card.id}">
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

      ${when(tab === 'service', () => html`
      <section class="studio-card__section">
        <h2 class="studio__section-title">${t(locale, 'studio.card.tab.service')}</h2>

        <p class="studio-card__actions">
          ${when(card.publicationState !== 'published', () => html`
          <button class="button button--primary" type="submit" formaction="/${locale}/admin/catalog/${card.id}/publish"
            ${when(card.publishBlockers.length, () => 'disabled')}>
            ${t(locale, 'studio.card.publish')}
          </button>`)}
          ${when(card.publicationState === 'published' && !card.archived, () => html`
          <button class="button" type="submit" formaction="/${locale}/admin/catalog/${card.id}/archive">
            ${t(locale, 'studio.card.archive')}
          </button>`)}
          ${when(card.archived, () => html`
          <button class="button" type="submit" formaction="/${locale}/admin/catalog/${card.id}/restore">
            ${t(locale, 'studio.card.restore')}
          </button>`)}
        </p>

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
            <span class="studio-history__action">${item.action}</span>
            <span class="studio-history__actor">${item.actor ?? '—'}</span>
            <span class="studio-history__at">${String(item.at).slice(0, 16).replace('T', ' ')}</span>
            ${when(item.reason, () => html`<span class="studio-history__reason">${item.reason}</span>`)}
          </li>`)}
        </ul>`, () => html`<p class="empty">${t(locale, 'studio.card.historyEmpty')}</p>`)}
      </section>`)}

      <p class="studio-card__actions">
        <button class="button button--primary" type="submit">${t(locale, 'studio.card.save')}</button>
      </p>
    </form>

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
