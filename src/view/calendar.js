// S-16 — календарь выхода серий.
// Спецификация: docs/01-product/features/M3-tracking.md, F-03-05.
//
// Три вида спрашивают одни и те же данные и различаются только разметкой:
//
//   Месяц  — таблица, в ячейке до трёх записей и «+N» (EC-T15). Таблица, а не
//             сетка из div: у таблицы есть заголовочные ячейки дней, и без них
//             «календарь» читается как список дат без привязки к дню.
//   Неделя — семь дней подряд, записи списком: их мало, резать нечего.
//   Список — по дням, для телефона и для длинных месяцев.
//
// «+N» ведёт на список дня: ссылка вместо выпадающего слоя, потому что список
// дня нужен и без скриптов, а скрипт не должен быть условием работы страницы
// (R-09).
//
// Содержимое целиком в начальном HTML (R-SEO-07): календарь индексируется, а
// пустая страница, дорисованная скриптом, в индекс не попадает.

import { html, when, raw } from './render.js';
import { t } from '../i18n/strings.js';
import { tPlural } from '../i18n/plural.js';
import { fullDate, monthTitle, weekdayShort } from './dates.js';

/** Записей в ячейке месяца до «+N» (EC-T15). */
const CELL_LIMIT = 3;

/** Виды календаря и фильтры — белый список (F-03-05 §9). */
export const VIEWS = ['month', 'week', 'list'];
export const FILTERS = ['all', 'mine'];

/**
 * @param {object} page
 * @param {string} page.locale
 * @param {any} page.calendar данные источника
 * @param {object} page.state
 * @param {string} page.state.view `month` | `week` | `list`
 * @param {string} page.state.filter `all` | `mine`
 * @param {number} page.state.year
 * @param {number} page.state.month 1–12
 * @param {number} page.state.weekStart `YYYY-MM-DD` понедельника недели
 * @param {string|null} page.state.day один день для списка дня или `null`
 * @param {string} page.state.today сегодня по поясу посетителя
 * @param {string} page.state.timezone
 * @param {boolean} page.state.guestInvite гость нажал «Мои»
 * @param {boolean} page.state.chosen вид выбрал человек, а не он пришёл по умолчанию
 */
export function calendarView({ locale, calendar, state }) {
  return html`
<h1 class="calendar__title">${t(locale, 'calendar.title')}</h1>

${toolbar({ locale, state })}

${when(state.guestInvite, () => html`
<section class="calendar__invite" aria-labelledby="h-calendar-invite">
  <h2 class="calendar__section-title" id="h-calendar-invite">${t(locale, 'calendar.mine.title')}</h2>
  <p class="calendar__invite-text">${t(locale, 'calendar.mine.guest')}</p>
  <p><a class="button" href="/${locale}/login">${t(locale, 'nav.signIn')}</a></p>
</section>`)}

${when(!state.guestInvite, () => html`
${state.view === 'month' ? monthView({ locale, calendar, state })
  : (state.view === 'week' ? weekView({ locale, calendar, state }) : listView({ locale, calendar, state }))}`)}

<p class="calendar__timezone">${t(locale, 'calendar.timezone', { timezone: state.timezone })}</p>`;
}

/** Заголовок периода, переходы по месяцам, переключатель вида и фильтр. */
function toolbar({ locale, state }) {
  const title = state.view === 'week'
    ? t(locale, 'calendar.week', { date: fullDate(locale, state.weekStart) })
    : monthTitle(locale, state.year, state.month);

  return html`
<div class="calendar__bar">
  <h2 class="calendar__bar-title">${title}</h2>

  <nav class="calendar__nav" aria-label="${t(locale, 'calendar.nav')}">
    <a class="calendar__nav-link" rel="prev" href="${shiftedMonthHref(locale, state, -1)}"
       >${t(locale, 'calendar.prev')}</a>
    <a class="calendar__nav-link" href="${href(locale, { ...state, year: null, month: null })}"
       >${t(locale, 'calendar.today')}</a>
    <a class="calendar__nav-link" rel="next" href="${shiftedMonthHref(locale, state, 1)}"
       >${t(locale, 'calendar.next')}</a>
  </nav>

  ${viewSwitch({ locale, state })}

  <div class="calendar__filter" role="group" aria-label="${t(locale, 'calendar.filter.label')}">
    ${FILTERS.map((name) => html`
    <a class="calendar__filter-item${state.filter === name ? ' calendar__filter-item--on' : ''}"
       href="${href(locale, { ...state, filter: name })}"
       ${state.filter === name ? raw('aria-current="true"') : ''}>${t(locale, `calendar.filter.${name}`)}</a>`)}
  </div>
</div>`;
}

/**
 * Переключатель вида — форма GET с тремя кнопками, а не три ссылки.
 *
 * Форма нужна по одной причине: на телефоне вид по умолчанию — список, а
 * сервер не знает ширину экрана. Скрипт меняет скрытое поле `view` и
 * отправляет форму один раз. Без скрипта всё работает как раньше: кнопка с
 * `name="view"` уходит в адрес сама, поэтому и список, и неделя открываются
 * ссылкой, которую можно переслать (R-09).
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {any} args.state
 */
function viewSwitch({ locale, state }) {
  return html`
<form class="calendar__views" method="get" action="/${locale}/calendar"
      data-calendar-default-view data-view-chosen="${state.chosen ? 'true' : 'false'}"
      role="group" aria-label="${t(locale, 'calendar.view.label')}">
  <input type="hidden" name="month" value="${`${state.year}-${String(state.month).padStart(2, '0')}`}">
  ${state.filter === 'mine' ? html`<input type="hidden" name="filter" value="mine">` : ''}
  ${VIEWS.map((name) => html`
  <button class="calendar__view${state.view === name ? ' calendar__view--on' : ''}" type="submit"
          name="view" value="${name}"
          ${state.view === name ? raw('aria-current="true"') : ''}>${t(locale, `calendar.view.${name}`)}</button>`)}
</form>`;
}

/** Месяц: таблица с понедельника по воскресенье. */
function monthView({ locale, calendar, state }) {
  const weeks = [];
  const cells = monthCells(state.year, state.month, state.today);
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));

  return html`
<table class="calendar__grid">
  <caption class="visually-hidden">${monthTitle(locale, state.year, state.month)}</caption>
  <thead>
    <tr>
      ${[0, 1, 2, 3, 4, 5, 6].map((day) => html`
      <th scope="col"><span aria-hidden="true">${weekdayShort(locale, day)}</span></th>`)}
    </tr>
  </thead>
  <tbody>
    ${weeks.map((week) => html`
    <tr>
      ${week.map((cell) => html`
      <td class="calendar__cell${cell.outside ? ' calendar__cell--outside' : ''}${cell.isToday ? ' calendar__cell--today' : ''}">
        <time class="calendar__date" datetime="${cell.iso}"
              ${cell.isToday ? raw('aria-current="date"') : ''}>${cell.day}</time>
        ${when(cell.isToday, () => html`<span class="calendar__today">${t(locale, 'calendar.todayShort')}</span>`)}
        ${cellEntries({ locale, date: cell.iso, entries: calendar.days.get(cell.iso) ?? [], state })}
      </td>`)}
    </tr>`)}
  </tbody>
</table>`;
}

/** Неделя: семь дней подряд. */
function weekView({ locale, calendar, state }) {
  return html`
<div class="calendar__week">
  ${[0, 1, 2, 3, 4, 5, 6].map((offset) => {
    const iso = addDays(state.weekStart, offset);
    return html`
  <section class="calendar__weekday" aria-labelledby="h-week-${iso}">
    <h3 class="calendar__weekday-title" id="h-week-${iso}">
      <time datetime="${iso}">${fullDate(locale, iso)}</time>${iso === state.today ? ` · ${t(locale, 'calendar.todayShort')}` : ''}
    </h3>
    ${entries({ locale, list: calendar.days.get(iso) ?? [], compact: true })}
  </section>`;
  })}
</div>`;
}

/** Список: дни с выходами подряд, без пустых промежутков. */
function listView({ locale, calendar, state }) {
  const days = [...calendar.days.keys()].sort();
  if (!days.length) return html`<p class="empty">${t(locale, 'calendar.empty')}</p>`;

  return html`
<div class="calendar__list">
  ${days.map((iso) => html`
  <section class="calendar__list-day" aria-labelledby="h-list-${iso}">
    <h3 class="calendar__list-date" id="h-list-${iso}">
      <time datetime="${iso}">${fullDate(locale, iso)}</time>${iso === state.today ? ` · ${t(locale, 'calendar.todayShort')}` : ''}
    </h3>
    ${entries({ locale, list: calendar.days.get(iso), compact: false })}
  </section>`)}
</div>`;
}

/** Записи ячейки месяца: не больше трёх, дальше ссылка на день (EC-T15). */
function cellEntries({ locale, date, entries: list, state }) {
  if (!list.length) return '';

  const shown = list.slice(0, CELL_LIMIT);
  const hidden = list.length - shown.length;

  return html`
${entries({ locale, list: shown, compact: true })}
${when(hidden > 0, () => html`
<a class="calendar__more" href="${href(locale, { ...state, view: 'list', day: date })}"
   >+${hidden}</a>`)}`;
}

/**
 * Записи дня.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {any[]} args.list
 * @param {boolean} args.compact короткая подпись для ячейки и недели
 */
function entries({ locale, list, compact }) {
  if (!list.length) return html`<p class="calendar__empty-day">${t(locale, 'calendar.day.empty')}</p>`;

  return html`
<ol class="calendar__entries${compact ? ' calendar__entries--compact' : ''}" role="list">
  ${list.map((entry) => html`
  <li class="calendar__entry">
    <a class="calendar__entry-link" href="/${locale}/series/${entry.seriesSlug}">
      <span class="calendar__entry-title">${entry.seriesTitle}</span>
      <span class="calendar__entry-meta">${entryLabel(locale, entry)}</span>
      ${when(entry.time, () => html`<span class="calendar__entry-time">${entry.time}</span>`)}
      ${when(STATE_KEY[entry.state], () => html`
      <span class="calendar__entry-state">${t(locale, STATE_KEY[entry.state])}</span>`)}
    </a>
  </li>`)}
</ol>`;
}

/** Состояние выхода → подпись; состояний без подписи в календаре нет. */
const STATE_KEY = {
  delayed: 'calendar.state.delayed',
  cancelled: 'calendar.state.cancelled',
};

/**
 * Подпись записи: «S2E5», «3 серии», «весь сезон».
 *
 * @param {string} locale
 * @param {any} entry
 * @returns {string}
 */
function entryLabel(locale, entry) {
  if (entry.kind === 'episode') {
    return t(locale, 'calendar.entry.episode', {
      season: entry.seasonNumber,
      episode: entry.episodeNumbers.join(', '),
    });
  }
  if (entry.kind === 'season') return t(locale, 'calendar.entry.season');
  return tPlural(locale, 'calendar.entry.group', entry.episodeCount);
}

/**
 * Ячейки месяца: полные недели с понедельника, с днями-соседями по краям.
 *
 * Соседние дни показываются тусклыми: месяц начинается не в понедельник, и без
 * них первая строка выглядит обрезанной. Разница в шесть недель (28 дней и
 * 31) не выравнивается по высоте — месяцы в сетке всегда одной высоты, иначе
 * страница прыгает при переключении месяцев.
 *
 * @param {number} year
 * @param {number} month 1–12
 * @param {string|null} today `YYYY-MM-DD`
 * @returns {{iso: string, day: number, outside: boolean, isToday: boolean}[]}
 */
function monthCells(year, month, today = null) {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // `getUTCDay` отсчитывает с воскресенья, неделя начинается с понедельника.
  const leading = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const rows = Math.ceil((leading + daysInMonth) / 7);

  return Array.from({ length: rows * 7 }, (_, index) => {
    const offset = index - leading;
    const iso = addDays(first, offset);
    const day = offset + 1;
    return {
      iso,
      day: Number(iso.slice(8, 10)),
      outside: day < 1 || day > daysInMonth,
      isToday: today !== null && iso === today,
    };
  });
}

/**
 * Адрес календаря: вид, фильтр, месяц и день собираются в одном месте.
 *
 * Месяц в адресе — `YYYY-MM`, а не номер: иначе ноябрь и ноябрь следующего
 * года неразличимы, и ссылкой на календарь нельзя поделиться.
 *
 * @param {string} locale
 * @param {any} state
 * @returns {string}
 */
export function href(locale, state) {
  const params = new URLSearchParams();
  if (state.view && state.view !== 'month') params.set('view', state.view);
  if (state.filter === 'mine') params.set('filter', 'mine');
  if (state.year && state.month) params.set('month', `${state.year}-${String(state.month).padStart(2, '0')}`);
  if (state.day) params.set('day', state.day);
  const query = params.toString();
  return `/${locale}/calendar${query ? `?${query}` : ''}`;
}

/** Соседний месяц: декабрь и январь — разные годы, а не «месяц 12». */
function shiftedMonthHref(locale, state, delta) {
  const zeroBased = state.year * 12 + (state.month - 1) + delta;
  return href(locale, {
    ...state,
    year: Math.floor(zeroBased / 12),
    month: (zeroBased % 12) + 1,
    day: null,
  });
}

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}