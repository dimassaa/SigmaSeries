// Настройки системы (S-83).
//
// Группы — по модулям, как в таблицах настроек: рейтинг (M4 §0), отзывы
// (M4 §0), модерация (M5 §0), администрирование (M9 §0). Ключ показан рядом
// с названием: по нему видно, что именно меняется, и его же ищут в коде.

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/** Группы: ключ модуля, подпись и ключи параметров. */
const GROUPS = [
  {
    id: 'rating',
    title: 'admin.settings.group.rating',
    keys: [
      'rating.prior_weight_m',
      'rating.prior_mean_default',
      'rating.min_votes_display',
      'rating.min_account_age_h',
      'rating.rate_per_hour',
    ],
  },
  {
    id: 'review',
    title: 'admin.settings.group.review',
    keys: [
      'review.len_min',
      'review.len_max',
      'review.short_max_chars',
      'review.long_min_chars',
      'review.page_size',
      'review.top_on_series_page',
      'review.read_more_chars',
      'review.helpful_rate_per_hour',
      'review.report_rate_per_day',
    ],
  },
  {
    id: 'moderation',
    title: 'admin.settings.group.moderation',
    keys: [
      'ugc.link_forbidden',
      'ugc.recheck_cooldown_min',
      'mod.submission_rate_per_min',
      'mod.auto_block_share',
      'mod.cluster_window_h',
      'mod.cluster_min_size',
      'mod.queue_target_min',
    ],
  },
  {
    id: 'admin',
    title: 'admin.settings.group.admin',
    keys: [
      'admin.online_window_min',
      'admin.online_avg_hours',
      'admin.user_page_size',
      'admin.delete_grace_days',
      'audit.retention_days',
      'backup.schedule',
      'backup.keep_last',
    ],
  },
];

/**
 * Экран настроек.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.values текущие значения (ключ → значение)
 * @param {string|null} [args.csrf]
 * @returns {string}
 */
export function systemSettingsView({ locale, values = {}, csrf = null }) {
  return html`
<div class="admin-settings">
  <h1 class="admin-settings__title">${t(locale, 'admin.settings.title')}</h1>
  <p class="admin-settings__note">${t(locale, 'admin.settings.note')}</p>

  ${GROUPS.map((group) => html`
  <section class="admin-settings__group">
    <h2 class="admin-settings__group-title">${t(locale, group.title)}</h2>
    <table class="admin-settings__table">
      <caption class="visually-hidden">${t(locale, group.title)}</caption>
      <thead>
        <tr>
          <th scope="col">${t(locale, 'admin.settings.column.parameter')}</th>
          <th scope="col">${t(locale, 'admin.settings.column.value')}</th>
          <th scope="col">${t(locale, 'admin.settings.column.change')}</th>
        </tr>
      </thead>
      <tbody>
        ${group.keys.map((key) => html`
        <tr class="admin-settings__row">
          <th scope="row" class="admin-settings__key">
            <code>${key}</code>
            <span class="admin-settings__label">${t(locale, `admin.settings.key.${key}`)}</span>
          </th>
          <td class="admin-settings__value">${values[key] ?? '—'}</td>
          <td class="admin-settings__change">
            <form class="admin-settings__form" method="post" action="/${locale}/admin/settings">
              <input type="hidden" name="csrf" value="${csrf ?? ''}">
              <input type="hidden" name="key" value="${key}">
              <label class="visually-hidden" for="setting-${key}">${t(locale, 'admin.settings.column.value')}</label>
              <input class="field__input" id="setting-${key}" name="value" type="text"
                value="${values[key] ?? ''}">
              <label class="visually-hidden" for="reason-${key}">${t(locale, 'admin.settings.reason')}</label>
              <input class="field__input" id="reason-${key}" name="reason" type="text" required
                placeholder="${t(locale, 'admin.settings.reason')}">
              <button class="button button--primary" type="submit">${t(locale, 'admin.settings.save')}</button>
            </form>
          </td>
        </tr>`)}
      </tbody>
    </table>
  </section>`)}
</div>`;
}
