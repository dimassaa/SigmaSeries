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
import { dateTime } from './dates.js';
import { initialsOf } from './avatar.js';
import { backupCodesList } from './twofactor-backup.js';

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
      ${section === 'data' ? data(ctx) : ''}
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

/**
 * Уведомления (F-01-06 §4).
 *
 * Здесь контейнер и сохранение: состав категорий определяет M3. Пока он не
 * назван, доступны общий выключатель и тихие часы — без них человек не может
 * даже прекратить писать ему письма.
 */
function notifications({ locale, csrf, user, matrix = null, staff = false }) {
  if (!user) {
    return html`
<p class="form__text">${t(locale, 'settings.notifications.guest')}</p>`;
  }

  return html`
<form class="form settings__form" method="post" action="/${locale}/settings/notifications" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">

  <fieldset class="settings__group">
    <legend class="settings__legend">${t(locale, 'settings.notifications.legend')}</legend>

    <table class="notify-matrix">
      <caption class="visually-hidden">${t(locale, 'settings.notifications.matrix')}</caption>
      <thead>
        <tr>
          <th scope="col">${t(locale, 'settings.notifications.category')}</th>
          <th scope="col">${t(locale, 'settings.notifications.inService')}</th>
        </tr>
      </thead>
      <tbody>
        ${matrixRow({ locale, csrf, category: 'release', label: 'settings.notifications.release', matrix, staff })}
        ${soonRow({ locale, label: 'settings.notifications.announce' })}
        ${matrixRow({ locale, csrf, category: 'reply', label: 'settings.notifications.reply', matrix, staff })}
        ${lockedRow({
          locale, csrf,
          label: 'settings.notifications.moderation',
          hint: 'settings.notifications.moderation.hint',
        })}
        ${when(staff, () => matrixRow({
    locale, csrf, category: 'service', label: 'settings.notifications.service', matrix, staff,
  }))}
      </tbody>
    </table>

    <p class="field__hint">${t(locale, 'settings.notifications.channelsHint')}</p>
  </fieldset>

  <fieldset class="settings__group">
    <legend class="settings__legend">${t(locale, 'settings.notifications.quietLegend')}</legend>

    ${switchRow('quiet_hours', t(locale, 'settings.notifications.quiet'),
    t(locale, 'settings.notifications.quiet.hint'), Boolean(user.quietHours))}

    <div class="field">
      <label class="field__label" for="quiet_from">${t(locale, 'settings.notifications.quietFrom')}</label>
      <input class="field__input" id="quiet_from" name="quiet_from" type="time"
             value="${(user.quietFrom ?? '23:00').slice(0, 5)}" step="300">
    </div>
    <div class="field">
      <label class="field__label" for="quiet_to">${t(locale, 'settings.notifications.quietTo')}</label>
      <input class="field__input" id="quiet_to" name="quiet_to" type="time"
             value="${(user.quietTo ?? '08:00').slice(0, 5)}" step="300">
    </div>
  </fieldset>

  <button class="button form__submit" type="submit">${t(locale, 'settings.apply')}</button>
</form>`;
}

/**
 * Строка матрицы с переключателем (F-03-10 §19).
 *
 * У переключателя `role="switch"`, а не просто галочка: человек должен слышать
 * «включено» или «выключено», а не угадывать по наличию отметки.
 *
 * @param {object} args
 * @returns {object}
 */
function matrixRow({ locale, csrf, category, label, matrix, staff }) {
  const on = matrix?.[category]?.in_service ?? true;

  return html`
<tr class="notify-matrix__row">
  <th scope="row">${t(locale, label)}</th>
  <td>
    <form class="notify-matrix__form" method="post" action="/${locale}/settings/notifications">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="category" value="${category}">
      <input type="hidden" name="channel" value="in_service">
      <input type="hidden" name="enabled" value="${on ? 'off' : 'on'}">
      <button class="field__switch" type="submit" role="switch" aria-checked="${on ? 'true' : 'false'}">
        <span class="field__switch-box" aria-hidden="true"></span>
        <span class="field__switch-text">${t(locale, on ? 'settings.notifications.stateOn' : 'settings.notifications.stateOff')}</span>
      </button>
    </form>
  </td>
</tr>`;
}

/**
 * Строка, которой ещё нет.
 *
 * Показана, а не спрятана: человек видит, что объявление сезона в списке есть
 * и скоро появится, вместо того чтобы гадать, потерялась ли настройка.
 */
function soonRow({ locale, label }) {
  return html`
<tr class="notify-matrix__row notify-matrix__row--soon">
  <th scope="row">${t(locale, label)} <span class="notify-matrix__soon">${t(locale, 'settings.notifications.soon')}</span></th>
  <td><span class="notify-matrix__state" aria-disabled="true">${t(locale, 'settings.notifications.stateOff')}</span></td>
</tr>`;
}

/**
 * Обязательная категория: переключателя нет, объяснение есть.
 *
 * Запрет держит сервер, но и в разметке строка выглядит как запертая: иначе
 * человек тратит попытку на переключатель, который не сработает (F-03-10 §5).
 */
function lockedRow({ locale, csrf, label, hint }) {
  return html`
<tr class="notify-matrix__row notify-matrix__row--locked">
  <th scope="row">${t(locale, label)}</th>
  <td>
    <form class="notify-matrix__form" method="post" action="/${locale}/settings/notifications">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="category" value="moderation">
      <input type="hidden" name="channel" value="in_service">
      <button class="field__switch" type="submit" role="switch" aria-checked="true" disabled
              aria-describedby="notify-mandatory">
        <span class="field__switch-box" aria-hidden="true"></span>
        <span class="field__switch-text">${t(locale, 'settings.notifications.stateOn')}</span>
      </button>
    </form>
    <p class="field__hint" id="notify-mandatory">${t(locale, hint)}</p>
  </td>
</tr>`;
}

/**
 * Безопасность: пароль, 2FA и устройства (F-01-06 §4).
 *
 * Три формы на одной странице: дела одного рода, и разводить их по вкладкам
 * незачем. Кнопка «Отключить 2FA» служебной роли не выводится (R-SEC-03), но
 * запрет держит сервер — скрытая кнопка обходится прямым запросом.
 */
function security({
  locale, csrf, user, error, staff = false, values = null,
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
  ${backupCodesList({ locale, codes: backupCodes })}
</div>`)}

<form class="form settings__form" method="post" action="/${locale}/settings/security" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">

  <h2 class="settings__subhead">${t(locale, 'settings.security.devices')}</h2>

  ${when(devices.length, () => html`
  <ul class="settings__devices">
    ${devices.map((device) => html`
    <li class="settings__device">
      <div class="settings__device-main">
        <span class="settings__device-label">${device.device_label ?? t(locale, 'settings.security.device')}</span>
        ${when(device.current, () => html`<span class="settings__device-here"
          >${t(locale, 'settings.security.thisDevice')}</span>`)}
        <span class="settings__device-meta"
          >${t(locale, 'settings.security.signedIn', { date: dateTime(locale, device.created_at) })}</span>
        ${when(device.ip_prefix, () => html`<span class="settings__device-meta"
          >${t(locale, 'settings.security.from', { ip: device.ip_prefix })}</span>`)}
      </div>
      <button class="button button--quiet" type="submit" name="session" value="${device.id}"
        >${t(locale, 'settings.security.revoke')}</button>
    </li>`)}
  </ul>

  ${when(devices.filter((device) => !device.current).length, () => html`
  <button class="button button--quiet" type="submit" name="action" value="revoke_others"
    >${t(locale, 'settings.security.revokeOthers')}</button>`)}
`)}

  ${when(!devices.length, () => html`
  <p class="field__hint">${t(locale, 'settings.security.devicesEmpty')}</p>`)}
${when(devices.length && !devices.some((device) => device.current), () => html`
  <p class="field__hint">${t(locale, 'settings.security.devicesOnlyCurrent')}</p>`)}
</form>

<form class="form settings__form" method="post" action="/${locale}/settings/security" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="email">

  <h2 class="settings__subhead">${t(locale, 'settings.security.email')}</h2>

  <p class="settings__state">${t(locale, 'settings.security.emailNow', { email: user?.email ?? '' })}</p>

  <div class="field">
    <label class="field__label" for="new_email">${t(locale, 'settings.security.emailNew')}</label>
    <input class="field__input" id="new_email" name="email" type="email"
           autocomplete="email" value="${values?.email ?? ''}" required>
    <p class="field__hint">${t(locale, 'settings.security.emailNew.hint')}</p>
  </div>

  <div class="field">
    <label class="field__label" for="email_password">${t(locale, 'settings.security.confirm')}</label>
    <input class="field__input" id="email_password" name="password" type="password"
           autocomplete="current-password" required>
  </div>

  <button class="button form__submit" type="submit"
    >${t(locale, 'settings.security.emailChange')}</button>
</form>`;
}

/**
 * «Данные»: две карточки-действия (F-01-10 §19).
 *
 * Карточек две, а не одна форма с двумя кнопками: экспорт ничего не меняет, а
 * удаление меняет всё, и одна форма выглядела бы как равные по тяжести
 * действия. Красным помечено только подтверждение удаления — §19.
 */
function data({ locale, csrf, user, exportJob = null }) {
  const ready = user?.delete_requested_at
    ? t(locale, 'settings.data.delete.lead')
    : '';

  return html`
<form class="form settings__form" method="post" action="/${locale}/settings/data" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="export">

  <h2 class="settings__subhead">${t(locale, 'settings.data.export.title')}</h2>

  <p class="field__hint">${t(locale, 'settings.data.export.lead')}</p>

  ${when(exportJob, () => html`
  <p class="settings__state">${t(locale, `settings.data.export.state.${exportJob.status}`)}</p>`)}

  <div class="field">
    <label class="field__label" for="export_password">${
  t(locale, 'settings.security.confirm')}</label>
    <input class="field__input" id="export_password" name="password" type="password"
           autocomplete="current-password" required>
  </div>

  <button class="button form__submit" type="submit"
    >${t(locale, 'settings.data.export.action')}</button>
</form>

<form class="form settings__form" method="post" action="/${locale}/settings/data" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="delete">

  <h2 class="settings__subhead">${t(locale, 'settings.data.delete.title')}</h2>

  <p class="field__hint">${ready || t(locale, 'settings.data.delete.lead')}</p>

  <button class="button button--danger form__submit" type="submit"
    >${t(locale, 'settings.data.delete.action')}</button>
</form>`;
}

/**
 * Подтверждение удаления: перечень последствий, пароль и отметка о материалах.
/**
 * Подтверждение удаления: перечень последствий, пароль и отметка о материалах.
 *
 * Отдельный адрес, а не вкладка внутри настроек: R-SEC-12 требует
 * подтверждения с перечнем последствий, и перечень должен быть виден целиком,
 * а не вкладкой, которую можно закрыть, не прочитав.
 */
export function deleteConfirm({ locale, csrf, error, values }) {
  const whats = ['email', 'nick', 'settings', 'marks', 'materials'];

  return html`
<form class="form settings__form" method="post" action="/${locale}/settings/data/delete" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">

  <h2 class="settings__subhead">${t(locale, 'settings.delete.title')}</h2>

  <div class="form__status" role="alert" aria-live="assertive">
    ${when(error, () => html`<p class="form__error">${error}</p>`)}
  </div>

  <p class="form__text">${t(locale, 'settings.delete.lead')}</p>

  <ul class="settings__consequences">
    ${whats.map((what) => html`
    <li class="settings__consequence">${t(locale, `settings.delete.what.${what}`)}</li>`)}
  </ul>

  <div class="field">
    <label class="field__label" for="delete_password">${
  t(locale, 'settings.security.confirm')}</label>
    <input class="field__input" id="delete_password" name="password" type="password"
           autocomplete="current-password" required>
  </div>

  <div class="field field--switch">
    <input class="field__checkbox" type="checkbox" id="delete_materials" name="delete_materials"
           ${values?.deleteMaterials ? raw('checked') : ''}>
    <label class="field__switch-label" for="delete_materials">
      <span class="field__switch-text">${t(locale, 'settings.data.delete.materials')}</span>
      <span class="field__hint">${t(locale, 'settings.data.delete.materials.hint')}</span>
    </label>
  </div>

  <button class="button button--danger form__submit" type="submit"
    >${t(locale, 'settings.delete.confirm')}</button>
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