// Резервные копии (F-09-04, S-82).
//
// Статус копии — главное, а не размер: «проверена» означает, что копию
// восстановили во временную базу и она ответила. Копия, которая только что
// записалась, «непроверенной» не считается.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';
import { dayLabel } from './dates.js';

/**
 * Экран резервных копий.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object[]} args.copies
 * @param {{hour: number, minute: number}|null} args.schedule
 * @param {string|null} args.csrf
 * @returns {string}
 */
export function backupsView({ locale, copies = [], schedule = null, csrf = null }) {
  return html`
<div class="admin-backups">
  <h1 class="admin-backups__title">${t(locale, 'admin.backups.title')}</h1>

  <p class="admin-backups__schedule">
    ${when(schedule, () => html`${t(locale, 'admin.backups.schedule', {
      time: `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`,
    })}`, () => html`${t(locale, 'admin.backups.schedule.unknown')}`)}
  </p>

  <form class="admin-backups__run" method="post" action="/${locale}/admin/backups/run">
    <input type="hidden" name="csrf" value="${csrf ?? ''}">
    <button class="button button--primary" type="submit">${t(locale, 'admin.backups.run')}</button>
  </form>

  ${when(!copies.length, () => html`
  <p class="empty">${t(locale, 'admin.backups.empty')}</p>`)}

  ${when(copies.length, () => html`
  <table class="admin-backups__table">
    <caption class="visually-hidden">${t(locale, 'admin.backups.title')}</caption>
    <thead>
      <tr>
        <th scope="col">${t(locale, 'admin.backups.column.when')}</th>
        <th scope="col">${t(locale, 'admin.backups.column.status')}</th>
        <th scope="col">${t(locale, 'admin.backups.column.size')}</th>
        <th scope="col">${t(locale, 'admin.backups.column.checked')}</th>
      </tr>
    </thead>
    <tbody>
      ${copies.map((item) => html`
      <tr class="admin-backups__row">
        <td class="admin-backups__when">${dayLabel(locale, item.started_at ?? item.finished_at)}</td>
        <td class="admin-backups__status">${t(locale, `admin.backup.status.${item.status}`)}</td>
        <td class="admin-backups__size">${sizeOf(item.size_bytes)}</td>
        <td class="admin-backups__checked">${item.verified_at ? dayLabel(locale, item.verified_at) : '—'}</td>
      </tr>`)}
    </tbody>
  </table>`)}
</div>`;
}

/**
 * Размер копии — человеческим числом.
 *
 * @param {number|null} bytes
 * @returns {string}
 */
function sizeOf(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} МБ`;
}
