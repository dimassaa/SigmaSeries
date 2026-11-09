// Здоровье системы (F-09-06, S-82).
//
// Экран наблюдает, а не управляет: единственное действие — проверка
// восстановления копии, продублированная из S-83. Строки идут не по порядку
// разделов, а по состоянию: сломанное первым, «может сломаться» следом.
// Состояние всегда написано словом — цвет только помогает (R-A11Y-19).

import { html, when } from './render.js';
import { t } from '../i18n/strings.js';

/** Подписи метрик: ключ строки соответствует `classifyHealth`. */
const LABELS = {
  moderation: 'admin.health.metric.moderation',
  backup: 'admin.health.metric.backup',
  errors: 'admin.health.metric.errors',
  response: 'admin.health.metric.response',
  tasks: 'admin.health.metric.tasks',
  disk: 'admin.health.metric.disk',
  eventLoop: 'admin.health.metric.eventLoop',
  online: 'admin.health.metric.online',
};

/** Имена работников из реестра задач: внутреннее имя не показывается как есть. */
const TASK_LABELS = {
  banners: 'admin.health.task.banners',
  online: 'admin.health.task.online',
  'collection-rules': 'admin.health.task.collectionRules',
  notifications: 'admin.health.task.notifications',
  recap: 'admin.health.task.recap',
  ratings: 'admin.health.task.ratings',
  backup: 'admin.health.task.backup',
  moderation: 'admin.health.task.moderation',
  mail: 'admin.health.task.mail',
  deletion: 'admin.health.task.deletion',
  unverified: 'admin.health.task.unverified',
  mail_purge: 'admin.health.task.mail_purge',
  export: 'admin.health.task.export',
  import: 'admin.health.task.import',
};

/**
 * Экран здоровья.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {any} args.data
 * @param {string|null} [args.csrf]
 * @returns {any}
 */
export function adminHealthView({ locale, data = {}, csrf = null }) {
  const metrics = data.metrics ?? [];
  const errors = data.errors ?? { series: [] };
  const response = data.response ?? { routes: [], series: [] };
  const tasks = data.tasks ?? { items: [] };
  const focusIndex = metrics.findIndex((item) => item.severity === 'problem');

  return html`
<div class="admin-health">
  <h1 class="admin-health__title">${t(locale, 'admin.health.title')}</h1>
  <p class="admin-health__lead">${t(locale, 'admin.health.description')}</p>

  <!-- Скелетон нужен состоянию загрузки; серверный рендер отдаёт данные
       сразу, поэтому здесь он скрыт, но его шесть строк задают высоту. -->
  <div class="admin-health__skeleton" hidden aria-hidden="true">
    ${[1, 2, 3, 4, 5, 6].map(() => html`<span class="admin-health__skeleton-row"></span>`)}
  </div>

  ${when(!metrics.length, () => html`
  <p class="empty">${t(locale, 'admin.health.noData')}</p>`)}

  <ul class="admin-health__list" role="list">
    ${metrics.map((item, index) => html`
    <li class="admin-health__row admin-health__row--${item.severity}" data-state="${item.severity}"
      ${index === focusIndex ? html`tabindex="-1" data-health-focus` : ''}>
      <span class="admin-health__state">${t(locale, `admin.health.state.${item.severity}`)}</span>
      <span class="admin-health__label">${t(locale, LABELS[item.key] ?? item.key)}</span>
      <span class="admin-health__value">${valueOf(locale, item)}</span>
      <span class="admin-health__text">${t(locale, item.textKey, { value: item.value, ...(item.textParams ?? {}) })}</span>
      ${when(item.link, () => html`
      <a class="admin-health__link" href="/${locale}${item.link}">${t(locale, 'admin.health.open')}</a>`)}
    </li>`)}
  </ul>

  <form class="admin-health__verify" method="post" action="/${locale}/admin/backups/verify">
    <input type="hidden" name="csrf" value="${csrf ?? ''}">
    <input type="hidden" name="return" value="health">
    <button class="button button--primary" type="submit">${t(locale, 'admin.health.verify')}</button>
    <span class="admin-health__hint">${t(locale, 'admin.health.verify.hint')}</span>
  </form>

  <section class="admin-health__charts" aria-labelledby="h-health-charts">
    <h2 class="admin-health__section-title" id="h-health-charts">${t(locale, 'admin.health.charts')}</h2>

    <details class="admin-health__chart">
      <summary>${t(locale, 'admin.health.chart.errors')}</summary>
      ${chartTable(locale, errors.series, 'count')}
    </details>

    <details class="admin-health__chart">
      <summary>${t(locale, 'admin.health.chart.response')}</summary>
      ${chartTable(locale, response.series, 'p95')}
    </details>

    <details class="admin-health__chart">
      <summary>${t(locale, 'admin.health.chart.routes')}</summary>
      ${when(response.routes?.length, () => html`
      <table class="admin-health__table">
        <caption class="visually-hidden">${t(locale, 'admin.health.chart.routes')}</caption>
        <thead>
          <tr>
            <th scope="col">${t(locale, 'admin.health.chart.route')}</th>
            <th scope="col">${t(locale, 'admin.health.chart.requests')}</th>
            <th scope="col">${t(locale, 'admin.health.chart.p95')}</th>
          </tr>
        </thead>
        <tbody>
          ${response.routes.map((row) => html`
          <tr>
            <td class="admin-health__route">${row.route}</td>
            <td>${row.count}</td>
            <td>${row.p95 === null ? t(locale, 'admin.health.chart.noData') : `${row.p95} ${t(locale, 'admin.health.unit.ms')}`}</td>
          </tr>`)}
        </tbody>
      </table>`, () => html`
      <p class="empty">${t(locale, 'admin.health.chart.noData')}</p>`)}
    </details>
  </section>

  <section class="admin-health__tasks" aria-labelledby="h-health-tasks">
    <h2 class="admin-health__section-title" id="h-health-tasks">${t(locale, 'admin.health.tasks.title')}</h2>
    ${taskTable(locale, tasks.items ?? [])}
  </section>
</div>`;
}

/**
 * Значение метрики в её единице.
 *
 * @param {string} locale
 * @param {any} item
 * @returns {string}
 */
function valueOf(locale, item) {
  if (item.value === null || item.value === undefined) return t(locale, 'admin.health.noData');
  const number = new Intl.NumberFormat(locale).format(item.value);
  if (item.unit === 'ms') return `${number} ${t(locale, 'admin.health.unit.ms')}`;
  if (item.unit === 'percent') return `${number}%`;
  if (item.unit === 'hours') return `${number} ${t(locale, 'admin.health.unit.hours')}`;
  return number;
}

/**
 * Последний результат каждой задачи: имя, состояние, время, длительность и
 * ошибка. Состояние — словом, а не цветом (R-A11Y-19).
 *
 * @param {string} locale
 * @param {any[]} items
 * @returns {any}
 */
function taskTable(locale, items = []) {
  if (!items.length) return html`<p class="empty">${t(locale, 'admin.health.noData')}</p>`;

  return html`
  <div class="admin-health__table-wrap">
  <table class="admin-health__table">
    <caption class="visually-hidden">${t(locale, 'admin.health.tasks.title')}</caption>
    <thead>
      <tr>
        <th scope="col">${t(locale, 'admin.health.tasks.task')}</th>
        <th scope="col">${t(locale, 'admin.health.tasks.state')}</th>
        <th scope="col">${t(locale, 'admin.health.tasks.lastRun')}</th>
        <th scope="col">${t(locale, 'admin.health.tasks.duration')}</th>
        <th scope="col">${t(locale, 'admin.health.tasks.error')}</th>
      </tr>
    </thead>
    <tbody>
      ${items.map((item) => {
        const state = ['ok', 'error', 'unknown'].includes(item.state) ? item.state : 'unknown';
        const labelKey = TASK_LABELS[item.name];
        const label = labelKey ? t(locale, labelKey) : String(item.name ?? '');
        return html`
      <tr>
        <td>${label}</td>
        <td>${t(locale, `admin.health.task.state.${state}`)}</td>
        <td>${formatWhen(locale, item.lastRunAt)}</td>
        <td>${item.durationMs === null || item.durationMs === undefined
          ? t(locale, 'admin.health.tasks.noError')
          : `${new Intl.NumberFormat(locale).format(Math.round(item.durationMs))} ${t(locale, 'admin.health.unit.ms')}`}</td>
        <td class="${item.lastError ? 'admin-health__task-error' : ''}">${item.lastError || t(locale, 'admin.health.tasks.noError')}</td>
      </tr>`;
      })}
    </tbody>
  </table>
  </div>`;
}

/**
 * Дата и время последнего запуска.
 *
 * @param {string} locale
 * @param {any} value
 * @returns {string}
 */
function formatWhen(locale, value) {
  if (!value) return t(locale, 'admin.health.tasks.never');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t(locale, 'admin.health.tasks.never');
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

/**
 * Таблица по часам: значения и полоса для сравнения.
 *
 * @param {string} locale
 * @param {any[]} series
 * @param {'count'|'p95'} kind
 * @returns {any}
 */
function chartTable(locale, series = [], kind) {
  const values = series.map((point) => point[kind]).filter((value) => value !== null && value !== undefined);
  if (!values.length) return html`<p class="empty">${t(locale, 'admin.health.chart.noData')}</p>`;
  const max = Math.max(...values, 1);

  return html`
  <table class="admin-health__table">
    <caption class="visually-hidden">${t(locale, 'admin.health.chart.hours')}</caption>
    <thead>
      <tr>
        <th scope="col">${t(locale, 'admin.health.chart.hour')}</th>
        <th scope="col">${kind === 'count' ? t(locale, 'admin.health.chart.count') : t(locale, 'admin.health.chart.p95')}</th>
        <th scope="col"><span class="visually-hidden">${t(locale, 'admin.health.chart.bar')}</span></th>
      </tr>
    </thead>
    <tbody>
      ${series.map((point) => {
        const value = point[kind];
        return html`
      <tr>
        <td>${new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(point.hour)}</td>
        <td>${value === null || value === undefined
          ? t(locale, 'admin.health.chart.noData')
          : `${new Intl.NumberFormat(locale).format(value)}${kind === 'p95' ? ` ${t(locale, 'admin.health.unit.ms')}` : ''}`}</td>
        <td><progress class="admin-health__bar" value="${value ?? 0}" max="${max}">${value ?? 0}</progress></td>
      </tr>`;
      })}
    </tbody>
  </table>`;
}
