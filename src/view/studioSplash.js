// Кадры заставки (S-79, F-10-09).
//
// Лента кадров с номерами; справа — предпросмотр и предупреждения о резкой
// смене яркости. Если кадров меньше двенадцати, заставка выключена, и это
// написано прямо: человек должен знать, что на экране будет пусто.

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
  return html`
<div class="studio studio--splash">
  <h1 class="studio__title">${t(locale, 'studio.splash.title')}</h1>
  <p class="studio__note">${t(locale, 'studio.splash.description')}</p>

  ${when(!state.ready, () => html`
  <p class="studio-card__blockers">
    ${t(locale, 'studio.splash.notReady', { count: frames.length })}
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
      <ol class="studio-splash__list" role="list">
        ${frames.map((frame, index) => html`
        <li class="studio-splash__frame">
          <span class="studio-splash__number">${index + 1}</span>
          <span class="studio-splash__title">${frame.seriesTitle ?? t(locale, 'studio.splash.withoutSeries')}</span>
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
      <ol class="studio-splash__preview" role="list">
        ${frames.map((frame, index) => html`
        <li class="studio-splash__preview-item">
          <img class="studio-splash__preview-image" alt=""
            src="/${locale}/images/${frame.seriesSlug ?? 'splash'}/backdrop-${frame.width}.webp"
            style="object-position: ${frame.focalX}% ${frame.focalY}%">
          <span class="studio-splash__number">${index + 1}</span>
        </li>`)}
      </ol>
    </section>
  </div>
</div>`;
}
