// S-23 — резервные коды. Показываются один раз.
//
// F-01-05 §4: десять одноразовых кодов, «скачать или распечатать». В базе
// лежат только хеши, поэтому второй раз показать их неоткуда — и это не
// ограничение реализации, а требование R-SEC-04.
//
// §19: моноширинным списком с кнопками «Скачать» и «Печать».

import { html } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * @param {object} ctx
 * @param {string} ctx.locale
 * @param {'backup'} ctx.state
 * @param {string[]} ctx.codes коды, доступные только здесь
 */
export function backupCodesView(ctx) {
  const { locale, codes } = ctx;

  return html`
<section class="block block--form">
  <h1 class="form__title">${t(locale, 'twoFactor.backup.title')}</h1>
  <p class="form__text">${t(locale, 'twoFactor.backup.lead')}</p>
  <p class="form__warning">${t(locale, 'twoFactor.backup.once')}</p>

  <ol class="codes">
    ${codes.map((code) => html`<li class="codes__item"><code>${code}</code></li>`)}
  </ol>

  <div class="codes__actions">
    <button class="button button--quiet" type="button"
            data-download-codes>${t(locale, 'twoFactor.backup.download')}</button>
    <button class="button button--quiet" type="button"
            onclick="window.print()">${t(locale, 'twoFactor.backup.print')}</button>
  </div>

  <p class="form__links">
    <a href="/${locale}/">${t(locale, 'twoFactor.backup.done')}</a>
  </p>
</section>`;
}