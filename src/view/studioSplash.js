// Кадры заставки (S-79, F-10-09).
//
// Экран: лента кадров с номерами и предупреждения о резкой смене яркости.
// Справа — предпросмотр: заставка показывает кадры размытыми, и в предпросмотре
// видно то же, что увидит человек. Порядок задаётся кнопками и перетаскиванием:
// кнопки остаются потому, что перетаскивание недоступно с клавиатуры.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * Экран кадров заставки.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.state
 * @param {object[]} args.candidates
 * @param {string} args.csrf
 * @returns {string}
 */
export function splashView({ locale, state = { frames: [], warnings: [], ready: false }, candidates = [], csrf = '' }) {
  const frames = state.frames ?? [];
  const usable = state.usable ?? frames.length;
  const width = state.previewWidth ?? 32;

  /** Ссылка на размытую копию кадра: заставка показывает именно её. */
  const previewUrl = (frame) => (frame.seriesSlug
    ? `/${locale}/images/${frame.seriesSlug}/backdrop-${width}.webp`
    : '');

  return html`
<div class="studio studio--splash">
  <h1 class="studio__title">${t(locale, 'studio.splash.title')}</h1>
  <p class="studio__note">${t(locale, 'studio.splash.description')}</p>

  ${when(!state.ready, () => html`
  <p class="studio-card__blockers">
    ${t(locale, 'studio.splash.notReady', { count: usable })}
  </p>`)}

  ${when(state.warnings && state.warnings.length, () => html`
  <section class="studio__section">
    <h2 class="studio__section-title">${t(locale, 'studio.splash.warnings')}</h2>
    <ul class="studio-history" role="list">
      ${state.warnings.map((warning) => html`
      <li class="studio-history__item">
        <span class="studio-history__reason">
          ${t(locale, 'studio.splash.warningItem', { diff: warning.diff })}
        </span>
      </li>`)}
    </ul>
  </section>`)}

  <div class="studio-splash">
    <section class="studio-splash__frames">
      <h2 class="studio__section-title">${t(locale, 'studio.splash.frames')}</h2>
      ${when(frames.length === 0, () => html`
      <p class="empty">${t(locale, 'studio.splash.empty')}</p>`)}
      ${when(frames.length > 0, () => html`
      <p class="studio-card__note">${t(locale, 'studio.splash.drag')}</p>`)}
      <ol class="studio-splash__list" role="list"
        data-order-url="/${locale}/admin/splash/order">
        ${frames.map((frame, index) => html`
        <li class="studio-splash__frame${frame.disabled ? ' is-disabled' : ''}"
          draggable="true" data-frame-id="${frame.id}" data-position="${index}"
          data-preview-src="${previewUrl(frame)}"
          data-preview-x="${frame.focalX}" data-preview-y="${frame.focalY}">
          <span class="studio-splash__number">${index + 1}</span>
          <span class="studio-splash__title">${frame.seriesTitle ?? t(locale, 'studio.splash.withoutSeries')}</span>
          ${when(frame.disabled, () => html`
          <span class="studio__origin studio-origin--manual">${t(locale, 'studio.splash.disabled')}</span>`)}
          <span class="studio-splash__brightness">
            ${frame.brightness === null ? '—' : t(locale, 'studio.splash.brightness', { value: frame.brightness })}
          </span>
          <span class="studio-splash__order">
            <form class="studio-splash__buttons" method="post" action="/${locale}/admin/splash/order">
              <input type="hidden" name="csrf" value="${csrf}">
              <input type="hidden" name="frame_id" value="${frame.id}">
              <button class="button button--quiet" type="submit" name="where" value="up"
                ${index === 0 ? 'disabled' : ''}>${t(locale, 'studio.collections.up')}</button>
              <button class="button button--quiet" type="submit" name="where" value="down"
                ${index === frames.length - 1 ? 'disabled' : ''}>${t(locale, 'studio.collections.down')}</button>
              <button class="button button--quiet" type="submit" name="where" value="first">${t(locale, 'studio.collections.first')}</button>
              <button class="button button--quiet" type="submit" name="where" value="last">${t(locale, 'studio.collections.last')}</button>
            </form>
            <form class="studio-splash__buttons" method="post" action="/${locale}/admin/splash/remove">
              <input type="hidden" name="csrf" value="${csrf}">
              <input type="hidden" name="frame_id" value="${frame.id}">
              <button class="button button--quiet" type="submit">${t(locale, 'studio.splash.remove')}</button>
            </form>
          </span>
          <form class="studio-splash__focal" method="post" action="/${locale}/admin/splash/focal">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="frame_id" value="${frame.id}">
            <label class="field__label" for="splash-x-${frame.id}">${t(locale, 'studio.card.focalX')}</label>
            <input class="field__input" id="splash-x-${frame.id}" name="focal_x" type="number"
              min="0" max="100" value="${frame.focalX}">
            <label class="field__label" for="splash-y-${frame.id}">${t(locale, 'studio.card.focalY')}</label>
            <input class="field__input" id="splash-y-${frame.id}" name="focal_y" type="number"
              min="0" max="100" value="${frame.focalY}">
            <button class="button button--quiet" type="submit">${t(locale, 'studio.splash.saveFocal')}</button>
          </form>
        </li>`)}
      </ol>
    </section>

    <section class="studio-splash__side">
      <h2 class="studio__section-title">${t(locale, 'studio.splash.add')}</h2>
      <form class="studio-dictionary__form" method="post" action="/${locale}/admin/splash">
        <input type="hidden" name="csrf" value="${csrf}">
        <label class="field__label" for="splash-series">${t(locale, 'studio.splash.series')}</label>
        <select class="field__input" id="splash-series" name="series_id" required>
          ${candidates.map((candidate) => html`
          <option value="${candidate.seriesId}" data-image="${candidate.imageId}">
            ${candidate.title} (${candidate.width}×${candidate.height})
          </option>`)}
        </select>
        <input type="hidden" name="image_id" id="splash-image" value="${candidates[0]?.imageId ?? ''}">
        <p class="studio-card__actions">
          <button class="button button--primary" type="submit">${t(locale, 'studio.splash.addButton')}</button>
        </p>
      </form>

      <h2 class="studio__section-title">${t(locale, 'studio.splash.preview')}</h2>
      <div class="studio-splash__player" data-splash-player>
        <img class="studio-splash__preview-image" data-splash-preview src="" alt="">
        <p class="studio-splash__counter" data-splash-counter data-total="${state.ticks ?? 25}">
          ${t(locale, 'studio.splash.counterBefore')}<span data-splash-current>1</span>${t(locale, 'studio.splash.counterAfter', { total: state.ticks ?? 25 })}
        </p>
        <p class="studio-card__actions">
          <button class="button" type="button" data-splash-play
            data-label-play="${t(locale, 'studio.splash.play')}"
            data-label-stop="${t(locale, 'studio.splash.stop')}">${t(locale, 'studio.splash.play')}</button>
        </p>
      </div>
      <ol class="studio-splash__preview" role="list">
        ${frames.map((frame, index) => html`
        <li class="studio-splash__preview-item">
          <img class="studio-splash__preview-image" alt=""
            src="${previewUrl(frame)}"
            style="object-position: ${frame.focalX}% ${frame.focalY}%">
          <span class="studio-splash__number">${index + 1}</span>
        </li>`)}
      </ol>
    </section>
  </div>
</div>`;
}
