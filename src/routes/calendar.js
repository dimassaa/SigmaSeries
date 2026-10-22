// Календарь (F-03-05, S-16).
//
// Маршрут тонкий: разбор адреса, пояс посетителя, диапазон периода, отдача
// вида. Данные — в `services/catalogue/calendar.js`, разметка — в
// `view/calendar.js`.
//
// Три решения принимаются здесь, потому что они про человека перед
// страницей, а не про данные:
//
//  1. Гость на «Мои» получает приглашение войти, а не пустую сетку (EC-T21):
//     пустой календарь читается как «выходов нет», а это неправда.
//  2. Месяц по умолчанию — тот, в котором посетитель находится по своему
//     поясу, а не по серверному времени.
//  3. В индекс попадает месяц текущий ± 1 (R-SEO-02): остальные месяцы — это
//     десятки тысяч почти одинаковых адресов, а пользы от их индексации нет.

import express from 'express';

import { layout, pageTitle } from '../view/layout.js';
import { calendarView, VIEWS, FILTERS } from '../view/calendar.js';
import { t, isLocale } from '../i18n/strings.js';
import { timezoneOf, todayIn } from '../services/timezone.js';
// Таблицы стилей этой страницы: общая плюс нужные группам. Список
// берётся из `src/config/styles.js`, порядок подключения — оттуда же.
const STYLES = ['calendar'];


const rawHtml = (page) => page.__raw;

/** На сколько месяцев от текущего календарь остаётся индексируемым (§8). */
const INDEXABLE_MONTHS = 1;

/** Запасной источник, когда сессий в приложении нет (тесты, утилиты). */
const EMPTY = { days: new Map(), total: 0, truncated: false };

/**
 * @param {object} deps
 * @param {any} deps.calendar источник данных
 * @param {import('express').RequestHandler[]} [deps.sessionMw] middleware сессий: без него все посетители гости
 * @returns {import('express').Router}
 */
export function createCalendarRoutes({ calendar, sessionMw = null }) {
  const router = express.Router({ strict: true });
  if (sessionMw) router.use('/:locale{/:rest}', sessionMw);

  router.get('/:locale/calendar', async (req, res, next) => {
    const { locale } = req.params;
    if (!isLocale(locale)) return next('route');

    try {
      const timezone = timezoneOf(req);
      const today = todayIn(timezone);
      const state = readState({ query: req.query, today, timezone });

      const user = req.session?.user ?? null;
      // Гость на «Мои» — приглашение, а не запрос к базе: подписок у него нет
      // по определению, и пустой ответ читался бы как «выходов нет».
      const guestInvite = state.filter === 'mine' && !user;
      const range = periodOf(state);

      const data = guestInvite
        ? { ...EMPTY, ...range }
        : await calendar.days({ ...range, userId: user?.id ?? null, timezone });

      return res.status(200).type('html').send(rawHtml(layout({
        styles: STYLES,
        account: req.account,
        locale,
        // Путь без параметров: `canonical` в оболочке собирается из пути, а
        // фильтры и месяц канонизируются на базовый адрес (R-SEO-02).
        path: '/calendar',
        title: pageTitle(locale, t(locale, 'calendar.title')),
        description: t(locale, 'calendar.description'),
        noindex: guestInvite || !indexable(state, today),
        body: calendarView({ locale, calendar: data, state: { ...state, guestInvite } }),
      })));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

/**
 * Состояние страницы из адреса.
 *
 * Негодное значение отбрасывается, а не считается ошибкой: адрес собирают
 * руками, и `?view=какая-то-ерунда` должен показать календарь, а не 400
 * (F-03-05 §9, «фильтр — белый список»).
 *
 * @param {object} args
 * @param {Record<string, unknown>} args.query
 * @param {string} args.today `YYYY-MM-DD` в поясе посетителя
 * @param {string} args.timezone
 * @returns {any}
 */
function readState({ query, today, timezone }) {
  const view = VIEWS.includes(String(query.view)) ? String(query.view) : 'month';
  const filter = FILTERS.includes(String(query.filter)) ? String(query.filter) : 'all';

  const month = /^(\d{4})-(\d{2})$/.exec(String(query.month ?? ''));
  const now = today.slice(0, 7).split('-').map(Number);
  const year = month ? Number(month[1]) : now[0];
  const number = month ? Number(month[2]) : now[1];

  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(query.day ?? '')) ? String(query.day) : null;
  // Неделя — та, в которую попал запрошенный месяц: переход «месяц → неделя»
  // должен показать неделю начала месяца, а не текущую.
  const weekStart = mondayOf(view === 'week' ? firstOf(year, number) : today);

  return {
    view,
    filter,
    year,
    month: number,
    weekStart,
    day,
    today,
    timezone,
    guestInvite: false,
    // Вид по умолчанию скрипт уточняет один раз: если человек уже выбрал
    // вид сам, переключать его под ним нельзя.
    chosen: Object.hasOwn(query, 'view'),
  };
}

/**
 * Период, за который спрашиваются выходы: один день, неделя или месяц.
 *
 * Неделя и месяц берутся целиком, а не «до 62 дней»: предел из настроек —
 * страховка от рукописного диапазона, а не повод обрезать календарь.
 *
 * @param {any} state
 * @returns {{from: string, to: string}}
 */
function periodOf(state) {
  if (state.day) return { from: state.day, to: state.day };
  if (state.view === 'week') return { from: state.weekStart, to: addDays(state.weekStart, 6) };

  const first = firstOf(state.year, state.month);
  const next = state.month === 12 ? `${state.year + 1}-01-01` : `${state.year}-${String(state.month + 1).padStart(2, '0')}-01`;
  return { from: first, to: addDays(next, -1) };
}

function firstOf(year, month) {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Понедельник недели, в которую попал день. */
function mondayOf(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  return addDays(iso, -((date.getUTCDay() + 6) % 7));
}

/**
 * Индексируется ли месяц (F-03-05 §8, R-SEO-02).
 *
 * @param {any} state
 * @param {string} today `YYYY-MM-DD`
 * @returns {boolean}
 */
function indexable(state, today) {
  if (state.day) return false;
  const current = Number(today.slice(0, 7).replace('-', ''));
  return Math.abs(state.year * 100 + state.month - current) <= INDEXABLE_MONTHS;
}