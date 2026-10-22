// Слой подробной карточки постера (F-02-07, UI-10).
//
// Слой приходит на страницу готовым фрагментом: подписи, переводы и
// экранирование — на сервере, на клиенте остаётся только показать его и убрать
// (R-I18N-06, R-SEC-15).

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * @typedef {object} PosterRating
 * @property {number} value средний балл платформы
 * @property {number|null} votes число голосов
 */

/**
 * @typedef {object} PosterPerson
 * @property {string} slug
 * @property {string} name
 * @property {string} role
 * @property {number} ordinal
 */

/**
 * @typedef {object} PosterGenre
 * @property {string} code
 * @property {string} name_ru
 * @property {string} name_en
 */

/**
 * Данные слоя: форма задана источником `pgPosterCard` (src/services/catalogue/card.js).
 *
 * @typedef {object} PosterCardData
 * @property {string} slug
 * @property {string|null} titleRu
 * @property {string|null} titleEn
 * @property {string|null} titleOriginal
 * @property {number|null} yearStart
 * @property {number|null} yearEnd
 * @property {string} descriptionRu
 * @property {string} descriptionEn
 * @property {string} exitState
 * @property {PosterGenre[]} genres
 * @property {string[]} countries коды ISO
 * @property {{imdb: PosterRating|null, tmdb: PosterRating|null, site: PosterRating|null}} ratings
 * @property {PosterPerson[]} directors
 * @property {PosterPerson[]} cast
 * @property {{date: string, season: number|null, number: number|null}|null} nextRelease
 */

/**
 * Слой подробной карточки.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {PosterCardData} args.data данные слоя
 * @param {boolean} [args.open] нижняя панель для touch: в ней есть «Открыть»
 * @returns {object}
 */
export function posterCardView({ locale, data, open = false }) {
  return html`
<div class="poster-card">
  <p class="poster-card__head">
    <span class="poster-card__title">${title(locale, data)}</span>
    ${when(years(locale, data), () => html`<span class="poster-card__year">${years(locale, data)}</span>`)}
    ${when(countries(locale, data), () => html`<span class="poster-card__country">${countries(locale, data)}</span>`)}
  </p>

  ${when(data.genres.length > 0, () => html`
  <p class="poster-card__genres">${genreNames(locale, data.genres).join(' · ')}</p>`)}

  ${when(hasRatings(data.ratings), () => html`
  <ul class="poster-card__ratings" role="list">
    ${rating(locale, 'IMDb', data.ratings.imdb)}
    ${rating(locale, 'TMDB', data.ratings.tmdb)}
    ${rating(locale, t(locale, 'series.rating.site'), data.ratings.site)}
  </ul>`)}

  ${when(description(locale, data), () => html`
  <p class="poster-card__description">${description(locale, data)}</p>`)}

  ${when(data.directors.length > 0 || data.cast.length > 0, () => html`
  <p class="poster-card__people">
    ${when(data.directors.length > 0, () => html`
    <span class="poster-card__director">${t(locale, 'poster.card.director')}: ${names(data.directors)}</span>`)}
    ${when(data.cast.length > 0, () => html`
    <span class="poster-card__cast">${t(locale, 'poster.card.cast')}: ${names(data.cast)}</span>`)}
  </p>`)}

  <p class="poster-card__state">
    ${t(locale, `series.state.${data.exitState}`)}
    ${when(data.nextRelease, () => html`
    <span class="poster-card__next">${t(locale, 'series.next', {
      date: formatDay(locale, data.nextRelease.date),
      number: data.nextRelease.number ?? '',
    })}</span>`)}
  </p>

  ${when(open, () => html`
  <p class="poster-card__open">
    <a class="button" href="/${locale}/series/${data.slug}">${t(locale, 'poster.card.open')}</a>
  </p>`)}
</div>`;
}

/**
 * Название по цепочке резерва: перевод → оригинал (R-I18N-06).
 *
 * @param {string} locale
 * @param {PosterCardData} data
 * @returns {string|object|null}
 */
function title(locale, data) {
  if (locale === 'en') {
    if (data.titleEn) return data.titleEn;
    if (data.titleRu) return html`<span lang="ru">${data.titleRu}</span>`;
    return data.titleOriginal;
  }
  if (data.titleRu) return data.titleRu;
  if (data.titleEn) return html`<span lang="en">${data.titleEn}</span>`;
  return data.titleOriginal;
}

/**
 * Описание по цепочке резерва: у описания нет оригинала, только переводы.
 *
 * @param {string} locale
 * @param {PosterCardData} data
 * @returns {string|object}
 */
function description(locale, data) {
  if (locale === 'en') {
    if (data.descriptionEn) return data.descriptionEn;
    if (data.descriptionRu) return html`<span lang="ru">${data.descriptionRu}</span>`;
    return '';
  }
  return data.descriptionRu || data.descriptionEn || '';
}

/**
 * Годы: «2019» или «2011–2019».
 *
 * @param {string} locale
 * @param {PosterCardData} data
 * @returns {string}
 */
function years(locale, data) {
  if (!data.yearStart) return '';
  if (!data.yearEnd) return String(data.yearStart);
  return `${data.yearStart}–${data.yearEnd}`;
}

/**
 * Страны производства через `Intl.DisplayNames` (M2 §0).
 *
 * @param {string} locale
 * @param {PosterCardData} data
 * @returns {string}
 */
function countries(locale, data) {
  if (!data.countries.length) return '';
  let names;
  try {
    const display = new Intl.DisplayNames([locale], { type: 'region' });
    names = data.countries.map((code) => display.of(code)).filter(Boolean);
  } catch {
    names = [];
  }
  return names.join(', ');
}

/**
 * Названия жанров на языке читателя.
 *
 * @param {string} locale
 * @param {PosterGenre[]} data
 * @returns {string[]}
 */
function genreNames(locale, data) {
  return data.map((genre) => (locale === 'en' ? genre.name_en : genre.name_ru)).filter(Boolean);
}

/**
 * Рейтинг: число или прочерк, когда его нет.
 *
 * @param {string} locale
 * @param {string} label
 * @param {PosterRating|null} value
 * @returns {object}
 */
function rating(locale, label, value) {
  const text = value
    ? value.value.toFixed(1).replace('.', locale === 'en' ? '.' : ',')
    : '—';
  return html`
  <li class="poster-card__rating">
    <span class="poster-card__rating-label">${label}</span>
    <span class="poster-card__rating-value">${text}</span>
  </li>`;
}

/**
 * @param {{imdb: PosterRating|null, tmdb: PosterRating|null, site: PosterRating|null}} ratings
 * @returns {boolean}
 */
function hasRatings(ratings) {
  return Boolean(ratings.imdb || ratings.tmdb || ratings.site);
}

/**
 * Имена людей через запятую.
 *
 * @param {PosterPerson[]} people
 * @returns {string}
 */
function names(people) {
  return people.map((person) => person.name).filter(Boolean).join(', ');
}

/**
 * Дата выхода: «12 окт. 2026 г.» в русской записи и «12 Oct 2026» в английской.
 *
 * @param {string} locale
 * @param {string|Date} date
 * @returns {string}
 */
function formatDay(locale, date) {
  const value = typeof date === 'string' ? new Date(`${date}T00:00:00Z`) : date;
  if (Number.isNaN(value.getTime())) return '';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(value);
}
