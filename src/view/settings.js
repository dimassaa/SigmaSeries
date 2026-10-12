// S-32 — экран настроек.
//
// Спецификация: SCREENS S-32; F-01-06 §19 (левая треть — вертикальная
// навигация по разделам, остальное — форма на сплошной поверхности; фокус на
// активном разделе и его primary), §6 (сохранено объявляется через
// `role="status"`).
// Требования: R-A11Y-11 (ошибки связаны с полем и объявляются), R-DES-09
// (состояние переключателя не только цветом), R-DES-06 (один primary на
// действие).

import { html, raw, when } from './render.js';
import { t } from '../i18n/strings.js';

/**
 * @param {object} ctx
 * @param {string} ctx.locale
 * @param {string} ctx.csrf
 * @param {string} ctx.section открытый раздел
 * @param {Record<string,string>} ctx.sections разделы и их заголовки
 * @param {object|null} ctx.user текущий пользователь, если вошёл
 * @param {string|null} ctx.error
 * @param {boolean} [ctx.saved] только что сохранено
 * @param {object|null} [ctx.values] значения, отправленные человеком: при
 *   ошибке они возвращаются в форму, иначе он набирает всё заново
 * @param {string[]} ctx.themes
 * @param {string[]} ctx.locales
 * @param {string[]} ctx.timezones
 */
export function settingsView(ctx) {
  const { locale, section, sections, user } = ctx;

  return html`
<section class="block">
  <h1 class="form__title">${t(locale, 'settings.title')}</h1>

  <!--
    Сохранение объявляется, но фокус на него не переносится: перенос мешает
    тем, кто читает с экрана (R-A11Y-12).
  -->
  <div class="form__status" role="status" aria-live="polite">
    ${when(ctx.saved, () => html`<p class="form__saved">${t(locale, 'settings.saved')}</p>`)}
    ${when(ctx.error, () => html`<p class="form__error">${ctx.error}</p>`)}
  </div>

  <div class="settings">
    <nav class="settings__nav" aria-label="${t(locale, 'settings.sections')}">
      <ul class="settings__list">
        ${Object.entries(sections).map(([key, titleKey]) => html`
        <li class="settings__item">
          <a class="settings__link" href="/${locale}/settings/${key}"
             ${key === section ? raw('aria-current="page"') : ''}
             >${t(locale, titleKey)}</a>
        </li>`)}
      </ul>
    </nav>

    <div class="settings__body">
      ${section === 'profile' ? profile(ctx) : ''}
      ${section === 'appearance' ? appearance(ctx) : ''}
      ${section === 'notifications' ? notifications(ctx) : ''}
      ${section === 'privacy' ? privacy(ctx) : ''}
      ${section === 'security' ? security(ctx) : ''}
      ${when(user === null, () => html`<p class="form__text">${
        t(locale, 'settings.guestNote')
      }</p>`)}
    </div>
  </div>
</section>`;
}

/**
 * Профиль: аватар-инициалы и ник (F-01-06 §4).
 *
 * Загрузка аватара в P0 не входит (H-52), но плашка обязательна: пустое
 * место в списке отметок выглядит как поломка.
 */
function profile({ locale, csrf, user, error, values, history = [], changedAt = null }) {
  const nickname = values?.nickname ?? user?.nickname ?? '';

  return html`
<div class="avatar" aria-hidden="true">
  <span class="avatar__plate">${initialsOf(nickname)}</span>
</div>

<form class="form settings__form" method="post" action="/${locale}/settings/profile" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">

  <div class="field${error ? ' field--invalid' : ''}">
    <label class="field__label" for="nickname">${t(locale, 'settings.profile.nickname')}</label>
    <input class="field__input" id="nickname" name="nickname" type="text"
           autocomplete="nickname" maxlength="32" required
           ${when(error, () => raw('aria-invalid="true" aria-describedby="nickname-error"'))}>
    ${when(error, () => html`<p class="field__error" id="nickname-error">${error}</p>`)}
    ${when(changedAt !== null, () => html`<p class="field__hint">${
      t(locale, 'settings.profile.changedAt')
    }</p>`)}
  </div>

  <button class="button form__submit" type="submit">${t(locale, 'settings.apply')}</button>
</form>

${when(history.length, () => html`
<details class="form__details">
  <summary class="form__link">${t(locale, 'settings.profile.history')}</summary>
  <ul class="settings__history">
    ${history.map((row) => html`
    <li class="settings__history-item">
      <span class="settings__history-name">${row.nickname}</span>
      <span class="settings__history-date">${new Date(row.valid_from * 1000)
        .toISOString().slice(0, 10)}</span>
    </li>`)}
  </ul>
</details>`)}`;
}

/** Две буквы от ника; одна, когда он односимвольный. */
function initialsOf(nickname) {
  const letters = String(nickname ?? '').replace(/[^\p{L}\p{N}]/gu, '');
  return (letters.slice(0, 2) || '?').toUpperCase();
}

/**
 * Уведомления (F-01-06 §4).
 *
 * Здесь контейнер и сохранение: состав категорий определяет M3. Пока он не
 * назван, доступны общий выключатель и тихие часы — без них человек не может
 * даже прекратить писать ему письма.
 */
function notifications({ locale, csrf, user, error }) {
  const on = (field, fallback) => (user ? Boolean(user[field]) : fallback);

  return html`
<form class="form settings__form" method="post" action="/${locale}/settings/notifications" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">

  <fieldset class="settings__group">
    <legend class="settings__legend">${t(locale, 'settings.notifications.legend')}</legend>

    ${switchRow('notifications_enabled', t(locale, 'settings.notifications.all'),
    t(locale, 'settings.notifications.all.hint'), on('notifications_enabled', true))}
    ${switchRow('quiet_hours', t(locale, 'settings.notifications.quiet'),
    t(locale, 'settings.notifications.quiet.hint'), on('quiet_hours', false))}
  </fieldset>

  <p class="field__hint">${t(locale, 'settings.notifications.categoriesHint')}</p>

  <button class="button form__submit" type="submit">${t(locale, 'settings.apply')}</button>
</form>`;
}

/**
 * Безопасность: пароль, 2FA и устройства (F-01-06 §4).
 *
 * Три формы на одной странице: дела одного рода, и разводить их по вкладкам
 * незачем. Кнопка «Отключить 2FA» служебной роли не выводится (R-SEC-03), но
 * запрет держит сервер — скрытая кнопка обходится прямым запросом.
 */
function security({
  locale, csrf, user, error, staff = false,
  twoFactor = null, backupLeft = 0, devices = [], backupCodes = null,
}) {
  return html`
<form class="form settings__form" method="post" action="/${locale}/settings/security" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="password">

  <h2 class="settings__subhead">${t(locale, 'settings.security.password')}</h2>

  <div class="field${error ? ' field--invalid' : ''}">
    <label class="field__label" for="current">${t(locale, 'settings.security.current')}</label>
    <input class="field__input" id="current" name="current" type="password"
           autocomplete="current-password" required
           ${when(error, () => raw('aria-invalid="true" aria-describedby="current-error"'))}>
    ${when(error, () => html`<p class="field__error" id="current-error">${error}</p>`)}
  </div>

  <div class="field">
    <label class="field__label" for="new_password">${t(locale, 'settings.security.new')}</label>
    <input class="field__input" id="new_password" name="password" type="password"
           autocomplete="new-password" required>
    <p class="field__hint">${t(locale, 'settings.security.new.hint')}</p>
  </div>

  <button class="button form__submit" type="submit">${t(locale, 'settings.security.change')}</button>
</form>

<form class="form settings__form" method="post" action="/${locale}/settings/security" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="two_factor">

  <h2 class="settings__subhead">${t(locale, 'settings.security.twoFactor')}</h2>

  ${when(twoFactor, () => html`
  <p class="settings__state">${t(locale, 'settings.security.twoFactor.on')}</p>
  <p class="field__hint">${t(locale, 'settings.security.backupLeft', { count: backupLeft })}</p>

  <div class="field">
    <label class="field__label" for="tf_password">${t(locale, 'settings.security.confirm')}</label>
    <input class="field__input" id="tf_password" name="password" type="password"
           autocomplete="current-password" required>
  </div>

  <div class="settings__actions">
    <button class="button button--quiet" type="submit" name="op" value="regenerate"
      >${t(locale, 'settings.security.regenerate')}</button>
    ${when(!staff, () => html`
    <button class="button button--danger" type="submit" name="op" value="disable"
      >${t(locale, 'settings.security.disable')}</button>`)}
    ${when(staff, () => html`
    <p class="field__hint">${t(locale, 'settings.security.required')}</p>`)}
  </div>`)}

  ${when(!twoFactor, () => html`
  <p class="settings__state">${t(locale, 'settings.security.twoFactor.off')}</p>
  <a class="button button--quiet" href="/${locale}/2fa/setup"
     >${t(locale, 'settings.security.enable')}</a>`)}
</form>

${when(backupCodes, () => html`
<div class="settings__backup">
  <h2 class="settings__subhead">${t(locale, 'twoFactor.backup.title')}</h2>
  <p class="form__warning">${t(locale, 'twoFactor.backup.once')}</p>
  <ol class="codes">
    ${backupCodes.map((code) => html`<li class="codes__item"><code>${code}</code></li>`)}
  </ol>
</div>`)}

<form class="form settings__form" method="post" action="/${locale}/settings/security" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="revoke_device">

  <h2 class="settings__subhead">${t(locale, 'settings.security.devices')}</h2>

  ${when(devices.length, () => html`
  <ul class="settings__devices">
    ${devices.map((device) => html`
    <li class="settings__device">
      <span class="settings__device-label">${device.device_label ?? t(locale, 'settings.security.device')}</span>
      <button class="button button--quiet" type="submit" name="session" value="${device.id}"
        >${t(locale, 'settings.security.revoke')}</button>
    </li>`)}
  </ul>`)}

  ${when(!devices.length, () => html`
  <p class="field__hint">${t(locale, 'settings.security.devicesEmpty')}</p>`)}
</form>`;
}

/**
 * Язык, тема и часовой пояс.
 *
 * Отдельная форма на каждый: §8(а) требует применить выбор сразу, и форма с
 * тремя полями применяла бы все три только по одной кнопке — то есть не
 * сразу.
 */
function appearance({ locale, csrf, user, error, values, themes, locales, localeNames, timezones }) {
  const theme = values?.theme ?? user?.theme ?? 'system';
  const lang = values?.locale ?? user?.locale ?? locale;
  const zone = values?.timezone ?? user?.timezone ?? 'Europe/Minsk';

  return html`
<form class="form settings__form" method="post" action="/${locale}/settings/appearance" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">

  <div class="field${error ? ' field--invalid' : ''}">
    <label class="field__label" for="theme">${t(locale, 'settings.theme')}</label>
    <select class="field__input" id="theme" name="theme">
      ${themes.map((option) => html`
      <option value="${option}" ${option === theme ? raw('selected') : ''}
        >${t(locale, `settings.theme.${option}`)}</option>`)}
    </select>
  </div>

  <div class="field">
    <label class="field__label" for="locale">${t(locale, 'settings.language')}</label>
    <select class="field__input" id="locale" name="locale">
      ${locales.map((option) => html`
      <option value="${option}" ${option === lang ? raw('selected') : ''}
        >${localeNames[option]}</option>`)}
    </select>
    <p class="field__hint">${t(locale, 'settings.language.hint')}</p>
  </div>

  <div class="field">
    <label class="field__label" for="timezone">${t(locale, 'settings.timezone')}</label>
    <select class="field__input" id="timezone" name="timezone">
      ${when(!timezones.includes(zone), () => html`
      <option value="${zone}" selected>${zone}</option>`)}
      ${timezones.map((option) => html`
      <option value="${option}" ${option === zone ? raw('selected') : ''}>${option}</option>`)}
    </select>
  </div>

  <button class="button form__submit" type="submit">${t(locale, 'settings.apply')}</button>
</form>`;
}

/**
 * Приватность.
 *
 * §8(г): приватность закрыта по умолчанию, поэтому каждый выключатель
 * приходит уже снятым. Формы тут одна на раздел, и применяется она кнопкой —
 * §8(б) говорит «переключатели сохраняются сразу», но «сразу» здесь означает
 * «без отдельной страницы подтверждения»: четыре переключателя, каждый с
 * своей кнопкой, заставляли бы человека нажимать четыре раза подряд.
 */
function privacy({ locale, csrf, user, error }) {
  const on = (field, fallback = false) => (user ? Boolean(user[field]) : fallback);

  return html`
<form class="form settings__form" method="post" action="/${locale}/settings/privacy" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">

  <fieldset class="settings__group">
    <legend class="settings__legend">${t(locale, 'settings.privacy.legend')}</legend>

    ${switchRow('stats_public', t(locale, 'settings.privacy.stats'),
    t(locale, 'settings.privacy.stats.hint'), on('stats_public'))}
    ${switchRow('profile_public', t(locale, 'settings.privacy.profile'),
    t(locale, 'settings.privacy.profile.hint'), on('profile_public'))}
    ${switchRow('recs_enabled', t(locale, 'settings.privacy.recs'),
    t(locale, 'settings.privacy.recs.hint'), on('recs_enabled', true))}
  </fieldset>

  <button class="button form__submit" type="submit">${t(locale, 'settings.apply')}</button>
</form>`;
}

/** Один переключатель: подпись кликабельна, состояние видно и без цвета. */
function switchRow(name, label, hint, checked) {
  return html`
<div class="field field--switch">
  <input class="field__checkbox" type="checkbox" id="${name}" name="${name}"
         ${checked ? raw('checked') : ''}>
  <label class="field__switch-label" for="${name}">
    <span class="field__switch-text">${label}</span>
    <span class="field__hint">${hint}</span>
  </label>
</div>`;
}