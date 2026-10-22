// Разметка правой панели для списковых страниц (F-03-06).
//
// Один помощник на пять маршрутов вместо пяти одинаковых мест: панель должна
// вести себя одинаково на главной, в каталоге, в жанре, в подборке и в поиске,
// а разъезжаться она может, только если её собирают в пяти местах.
//
// Панель не падает вместе со страницей: источник данных сам возвращает пустой
// список при ошибке, а здесь он превращается либо в пустое состояние, либо —
// если источника вовсе нет — в ничего.

import { upcomingPanel } from '../view/panel.js';
import { timezoneOf, todayIn } from '../services/timezone.js';

/**
 * Панель для страницы или пустая строка.
 *
 * @param {object} args
 * @param {any} args.panel источник данных панели; `null` — панели нет
 * @param {string} args.locale
 * @param {import('express').Request} args.req
 * @param {boolean} [args.showEmpty] показывать пустое состояние, когда выходов нет
 * @param {(error: Error) => void} [args.onError] куда уходит причина поломки
 * @returns {Promise<string>} готовая разметка или пустая строка
 */
export async function panelFor({ panel, locale, req, showEmpty = true, onError = null }) {
  if (!panel) return '';

  const user = req.session?.user ?? null;
  const today = todayIn(timezoneOf(req));

  try {
    const rows = await panel.upcoming({ today, userId: user?.id ?? null });
    if (!rows.length && !showEmpty) return '';
    return upcomingPanel({ locale, rows, today }).__raw;
  } catch (error) {
    // Источник сам возвращает пустой список при ошибке данных, но поломка
    // источника — уже исключение. Панель — дополнение: страница, ради которой
    // человек пришёл, не должна падать из-за уголка (F-03-06 §5).
    onError?.(error);
    return '';
  }
}