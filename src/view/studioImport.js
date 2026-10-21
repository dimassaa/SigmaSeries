// Экран «Импорт» (S-76, F-12-08).
//
// Три части, как в спеке: состояние и действия сверху, «Выходит с датами» и
// счётчики состояний в середине, плотность календаря по неделям; ниже —
// таблица запусков и детали выбранного запуска.
//
// Числа на экране измеренные: сколько сериалов выходит и у скольких есть даты,
// сколько выходов в каждой неделе. Планки «сколько должно быть» на экране
// нет — её нет и в спецификации (F-12-08 §6: порог в 25 выходов в неделю
// выполняется в семь раз на старте и не выполняется в декабре, то есть
// ничего не ловит).

import { html, raw, when } from './render.js';
import { t } from '../i18n/strings.js';
import { fullDate } from './dates.js';

/** Состояния сериала в порядке показа — как в спеке (F-12-08 §3). */
const STATES = ['airing', 'waiting', 'ended', 'cancelled', 'announced'];

/**
 * Экран отчёта об импорте.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.overview состояние и покрытие
 * @param {object[]} args.runs запуски
 * @param {object|null} args.detail детали выбранного запуска
 * @param {object} args.mode состояние режима
 * @param {number|null} args.selected номер выбранного запуска
 * @param {string} args.csrf
 * @returns {string}
 */
export function studioImportView({
  locale, overview, runs = [], detail = null, mode = {}, selected = null, csrf = '',
}) {
  return html`
<div class="studio studio--import">
  <h1 class="studio__title">${t(locale, 'studio.import.title')}</h1>

  <div class="studio-import__mode">
    <p class="studio-import__mode-state">
      ${t(locale, mode.frozen ? 'studio.import.mode.frozen' : 'studio.import.mode.work')}
      ${when(mode.frozen && mode.since, () => html`
      <span class="studio-import__mode-since">${t(locale, 'studio.import.mode.since', { date: mode.since })}</span>`)}
    </p>
  </div>

  ${when(runs.length === 0, () => html`
  <p class="empty">${t(locale, 'studio.import.empty')}</p>`)}

  ${when(runs.length > 0, () => html`
  ${coverage({ locale, overview })}
  ${density({ locale, overview })}
  ${runsTable({ locale, runs, selected })}
  ${when(detail, () => runDetail({ locale, detail, csrf }))}`)}
</div>`;
}

/** «Выходит с датами N из M» и счётчики состояний. */
function coverage({ locale, overview }) {
  const share = overview.total > 0
    ? Math.round((overview.withDates / overview.total) * 100)
    : 0;

  return html`
<section class="studio-import__coverage" aria-labelledby="h-import-coverage">
  <h2 class="studio__section-title" id="h-import-coverage">${t(locale, 'studio.import.coverage')}</h2>

  <p class="studio-import__key">
    <span class="studio-import__key-value">${overview.withDates}</span>
    <span class="studio-import__key-of">${t(locale, 'studio.import.of', { total: overview.total })}</span>
    <span class="studio-import__key-share">${share}%</span>
  </p>

  <ul class="studio-import__states" role="list">
    ${STATES.map((state) => html`
    <li class="studio-import__state">
      <span class="studio-import__state-name">${t(locale, `studio.import.state.${state}`)}</span>
      <span class="studio-import__state-count">${overview.states[state] ?? 0}</span>
    </li>`)}
  </ul>
</section>`;
}

/** Плотность календаря по неделям. */
function density({ locale, overview }) {
  const max = overview.weeks.reduce((sum, week) => Math.max(sum, week.count), 0);

  return html`
<section class="studio-import__density" aria-labelledby="h-import-density">
  <h2 class="studio__section-title" id="h-import-density">
    ${t(locale, 'studio.import.density', { date: fullDate(locale, overview.until) })}
  </h2>
  ${when(overview.weeks.length === 0, () => html`
  <p class="empty">${t(locale, 'studio.import.density.empty')}</p>`)}
  ${when(overview.weeks.length > 0, () => html`
  <ol class="studio-import__bars" role="list">
    ${overview.weeks.map((week) => html`
    <li class="studio-import__bar">
      <span class="studio-import__bar-fill" style="height: ${max > 0 ? Math.round((week.count / max) * 100) : 0}%"></span>
      <span class="studio-import__bar-count">${week.count}</span>
      <span class="visually-hidden">${t(locale, 'studio.import.week', {
        date: fullDate(locale, week.week),
        count: week.count,
      })}</span>
    </li>`)}
  </ol>`)}
</section>`;
}

/** Таблица запусков. */
function runsTable({ locale, runs, selected }) {
  return html`
<section class="studio-import__runs" aria-labelledby="h-import-runs">
  <h2 class="studio__section-title" id="h-import-runs">${t(locale, 'studio.import.runs')}</h2>
  <div class="studio-import__table-wrap">
    <table class="studio-import__runs-table">
      <thead>
        <tr>
          <th scope="col">${t(locale, 'studio.import.run.started')}</th>
          <th scope="col">${t(locale, 'studio.import.run.kind')}</th>
          <th scope="col">${t(locale, 'studio.import.run.status')}</th>
          <th scope="col">${t(locale, 'studio.import.run.duration')}</th>
          <th scope="col">${t(locale, 'studio.import.run.errors')}</th>
        </tr>
      </thead>
      <tbody>
        ${runs.map((run) => html`
        <tr${run.id === selected ? raw(' class="is-selected"') : ''}>
          <td>
            <a href="?run=${run.id}">${run.startedAt ? fullDate(locale, run.startedAt.toISOString().slice(0, 10)) : '—'}</a>
          </td>
          <td>${t(locale, `studio.import.kind.${run.kind}`)}</td>
          <td>${t(locale, `studio.import.status.${run.status}`)}</td>
          <td>${duration(run)}</td>
          <td>${run.counters.error ?? run.counters.errors ?? 0}</td>
        </tr>`)}
      </tbody>
    </table>
  </div>
</section>`;
}

/** Детали запуска: счётчики и исходы по позициям. */
function runDetail({ locale, detail, csrf }) {
  const { run, items, byOutcome, page, pages, total, outcome } = detail;

  return html`
<section class="studio-import__detail" aria-labelledby="h-import-detail">
  <h2 class="studio__section-title" id="h-import-detail">
    ${t(locale, 'studio.import.detail', { id: run.id })}
  </h2>

  <dl class="studio-import__counters">
    ${Object.entries(run.counters ?? {}).map(([key, value]) => html`
    <div class="studio-import__counter">
      <dt>${t(locale, `studio.import.counter.${key}`)}</dt>
      <dd>${value}</dd>
    </div>`)}
  </dl>

  <form class="studio-import__filter" method="get" action="">
    <input type="hidden" name="run" value="${run.id}">
    <label for="import-outcome">${t(locale, 'studio.import.filter')}</label>
    <select id="import-outcome" name="outcome">
      <option value=""${raw(outcome ? '' : ' selected')}>${t(locale, 'studio.import.filter.all')}</option>
      ${Object.entries(byOutcome).map(([key, count]) => html`
      <option value="${key}"${raw(outcome === key ? ' selected' : '')}>
        ${t(locale, `studio.import.outcome.${key}`)} (${count})
      </option>`)}
    </select>
    <button class="button button--quiet" type="submit">${t(locale, 'studio.import.filter.apply')}</button>
  </form>

  ${when(items.length === 0, () => html`
  <p class="empty">${t(locale, 'studio.import.items.empty')}</p>`)}

  ${when(items.length > 0, () => html`
  <div class="studio-import__table-wrap">
    <table class="studio-import__items-table">
      <thead>
        <tr>
          <th scope="col">${t(locale, 'studio.import.item.tconst')}</th>
          <th scope="col">${t(locale, 'studio.import.item.stage')}</th>
          <th scope="col">${t(locale, 'studio.import.item.outcome')}</th>
          <th scope="col">${t(locale, 'studio.import.item.reasons')}</th>
        </tr>
      </thead>
      <tbody>
        ${items.map((item) => html`
        <tr>
          <td>${item.tconst}</td>
          <td>${t(locale, `studio.import.stage.${item.stage}`)}</td>
          <td>${t(locale, `studio.import.outcome.${item.outcome}`)}</td>
          <td>${(item.reasons ?? []).join(', ')}</td>
        </tr>`)}
      </tbody>
    </table>
  </div>

  ${when(pages > 1, () => html`
  <nav class="pagination" aria-label="${t(locale, 'studio.import.items.title')}">
    ${when(page > 1, () => html`
    <a class="pagination__step" href="?run=${run.id}&amp;outcome=${outcome}&amp;page=${page - 1}" rel="prev">${t(locale, 'catalog.pagination.prev')}</a>`)}
    <span class="pagination__item">${page} / ${pages} · ${total}</span>
    ${when(page < pages, () => html`
    <a class="pagination__step" href="?run=${run.id}&amp;outcome=${outcome}&amp;page=${page + 1}" rel="next">${t(locale, 'catalog.pagination.next')}</a>`)}
  </nav>`)}`)}
</section>`;
}

/** Длительность запуска: от начала до конца. */
function duration(run) {
  if (!run.startedAt || !run.finishedAt) return '—';
  const minutes = Math.max(0, Math.round((run.finishedAt - run.startedAt) / 60000));
  return `${minutes} мин`;
}
