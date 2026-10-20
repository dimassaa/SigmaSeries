// Список пользователей и карточка человека (F-09-01, F-09-02, S-71, S-72).
//
// Список — таблица: администратор ищет человека среди тысяч, и ему нужны
// числа, а не карточки. Фильтры показываются строкой чипов: их много, и
// потерять их легко, а пустой результат без объяснения — это тупик (F-09-01 §5).

import { html, when, raw } from './render.js';
import { t } from '../i18n/strings.js';
import { dayLabel } from './dates.js';

const ROLE_KEYS = ['admin', 'editor', 'analyst'];

/**
 * Список пользователей.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.list
 * @param {object} args.query параметры адреса (для чипов фильтров)
 * @returns {string}
 */
export function adminUsersView({ locale, list, query = {} }) {
  const { items = [], total = 0, page = 1, pages = 1 } = list;
  const chips = [];
  if (query.nickname) chips.push({ key: 'nickname', value: String(query.nickname) });
  if (query.email) chips.push({ key: 'email', value: String(query.email) });
  for (const role of [].concat(query.role ?? []).filter(Boolean)) {
    chips.push({ key: 'role', value: String(role) });
  }
  if (query.status) chips.push({ key: 'status', value: String(query.status) });
  if (query.from) chips.push({ key: 'from', value: String(query.from) });
  if (query.to) chips.push({ key: 'to', value: String(query.to) });

  return html`
<div class="admin-users">
  <h1 class="admin-users__title">${t(locale, 'admin.users.title')}</h1>

  <form class="admin-users__filters" method="get" action="/${locale}/admin/users">
    <label class="visually-hidden" for="admin-nickname">${t(locale, 'admin.users.filter.nickname')}</label>
    <input class="field__input" id="admin-nickname" type="search" name="nickname"
      value="${query.nickname ?? ''}" placeholder="${t(locale, 'admin.users.filter.nickname')}">

    <label class="visually-hidden" for="admin-email">${t(locale, 'admin.users.filter.email')}</label>
    <input class="field__input" id="admin-email" type="search" name="email"
      value="${query.email ?? ''}" placeholder="${t(locale, 'admin.users.filter.email')}">

    <label class="visually-hidden" for="admin-role">${t(locale, 'admin.users.filter.role')}</label>
    <select class="field__input" id="admin-role" name="role" multiple size="3">
      ${ROLE_KEYS.map((role) => html`
      <option value="${role}" ${String(query.role ?? '') === role ? raw('selected') : raw('')}
        >${t(locale, `admin.role.${role}`)}</option>`)}
    </select>

    <label class="visually-hidden" for="admin-status">${t(locale, 'admin.users.filter.status')}</label>
    <select class="field__input" id="admin-status" name="status">
      <option value="">${t(locale, 'admin.users.filter.anyStatus')}</option>
      ${['active', 'muted', 'banned', 'deleting', 'deleted'].map((status) => html`
      <option value="${status}" ${String(query.status ?? '') === status ? raw('selected') : raw('')}
        >${t(locale, `admin.user.status.${status}`)}</option>`)}
    </select>

    <button class="button button--primary" type="submit">${t(locale, 'admin.users.filter.apply')}</button>
  </form>

  ${when(chips.length, () => html`
  <p class="admin-users__chips">
    ${chips.map((chip) => html`
    <span class="admin-users__chip">${t(locale, `admin.users.filter.${chip.key}`)}: ${chip.value}</span>`)}
    <a class="admin-users__reset" href="/${locale}/admin/users">${t(locale, 'admin.users.filter.reset')}</a>
  </p>`)}

  ${when(!items.length, () => html`
  <p class="empty">${t(locale, 'admin.users.empty')}</p>`)}

  ${when(items.length, () => html`
  <table class="admin-users__table">
    <caption class="visually-hidden">${t(locale, 'admin.users.title')}</caption>
    <thead>
      <tr>
        <th scope="col">${t(locale, 'admin.users.column.nickname')}</th>
        <th scope="col">${t(locale, 'admin.users.column.email')}</th>
        <th scope="col">${t(locale, 'admin.users.column.registered')}</th>
        <th scope="col">${t(locale, 'admin.users.column.role')}</th>
        <th scope="col">${t(locale, 'admin.users.column.status')}</th>
        <th scope="col">${t(locale, 'admin.users.column.ratings')}</th>
        <th scope="col">${t(locale, 'admin.users.column.materials')}</th>
      </tr>
    </thead>
    <tbody>
      ${items.map((item) => html`
      <tr class="admin-users__row">
        <th scope="row">
          <a class="admin-users__link" href="/${locale}/admin/users/${item.id}">${item.nickname}</a>
        </th>
        <td class="admin-users__email">${item.address ?? '—'}</td>
        <td class="admin-users__date">${dayLabel(locale, item.registeredAt)}</td>
        <td class="admin-users__roles">
          ${item.roles.length
            ? item.roles.map((role) => t(locale, `admin.role.${role}`)).join(', ')
            : '—'}
        </td>
        <td class="admin-users__status">${t(locale, `admin.user.status.${item.status}`)}</td>
        <td class="admin-users__number">${item.ratings}</td>
        <td class="admin-users__number">${item.materials}</td>
      </tr>`)}
    </tbody>
  </table>

  ${when(pages > 1, () => html`
  <nav class="admin-users__pages" aria-label="${t(locale, 'admin.users.pages')}">
    ${Array.from({ length: pages }, (_, index) => index + 1).map((number) => html`
    <a class="admin-users__page${number === page ? ' admin-users__page--on' : ''}"
      href="/${locale}/admin/users?page=${number}"
      ${number === page ? raw('aria-current="page"') : raw('')}>${number}</a>`)}
  </nav>`)}
  <p class="admin-users__total">${t(locale, 'admin.users.total', { count: total })}</p>`)}
</div>`;
}

/**
 * Карточка пользователя.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.user
 * @returns {string}
 */
export function adminUserView({ locale, user }) {
  return html`
<div class="admin-user">
  <h1 class="admin-user__title">${user.nickname}</h1>

  <dl class="admin-user__facts">
    <dt>${t(locale, 'admin.user.fact.address')}</dt>
    <dd>${user.address ?? '—'}</dd>
    <dt>${t(locale, 'admin.user.fact.registered')}</dt>
    <dd>${dayLabel(locale, user.registeredAt)}</dd>
    <dt>${t(locale, 'admin.user.fact.status')}</dt>
    <dd>${t(locale, `admin.user.status.${user.status}`)}</dd>
    <dt>${t(locale, 'admin.user.fact.roles')}</dt>
    <dd>${user.roles.length ? user.roles.map((role) => t(locale, `admin.role.${role}`)).join(', ') : '—'}</dd>
    <dt>${t(locale, 'admin.user.fact.counts')}</dt>
    <dd>${t(locale, 'admin.user.fact.counts', { ratings: user.ratings, materials: user.materials })}</dd>
  </dl>

  ${when(user.restrictions.length, () => html`
  <section class="admin-user__restrictions">
    <h2 class="admin-user__section-title">${t(locale, 'admin.user.restrictions')}</h2>
    <ul class="admin-user__list" role="list">
      ${user.restrictions.map((item) => html`
      <li class="admin-user__restriction">
        <span class="admin-user__restriction-kind">${t(locale, `admin.user.restriction.${item.kind}`)}</span>
        <span class="admin-user__restriction-reason">${item.reason}</span>
        ${when(item.expiresAt, () => html`
        <span class="admin-user__restriction-until">${t(locale, 'admin.user.restriction.until', { date: dayLabel(locale, item.expiresAt) })}</span>`)}
      </li>`)}
    </ul>
  </section>`)}

  <section class="admin-user__materials">
    <h2 class="admin-user__section-title">${t(locale, 'admin.user.materials')}</h2>
    ${when(user.materialList.length, () => html`
    <ul class="admin-user__list" role="list">
      ${user.materialList.map((item) => html`
      <li class="admin-user__material">
        <span>${t(locale, `my.content.kind.${item.kind}`)}</span>
        <span class="admin-user__material-state">${t(locale, `my.content.state.${item.state}`)}</span>
        <span class="admin-user__material-date">${dayLabel(locale, item.submittedAt)}</span>
      </li>`)}
    </ul>`, () => html`<p class="empty">${t(locale, 'admin.user.noMaterials')}</p>`)}
  </section>

  ${when(user.decisions.length, () => html`
  <section class="admin-user__decisions">
    <h2 class="admin-user__section-title">${t(locale, 'admin.user.decisions')}</h2>
    <ul class="admin-user__list" role="list">
      ${user.decisions.map((item) => html`
      <li class="admin-user__decision">
        <span>${t(locale, `my.content.state.${item.decision === 'approved' ? 'approved' : 'rejected'}`)}</span>
        <span class="admin-user__decision-reason">${item.reason}</span>
        <span class="admin-user__decision-date">${dayLabel(locale, item.decidedAt)}</span>
      </li>`)}
    </ul>
  </section>`)}
</div>`;
}
