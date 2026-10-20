// Правила действий под отзывом: голос «Полезно» (F-04-06) и жалоба (F-04-07).
//
// Правила живут здесь, потому что их читают две страницы: список отзывов
// (S-09) и страница отзыва (S-10). Разъехавшиеся копии разошлись бы
// быстрее, чем их заметят: гость на одной странице получил бы форму, а на
// другой — предложение войти.
//
// Здесь нет ничего, что принадлежит только одной странице: адрес возврата
// и адрес сериала приходят параметрами.

import { csrfToken } from '../services/auth/session.js';
import { REPORT_CODES } from '../services/reviews/reports.js';

/**
 * Идентификатор отзыва из адреса: целое ≥ 1, иначе `null` — адресу с мусором
 * отвечает 404, а не сбой парсинга.
 *
 * @param {string} value
 * @returns {number|null}
 */
export function voteNumber(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

/**
 * Данные кнопки «Полезно» для страниц с отзывами (F-04-06).
 *
 * Карта `id отзыва → { signedIn, own, voted, count, action, back, csrf }`.
 * Гость получает счётчик и «Войдите»; подтверждённый читатель — форму;
 * автор — неактивную кнопку с пояснением (EC-V15); неподтверждённому
 * (`confirmed === false`) кнопка не рисуется вовсе — он не зритель, право
 * всё равно проверит сервис. Голоса страницы читаются одним запросом, а не по
 * каждой карточке — бюджет страницы (M4 §14) важнее простоты.
 *
 * @param {object} deps
 * @param {object|null} deps.votes сервис голосов; без него футера нет
 * @param {object|null} deps.user сессия
 * @param {object|null} deps.session
 * @param {object[]} deps.items строки отзывов (`id`, `helpfulCount`, `authorId`)
 * @param {string} deps.locale
 * @param {string} deps.slug сериал: адрес действия публикации
 * @param {string} deps.back адрес страницы для возврата и «Войдите»
 * @returns {Promise<Map|null>}
 */
export async function voteStateFor({ votes, user, session, items, locale, slug, back }) {
  if (!votes || items.length === 0) return null;
  const csrf = session ? csrfToken(session) : '';
  const state = new Map();

  // Гостю — счётчик и приглашение; неподтверждённому — ничего.
  if (!user || user.confirmed === false) {
    for (const item of items) {
      if (!user) {
        state.set(Number(item.id), {
          signedIn: false, own: false, voted: false,
          count: item.helpfulCount, action: null, back, csrf: '',
        });
      }
    }
    return state;
  }

  const voters = new Set(await votes.mine({ userId: user.id, materialIds: items.map((item) => item.id) }));
  for (const item of items) {
    const own = Number(item.authorId) === Number(user.id);
    state.set(Number(item.id), {
      signedIn: true,
      own,
      voted: voters.has(Number(item.id)),
      count: item.helpfulCount,
      action: own ? null : `/${locale}/series/${slug}/reviews/${item.id}/helpful`,
      back,
      csrf,
    });
  }
  return state;
}

/**
 * Состояние жалобы для страниц S-06, S-09 и S-10 (F-04-07 §6).
 *
 * Диалог открывается состоянием адреса (`?report=`, `?reported=`): форма
 * работает без скрипта, а скрипту адрес не нужен — он открывает нативный
 * диалог по пункту меню. Мусор в состоянии (не число, неизвестная ошибка)
 * молча игнорируется тем же правилом, что фильтры F-04-05 §8: адрес
 * собирают руками, и «`?report=zzz`» — закрытый диалог, а не 400.
 *
 * Право показывается, но не проверяется здесь: сервис пересчитает всё
 * сам на отправке (M4 §15-11), а меню — удобство, не защита.
 *
 * @param {object} args
 * @param {object} args.req
 * @param {string} args.locale
 * @param {string} args.slug сериал: адрес публикации жалобы
 * @param {string} args.back полный адрес страницы, с фильтрами
 * @param {object|null} args.user сессия пользователя
 * @param {object|null} args.session
 * @returns {object|null} null — жалобы на странице быть не должно
 */
export function reportStateFor({ req, locale, slug, back, user, session }) {
  const refNumber = voteNumber;
  let dialog = null;
  const reportRef = refNumber(req.query.report);
  const sentRef = refNumber(req.query.reported);
  if (reportRef !== null) {
    const err = req.query.err === 'reason' || req.query.err === 'comment' ? req.query.err : null;
    dialog = { mode: 'form', ref: reportRef, err, comment: String(req.query.c ?? '').slice(0, 400) };
  } else if (sentRef !== null) {
    // Повтор подачи приходит с тем же маркером «отправлено» и пометкой
    // again: одна точка возврата, два состояния диалога (EC-V16).
    dialog = { mode: req.query.again ? 'already' : 'sent', ref: sentRef, err: null, comment: '' };
  }

  if (!user) {
    return {
      userId: null,
      confirmed: false,
      slug,
      back,
      signInHref: `/${locale}/login?next=${encodeURIComponent(back)}`,
      csrf: '',
      reasons: [...REPORT_CODES],
      // Состояние гостю не рисуется: его путь — вход, форма придёт после
      // входа; POST и так уводит на вход (стадия C).
      dialog: null,
    };
  }
  return {
    userId: Number(user.id),
    confirmed: Boolean(user.confirmed),
    slug,
    back,
    signInHref: null,
    csrf: csrfToken(session ?? req.session),
    reasons: [...REPORT_CODES],
    dialog,
  };
}
