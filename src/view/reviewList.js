// S-09 — список отзывов сериала (F-04-05).
//
// Состояние фильтров живёт в адресе: каждая вкладка и каждая метка — настоящая
// ссылка, страницу можно переслать, а человек с отключёнными скриптами
// получает ту же выдачу. Скрипт лишь сворачивает панель фильтров на телефоне
// (см. `public/app.js`), но не является условием работы.
//
// Карточка общая у ленты и блока «Лучшие» на S-06: разойтись правилам показа
// спойлера и «Читать далее» неоткуда, пока карточка собрана одним кодом.

import { html, when, raw } from './render.js';
import { t } from '../i18n/strings.js';
import { tPlural } from '../i18n/plural.js';
import { dayLabel } from './dates.js';
import { paragraphs } from './reviews.js';
import { averageLine, histogram, ownLine } from './rating.js';
import { REVIEW } from '../config/settings.js';

/** Сортировка по умолчанию — в адрес не попадает (F-04-05 §4). */
const DEFAULT_SORT = 'helpful';

/**
 * Адрес списка с заданным состоянием фильтров.
 *
 * Единая точка сборки: вкладки, метки, постраничность и возврат со страницы
 * за концом обязаны давать одинаковый вид ссылки — иначе по ссылке нельзя
 * поделиться, а канонический адрес и постраничность разъезжаются (R-SEO-02).
 * Умолчания в адрес не попадают: `?sort=helpful&page=1` — мусор.
 *
 * @param {string} locale
 * @param {string} slug
 * @param {{group?: string|null, length?: string|null, lang?: string|null,
 *   sort?: string|null, page?: number}} state
 * @returns {string}
 */
export function reviewsHref(locale, slug, state = {}) {
  const params = new URLSearchParams();
  if (state.group) params.set('group', state.group);
  if (state.length) params.set('length', state.length);
  if (state.lang) params.set('lang', state.lang);
  if (state.sort && state.sort !== DEFAULT_SORT) params.set('sort', state.sort);
  if (Number(state.page) > 1) params.set('page', String(state.page));
  const query = params.toString();
  return `/${locale}/series/${slug}/reviews${query ? `?${query}` : ''}`;
}

/**
 * Разрез текста на видимую часть и хвост под раскрытием.
 *
 * Режется по границе слова: обрывок слова на месте многоточия выглядит
 * ошибкой набора, а не сокращением. Точный предел `review.read_more_chars` —
 * это порог, после которого появляется «Читать далее», поэтому видимая часть
 * может оказаться чуть короче: слово показывается целиком.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {{lead: string, tail: string}} `tail` пуст, если текст короткий
 */
function splitText(text, limit) {
  if (text.length <= limit) return { lead: text, tail: '' };
  const space = text.lastIndexOf(' ', limit);
  const cut = space > 0 ? space : limit;
  return { lead: `${text.slice(0, cut).trimEnd()}…`, tail: text.slice(cut).trimStart() };
}

/** Дата в машинном виде для `<time>`: часовой пояс человека на неё не влияет. */
const machineDate = (date) => new Date(date).toISOString().slice(0, 10);

/**
 * Карточка отзыва: ник, оценка автора, дата, язык, текст.
 *
 * Спойлер свёрнут нативным `<details>`: раскрытое состояние знает браузер, и
 * скрипт для показа не нужен. `data-nosnippet` не даёт поисковику вытащить
 * спойлер в сниппет, хотя текст остаётся в разметке (M4 §8д, R-SEO-14).
 *
 * Ник — текст, а не ссылка: страницы пользователя (S-18) ещё нет, а ссылка в
 * никуда читается как сломанная. Адрес S-18 появится — вернёмся (см. план
 * F-04-05).
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.item строка из `pgReviewList`
 * @param {string|null} [args.timezone] пояс посетителя для подписи даты
 */
/**
 * Футер карточки: голос «Полезно» (F-04-06).
 *
 * Состояния (F-04-06 §6): без голоса — обычная кнопка; с голосом —
 * `aria-pressed` и число; «сохраняется» даёт скрипт, отключая кнопку на
 * время запроса (без скрипта отправка мгновенна); ошибка — обычный POST,
 * который отвечает текстом. Автору кнопка неактивна с пояснением (EC-V15),
 * гостю — счётчик и «Войдите», неподтверждённому футер не рисуется:
 * кнопка зрителя, а он ещё не зритель.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object|null} args.vote данные кнопки; `null` — футера нет
 */
/** Футер карточки: строка голоса (F-04-06) с гнездом меню жалобы (F-04-07)
 * в той же раскладке, справа. Одна строка футера проще двух блоков. */
function voteRow({ locale, vote, menu = '' }) {
  if (!vote) return '';
  const label = t(locale, 'review.vote.label');

  if (!vote.signedIn) {
    return html`
  <div class="reviews__foot">
    <span class="reviews__vote-count">${label} · ${vote.count}</span>
    <a class="reviews__vote-link" href="/${locale}/login?next=${encodeURIComponent(vote.back)}"
      >${t(locale, 'review.vote.signIn')}</a>
    ${menu}
  </div>`;
  }

  if (vote.own) {
    return html`
  <div class="reviews__foot">
    <button class="reviews__vote-button" type="button" disabled
      aria-disabled="true">${label} <span class="reviews__vote-num">· ${vote.count}</span></button>
    <span class="reviews__vote-hint">${t(locale, 'review.vote.own')}</span>
    ${menu}
  </div>`;
  }

  return html`
  <div class="reviews__foot">
    <form class="reviews__vote" method="post" action="${vote.action}" data-review-vote>
      <input type="hidden" name="csrf" value="${vote.csrf}">
      <input type="hidden" name="back" value="${vote.back}">
      <button class="reviews__vote-button${vote.voted ? ' reviews__vote-button--on' : ''}" type="submit"
        name="to" value="${vote.voted ? 'unset' : 'set'}"
        aria-pressed="${vote.voted ? 'true' : 'false'}"
        >${label} <span class="reviews__vote-num">· ${vote.count}</span></button>
    </form>${menu}
  </div>`;
}

/**
 * Меню «⋯» одной карточки отзыва (F-04-07 §3).
 *
 * Своему отзыву пункта нет («не на свой отзыв», §2), неподтверждённому тоже:
 * право всё равно проверит сервис, а меню — удобство, не защита (M4 §15-11).
 * Гостю пункт ведёт на вход (§5), зрячим — на открытие диалога состоянием
 * адреса (`?report=<id>`): работает и без скрипта, скрипт лишь открывает
 * нативный диалог без перезагрузки. `data-review-id` здесь не нужен: его
 * в карточке несёт сам `<li>`, а дубль сломал бы счётчик списка.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.item строка отзыва (`id`, `authorId`)
 * @param {object|null} args.report состояние жалобы страницы
 * @returns {string} пустая строка, если пункта быть не должно
 */
function reportMenuFor({ locale, item, report }) {
  if (!report) return '';
  if (report.userId === null) {
    return html`
  <details class="reviews__menu">
    <summary class="reviews__menu-toggle" aria-label="${t(locale, 'review.report.menuLabel')}"
      >${t(locale, 'review.report.trigger')}</summary>
    <div class="reviews__menu-pop">
      <a class="reviews__menu-item" href="${report.signInHref}"
        >${t(locale, 'review.report.open')}</a>
    </div>
  </details>`;
  }
  if (!report.confirmed) return '';
  if (Number(item.authorId) === Number(report.userId)) return '';
  const sep = report.back.includes('?') ? '&' : '?';
  return html`
  <details class="reviews__menu">
    <summary class="reviews__menu-toggle" aria-label="${t(locale, 'review.report.menuLabel')}"
      >${t(locale, 'review.report.trigger')}</summary>
    <div class="reviews__menu-pop">
      <a class="reviews__menu-item" href="${report.back}${sep}report=${item.id}#review-report"
        data-report-open data-report-action="/${locale}/series/${report.slug}/reviews/${item.id}/report"
        >${t(locale, 'review.report.open')}</a>
    </div>
  </details>`;
}

/**
 * Диалог жалобы (F-04-07 §4, §6). Един на страницу.
 *
 * Без состояния адреса (`?report=` / `?reported=`) диалог закрыт, но разметка
 * формы стоит: скрипт открывает его по пункту меню и подставляет адрес
 * действия, а без скрипта диалог открывается только состоянием — пустой
 * закрытый диалог недостижим. Состояния «отправлено» и «уже подано»
 * рисуются вместо формы: после отправки человек читает ответ, а не пустую
 * форму. Адреса ответов приходят редиректом со строки запроса (стадия C).
 *
 * Метки для скрипта (тексты результата и ошибок) лежат в data-атрибутах:
 * строки для клиента собирает сервер, клиент ничего не переводит сам.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.series строка шапки сериала (`slug`)
 * @param {object|null} args.report состояние жалобы страницы
 * @returns {string} пустая строка, если жалобы на странице не бывает
 */
export function reportDialog({ locale, series, report }) {
  if (!report || report.userId === null && !report.dialog) return raw('');
  const dialog = report.dialog ?? { mode: null, ref: null, err: null, comment: '' };
  const open = dialog.mode ? raw('open') : raw('');
  const describedby = dialog.err ? raw(' aria-describedby="review-report-err"') : raw('');

  const errorLine = dialog.err
    ? html`
      <p class="reviews__report-err" role="alert" id="review-report-err"
        >${t(locale, `review.report.error.${dialog.err}`)}</p>`
    : raw('');

  const form = html`
      ${errorLine}
      <form class="reviews__report-form" method="post" data-review-report${describedby}
          data-error-reason="${t(locale, 'review.report.error.reason')}"
          data-error-comment="${t(locale, 'review.report.error.comment')}"
          ${dialog.ref ? raw(`action="/${locale}/series/${series.slug}/reviews/${dialog.ref}/report"`) : raw('')}>
        <input type="hidden" name="csrf" value="${report.csrf}">
        <input type="hidden" name="back" value="${report.back}">
        <fieldset class="reviews__report-reasons">
          <legend class="reviews__report-legend">${t(locale, 'review.report.reasons')}</legend>
          ${report.reasons.map((code) => html`
          <label class="reviews__report-reason">
            <input type="radio" name="reason" value="${code}" required>
            <span>${t(locale, `review.report.reason.${code}`)}</span>
          </label>`)}
        </fieldset>
        <label class="reviews__report-comment-label" for="report-comment"
          >${t(locale, 'review.report.comment')}</label>
        <textarea class="reviews__report-text" id="report-comment" name="comment" rows="3"
          maxlength="300">${dialog.comment ?? ''}</textarea>
        <p class="reviews__report-hint">${t(locale, 'review.report.commentHint')}</p>
        <p class="reviews__report-actions">
          <button class="button button--primary" type="submit"
            >${t(locale, 'review.report.submit')}</button>
          <a class="button button--quiet" href="${report.back}"
            >${t(locale, 'review.report.cancel')}</a>
        </p>
      </form>`;

  const done = (text) => html`
      <p class="reviews__report-done">${text}</p>
      <p class="reviews__report-actions">
        <button class="button button--quiet" type="button" data-review-close
          >${t(locale, 'review.report.close')}</button>
      </p>`;

  return html`
  <dialog class="reviews__report" id="review-report" aria-labelledby="review-report-title"${open}
      data-sent-text="${t(locale, 'review.report.sent')}"
      data-already-text="${t(locale, 'review.report.already')}"
      data-close-label="${t(locale, 'review.report.close')}">
    <div class="reviews__report-body">
      <h3 class="reviews__report-title" id="review-report-title"
        >${t(locale, 'review.report.title')}</h3>
      ${dialog.mode === 'sent' ? done(t(locale, 'review.report.sent')) : raw('')}${dialog.mode === 'already' ? done(t(locale, 'review.report.already')) : raw('')}${dialog.mode === 'form' || !dialog.mode ? form : raw('')}
    </div>
  </dialog>`;
}

/**
 * Карточка отзыва в ленте S-09 и в блоке «Лучшие» S-06 (F-04-05, F-04-06).
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.item строка отзыва
 * @param {string|null} [args.timezone] часовой пояс читателя
 * @param {object|null} [args.vote] состояние голоса карточки
 * @param {object|null} [args.report] состояние жалобы страницы (меню «⋯»)
 */
/**
 * Шапка отзыва: ник, оценка автора, дата, метка языка (F-04-05 §4, F-04-09 §4).
 *
 * Карточка в списке и страница отзыва показывают одно и то же, и по-разному
 * быть не может: оценка и дата в карточке — те же числа, что на странице,
 * а «Пользователь удалён» вместо ника — то же правило (EC-V6).
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.item строка отзыва
 * @param {string|null} [args.timezone] пояс посетителя для подписи даты
 * @returns {string}
 */
export function reviewMeta({ locale, item, timezone = null }) {
  const deleted = item.authorStatus === 'deleted';
  return html`
  <p class="reviews__head">
    <span class="reviews__nick${deleted ? ' reviews__nick--deleted' : ''}"
      >${deleted ? t(locale, 'review.deleted') : item.authorNickname}</span>
    <span class="reviews__card-rating" aria-hidden="true">${item.authorRating}</span>
    <span class="visually-hidden">${t(locale, 'review.card.rating', { value: item.authorRating })}</span>
    <time class="reviews__date" datetime="${machineDate(item.createdAt)}"
      >${dayLabel(locale, item.createdAt, timezone ?? undefined)}</time>
    <span class="reviews__lang">${t(locale, `review.code.${item.lang}`)}</span>
  </p>`;
}

/**
 * Футер отзыва: голос «Полезно» и меню жалобы (F-04-06, F-04-07).
 *
 * На карточке списка и на странице отзыва футер одинаковый: право голоса и
 * право жалобы не зависят от того, где стоит отзыв, иначе одна страница
 * предложила бы войти там, где другая показывает форму.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.item строка отзыва (`id`, `authorId`)
 * @param {object|null} args.vote данные кнопки «Полезно»; `null` — футера нет
 * @param {object|null} args.report состояние жалобы страницы
 * @returns {string} пустая строка, если футера быть не должно
 */
export function reviewActions({ locale, item, vote, report }) {
  if (!vote) return '';
  // Меню жалобы живёт в футере рядом с голосом (одна строка раскладки).
  // Голоса нет — футера нет и меню нет: без сервиса голосов ни одна
  // поверхность карточек не собирается, жаловаться стало бы негде.
  const menu = reportMenuFor({ locale, item, report });
  return voteRow({ locale, vote, menu });
}

export function reviewCard({ locale, item, timezone = null, vote = null, report = null }) {
  const { lead, tail } = splitText(item.body, REVIEW.readMoreChars);

  const body = html`${paragraphs(lead).map((part) => html`<p>${part}</p>`)}${when(tail, () => html`
    <details class="reviews__more">
      <summary class="reviews__more-link">${t(locale, 'review.readMore')}</summary>
      ${paragraphs(tail).map((part) => html`<p>${part}</p>`)}
    </details>`)}`;

  return html`
<li class="reviews__item" data-review-id="${item.id}">
  ${reviewMeta({ locale, item, timezone })}
  ${when(!item.spoiler, () => html`
  <div class="reviews__text">${body}</div>`)}
  ${when(item.spoiler, () => html`
  <details class="reviews__spoiler">
    <summary class="reviews__spoiler-toggle">
      <span class="reviews__spoiler-show">${t(locale, 'review.spoiler.show')}</span>
      <span class="reviews__spoiler-hide">${t(locale, 'review.spoiler.hide')}</span>
    </summary>
    <div class="reviews__text" data-nosnippet>${body}</div>
  </details>`)}
  ${reviewActions({ locale, item, vote, report })}
</li>`;
}

/**
 * Ряд меток одного фильтра: подпись и ссылки-значения.
 *
 * Метки — ссылки, а не радиокнопки: выбор виден из адреса, работает без
 * скрипта, а страницу с выбранным фильтром можно переслать. Активная метка
 * отмечена не только цветом: `aria-current` называют и слух, и цвет
 * (R-A11Y-19).
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {string} args.id якорь подписи для `aria-labelledby`
 * @param {string} args.param имя параметра адреса
 * @param {string} args.label ключ подписи
 * @param {Array<{key: string|null, label: string, count?: number}>} args.items
 * @param {string|null} args.active
 * @param {(changes: object) => string} args.hrefFor
 */
function chipRow({ locale, id, param, label, items, active, hrefFor }) {
  return html`
<div class="reviews__filter">
  <p class="reviews__filter-label" id="${id}">${t(locale, label)}</p>
  <ul class="reviews__chips" role="list" aria-labelledby="${id}">
    ${items.map((item) => html`
    <li>
      <a class="reviews__chip${active === item.key ? ' reviews__chip--on' : ''}"
         href="${hrefFor({ [param]: item.key, page: 1 })}"
         ${active === item.key ? raw('aria-current="true"') : raw('')}
        >${t(locale, item.label)}${when(item.count !== undefined, () => html` <span class="reviews__chip-count">${item.count}</span>`)}</a>
    </li>`)}
  </ul>
</div>`;
}

/**
 * Постраничность настоящими ссылками (R-SEO-09): без них страницу не видно
 * поисковику и нельзя переслать.
 *
 * Окно вокруг текущей страницы плюс первая и последняя: человек приходит за
 * второй страницей из выдачи, а не за «всеми двадцатью».
 */
function pagination({ locale, page, hrefFor }) {
  const last = page.pages;
  const current = page.page;
  const from = Math.max(1, Math.min(current - 2, last - 4));
  const to = Math.min(last, Math.max(current + 2, 5));
  const numbers = [];
  for (let number = from; number <= to; number += 1) numbers.push(number);

  return html`
<nav class="pagination" aria-label="${t(locale, 'review.pagination.label')}">
  ${when(current > 1, () => html`
  <a class="pagination__step" href="${hrefFor({ page: current - 1 })}"
     rel="prev">${t(locale, 'review.pagination.prev')}</a>`)}

  ${when(from > 1, () => html`<span class="pagination__gap" aria-hidden="true">…</span>`)}
  ${numbers.map((number) => html`
  <a class="pagination__item" href="${hrefFor({ page: number })}"
     ${number === current ? raw('aria-current="page"') : raw('')}>${number}</a>`)}
  ${when(to < last, () => html`<span class="pagination__gap" aria-hidden="true">…</span>`)}

  ${when(current < last, () => html`
  <a class="pagination__step" href="${hrefFor({ page: current + 1 })}"
     rel="next">${t(locale, 'review.pagination.next')}</a>`)}
</nav>`;
}

/**
 * Пустое состояние: «нет отзывов» отличается от «в этой группе ничего».
 *
 * Путь «Отметьте серию и оцените» — только тому, кто может писать: гостю он
 * предлагал бы действие, которого тот не может выполнить (F-04-05 §6).
 * Отсюда возврат к снятию фильтров: пустая группа сообщает, что список не
 * пуст, и предлагает вернуться к нему.
 */
function emptyView({ locale, slug, filtered, action }) {
  if (filtered) {
    return html`
<div class="reviews__empty">
  <p class="reviews__empty-title">${t(locale, 'review.empty.group')}</p>
  <p class="reviews__empty-reset">
    <a class="button button--quiet" href="/${locale}/series/${slug}/reviews"
      >${t(locale, 'review.filters.reset')}</a>
  </p>
</div>`;
  }

  return html`
<div class="reviews__empty">
  <p class="reviews__empty-title">${t(locale, 'review.empty.title')}</p>
  ${when(action?.kind === 'write', () => html`
  <p class="reviews__empty-path">
    <a href="/${locale}/series/${slug}">${t(locale, 'review.empty.path')}</a>
  </p>`)}
</div>`;
}

/** Кнопка действия у сводки: своей формы у списка нет (F-04-05 §4). */
function actionView({ locale, action }) {
  if (!action) return raw('');
  return html`
<p class="reviews__actions">
  <a class="button button--primary" href="${action.href}"
    >${t(locale, action.kind === 'edit' ? 'review.edit' : 'review.write')}</a>
</p>`;
}

/**
 * Страница списка отзывов (S-09).
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.series найденный сериал
 * @param {object} args.summary сводка оценок (F-04-03)
 * @param {object|null} [args.ownRating] своя оценка
 * @param {object|null} [args.action] кнопка у сводки: `{kind: 'write'|'edit', href}`
 * @param {string|null} [args.timezone] пояс посетителя
 * @param {object} args.page результат `pgReviewList.page`
 */
export function reviewListView({
  locale, series, summary, ownRating = null, action = null, timezone = null, page, votesById = null,
  report = null,
}) {
  const { applied, counts } = page;
  const state = { group: applied.group, length: applied.length, lang: applied.lang, sort: applied.sort };
  const hrefFor = (changes) => reviewsHref(locale, series.slug, { ...state, ...changes });
  const activeFilters = [applied.group, applied.length, applied.lang].filter(Boolean).length;

  const groups = [
    { key: null, label: 'review.filters.all', count: counts.all },
    { key: 'positive', label: 'review.group.positive', count: counts.positive },
    { key: 'mixed', label: 'review.group.mixed', count: counts.mixed },
    { key: 'negative', label: 'review.group.negative', count: counts.negative },
  ];
  const lengths = [
    { key: null, label: 'review.filters.all' },
    { key: 'short', label: 'review.length.short' },
    { key: 'long', label: 'review.length.long' },
  ];
  const langs = [
    { key: null, label: 'review.filters.all' },
    { key: 'ru', label: 'review.code.ru' },
    { key: 'en', label: 'review.code.en' },
  ];
  const sorts = [
    { key: 'helpful', label: 'review.sort.helpful' },
    { key: 'new', label: 'review.sort.new' },
    { key: 'long', label: 'review.sort.long' },
  ];

  return html`
<h1 class="reviews__title">${t(locale, 'review.list.title', { title: series.title })}</h1>

<div class="reviews">
  <div class="reviews__side">
    <aside class="reviews__summary" aria-label="${t(locale, 'review.summary.label')}">
      ${averageLine({
        locale,
        summary,
        label: t(locale, 'series.rating.site'),
        low: t(locale, 'rating.lowVotes', { count: summary.votes }),
        none: t(locale, 'rating.noVotes'),
      })}
      ${ownLine({ locale, own: ownRating, timezone })}
      ${when(summary.votes > 0, () => histogram({ locale, summary }))}
      ${actionView({ locale, action })}
    </aside>

    <details class="reviews__filters" open>
      <summary class="reviews__filters-summary">${t(locale,
        activeFilters > 0 ? 'review.filters.summaryCount' : 'review.filters.summary',
        { count: activeFilters })}</summary>
      <div class="reviews__filters-body">
        ${chipRow({ locale, id: 'f-group', param: 'group', label: 'review.group.label', items: groups,
          active: applied.group, hrefFor })}
        ${chipRow({ locale, id: 'f-length', param: 'length', label: 'review.length.label', items: lengths,
          active: applied.length, hrefFor })}
        ${chipRow({ locale, id: 'f-lang', param: 'lang', label: 'review.lang.label', items: langs,
          active: applied.lang, hrefFor })}
        ${chipRow({ locale, id: 'f-sort', param: 'sort', label: 'review.sort.label', items: sorts,
          active: applied.sort, hrefFor })}
      </div>
    </details>
  </div>

  <div class="reviews__feed">
    ${when(page.total > 0, () => html`
    <p class="reviews__total">${tPlural(locale, 'review.count', page.total)}</p>
    <ol class="reviews__list" role="list">
      ${page.items.map((item) => reviewCard({ locale, item, timezone, vote: votesById?.get(item.id) ?? null, report }))}
    </ol>`)}

    ${when(page.total === 0, () => emptyView({
      locale, slug: series.slug, filtered: activeFilters > 0, action,
    }))}

    ${when(page.pages > 1, () => pagination({ locale, page, hrefFor }))}
  </div>

  ${reportDialog({ locale, series, report })}
</div>`;
}

/**
 * Блок «Лучшие отзывы» на странице сериала (F-02-01 §4): три карточки тем же
 * порядком, что у ленты, и ссылка на весь список. Пустой блок не рисуется:
 * приглашение написать отзыв уже стоит в блоке «Ваш отзыв», и второе место
 * с теми же словами только сбивало бы с толку.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.series
 * @param {object[]} args.items не больше `review.top_on_series_page`
 * @param {string|null} [args.timezone]
 * @param {Map|null} [args.votesById] id отзыва → данные кнопки «Полезно»
 * @param {object|null} [args.report] состояние жалобы страницы (меню и диалог)
 */
export function topReviews({ locale, series, items, timezone = null, votesById = null, report = null }) {
  if (items.length === 0) return raw('');
  return html`
<section class="reviews-top" aria-labelledby="h-top-reviews">
  <h2 class="series__section-title" id="h-top-reviews">${t(locale, 'review.top.title')}</h2>
  <ol class="reviews__list reviews__list--top" role="list">
    ${items.map((item) => reviewCard({ locale, item, timezone, vote: votesById?.get(item.id) ?? null, report }))}
  </ol>
  <p class="reviews-top__more">
    <a class="button button--quiet" href="/${locale}/series/${series.slug}/reviews"
      >${t(locale, 'review.all')}</a>
  </p>
  ${reportDialog({ locale, series, report })}
</section>`;
}
