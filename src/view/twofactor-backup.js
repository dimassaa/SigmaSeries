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
 * Список резервных кодов с кнопками «Скачать» и «Печать».
 *
 * Блок общий для двух экранов: страницы подтверждения 2FA (S-23) и раздела
 * «Безопасность», откуда коды перевыпускаются. Настройки хранятся в сессии
 * или в адресе, а показываются оба раза одним и тем же списком — раздельная
 * разметка означала бы, что кнопки есть на одном экране и нет на другом,
 * и человек узнаёт об этом только после нажатия.
 *
 * @param {object} ctx
 * @param {string} ctx.locale
 * @param {string[]} ctx.codes
 * @returns {object}
 */
export function backupCodesList({ locale, codes }) {
  return html`
<ol class="codes" data-title="${t(locale, 'twoFactor.backup.title')}"
    data-file="sigma-series-${locale}-backup-codes.txt">
  ${codes.map((code) => html`<li class="codes__item"><code>${code}</code></li>`)}
</ol>

<div class="codes__actions">
  <button class="button button--quiet" type="button"
          data-download-codes>${t(locale, 'twoFactor.backup.download')}</button>
  <!-- Обработчик в клиентском скрипте, а не в атрибуте: инлайновых
       обработчиков в видах нет ни одного, и появление первого сделало бы
       правило исключением. -->
  <button class="button button--quiet" type="button"
          data-print-codes>${t(locale, 'twoFactor.backup.print')}</button>
</div>`;
}

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

  ${backupCodesList({ locale, codes })}

  <p class="form__links">
    <a href="/${locale}/">${t(locale, 'twoFactor.backup.done')}</a>
  </p>
</section>`;
}