// Колокольчик «Следить за выходом» (F-03-07 §19).
//
// Три требования к этой кнопке, и все три видны глазом:
//
//  · Состояние — не только значок: у кнопки есть текст, `aria-pressed` и
//    подпись под ней, поэтому состояние читается и без картинок, и вслух
//    (R-A11Y-19).
//  · Откуда состояние взялось: «включено автоматически по статусу» и «выключено
//    вручную» — разные ситуации, и человеку надо видеть, какая из них его
//    ждёт при следующей смене статуса (EC-T19). Без этой подписи «Смотрю»
//    выглядит как «приложение само всё решило».
//  · Гостю показывается приглашение, а не мёртвая кнопка: пустое место на
//    странице сериала читается как ошибка вёрстки.
//
// Запрос — «поставить» или «снять», а не «переключить»: двойной клик и повтор с
// двух устройств не должны включать то, что человек выключил (EC-T1, EC-T18).

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/** Колокольчик: один значок на оба состояния, состояние несёт текст. */
const ICON = { on: '🔔', off: '🔕' };

/**
 * Кнопка подписки.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {string} args.slug
 * @param {{enabled: boolean, source: string}|null} args.state
 * @param {string} args.csrf
 * @param {boolean} args.signedIn
 * @param {boolean} [args.archived] снятый с публикации: подписка неактивна (EC-T8)
 * @param {string} [args.view] откуда нажали: `series` или `library`
 */
export function subscribeBell({ locale, slug, state, csrf, signedIn, archived = false, view = 'series' }) {
  if (!signedIn) {
    const next = view === 'library' ? `/${locale}/library` : `/${locale}/series/${slug}`;
    return html`
<p class="subs subs--guest">
  <a href="/${locale}/login?next=${encodeURIComponent(next)}">${t(locale, 'subs.guest')}</a>
</p>`;
  }

  if (archived) {
    return html`<p class="subs subs--archived" role="status">${t(locale, 'subs.archived')}</p>`;
  }

  const enabled = state?.enabled === true;
  const auto = state?.source === 'auto';

  return html`
<div class="subs" data-subs="${enabled ? (auto ? 'auto' : 'manual') : 'off'}">
  <form method="post" action="/${locale}/series/${slug}/subscribe">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="view" value="${view}">
    <button class="subs__button${enabled ? ' subs__button--on' : ''}" type="submit"
            name="on" value="${enabled ? '0' : '1'}"
            aria-pressed="${enabled ? 'true' : 'false'}">
      <span aria-hidden="true">${enabled ? ICON.on : ICON.off}</span>
      ${t(locale, enabled ? 'subs.on' : 'subs.off')}
    </button>
  </form>

  ${when(enabled && auto, () => html`
  <p class="subs__note">${t(locale, 'subs.auto')}</p>`)}

  ${when(!enabled && state?.source === 'manual', () => html`
  <p class="subs__note">${t(locale, 'subs.manualOff')}</p>`)}
</div>`;
}
