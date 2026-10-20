// Блок «Ваш отзыв» на странице сериала (F-04-04, S-06).
//
// У блока три состояния: писать нельзя (гость, нет отметки, мьют) — сказано
// почему; отзыв ждёт решения редактора — показан статус и фрагмент с
// подсветкой (R-MOD-12); отзыву можно написать или его исправить — открыт
// диалог с оценкой, текстом, счётчиком, спойлером и языком.
//
// Диалог — настоящий `<dialog>`: открывается скриптом модально, а без скрипта
// показывается переходом по `#review-dialog` (стиль `:target`). Так форма
// работает и без JavaScript, а с ним не уводит со страницы.
//
// Слово из словаря автору не показывается: подсвечен только его собственный
// фрагмент, а причина названа категорией (R-MOD-12). Введённое после ошибки
// сохраняется в форме: потерять набранный текст — худшее, что может сделать
// форма.

import { html, when, raw } from './render.js';
import { t } from '../i18n/strings.js';
import { dayLabel } from './dates.js';
import { REVIEW } from '../config/settings.js';
import { detectLang } from '../services/reviews/store.js';

/** Предел длины — из настроек, а не из разметки: счётчик и проверка об одном. */
const MAX = REVIEW.lenMax;

/** Оценка в форме отзыва — та же шкала, что у блока оценки (M4 §12). */
const SCALE = Array.from({ length: 10 }, (_, index) => index + 1);

/**
 * Текст с подсветкой находок по позициям в исходной строке (R-MOD-06).
 *
 * @param {string} text
 * @param {{start: number, end: number}[]} spans
 * @returns {{text: string, marked: boolean}[]}
 */
export function highlight(text, spans) {
  const sorted = [...spans].filter((s) => Number.isInteger(s?.start) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const segments = [];
  let at = 0;
  for (const span of sorted) {
    if (span.start < at) continue;
    if (span.start > at) segments.push({ text: text.slice(at, span.start), marked: false });
    segments.push({ text: text.slice(span.start, span.end), marked: true });
    at = span.end;
  }
  if (at < text.length) segments.push({ text: text.slice(at), marked: false });
  return segments;
}

/**
 * Абзацы текста: пустая строка разделяет абзацы (F-04-04 §8д «разметки нет»).
 *
 * Разметка ставится сервером по простому правилу, а не разбирается как HTML:
 * текст автора остаётся текстом, и ни одна его часть не исполняется.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function paragraphs(text) {
  return String(text ?? '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
}

/** Категории находок без повторов, в порядке первого появления. */
function categoriesOf(matched) {
  const seen = new Set();
  const out = [];
  for (const item of matched ?? []) {
    if (!item.category || seen.has(item.category)) continue;
    seen.add(item.category);
    out.push(item.category);
  }
  return out;
}

/**
 * Форма отзыва: оценка, текст, счётчик, спойлер и язык.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {string} args.action
 * @param {string} args.csrf
 * @param {object|null} args.own свой отзыв, если уже есть
 * @param {number|null} [args.rating] текущая оценка — подставляется в шкалу
 * @param {object|null} [args.values] введённое после ошибки
 * @param {object|null} [args.error] `{ key, params }` — что показать над формой
 */
function reviewForm({ locale, action, csrf, own, rating = null, values = null, error = null }) {
  const body = values?.body ?? own?.body ?? '';
  const value = values?.value ?? rating ?? null;
  const spoiler = values?.spoiler ?? own?.spoiler ?? false;
  // Язык — по преобладанию письменности и поправимый (R-I18N-08): пустой
  // текст ничего не говорит, поэтому до первого ввода берётся язык страницы.
  const lang = values?.lang ?? own?.lang ?? (body.trim() ? detectLang(body) : locale);

  return html`
<form class="review__form" method="post" action="${action}" data-review-form>
  <input type="hidden" name="csrf" value="${csrf}">
  ${when(error, () => html`
  <p class="review__error" role="alert" id="review-error">${t(locale, error.key, error.params ?? {})}</p>`)}

  <fieldset class="review__rating">
    <legend class="review__legend">${t(locale, 'review.rating.legend')}</legend>
    <div class="rating__scale">
      ${SCALE.map((n) => html`
      <label class="rating__value${value === n ? ' rating__value--on' : ''}">
        <input class="rating__input" type="radio" name="value" value="${n}" ${value === n ? raw('checked') : raw('')}>
        <span class="rating__number" aria-hidden="true">${n}</span>
        <span class="visually-hidden">${t(locale, 'rating.value', { value: n })}</span>
      </label>`)}
    </div>
  </fieldset>

  <div class="review__field">
    <label class="review__label" for="review-body">${t(locale, 'review.label')}</label>
    <textarea class="review__textarea" id="review-body" name="body" rows="8"
              maxlength="${MAX}" placeholder="${t(locale, 'review.placeholder')}"
              ${error ? raw('aria-describedby="review-error"') : raw('')}
              data-review-body>${body}</textarea>
    <p class="review__count" data-review-count>
      <span data-review-count-text>${t(locale, 'review.counter', { count: body.length, max: MAX })}</span>
      <span hidden data-review-counter-template>${t(locale, 'review.counter', { count: '{count}', max: MAX })}</span>
    </p>
  </div>

  <label class="review__check">
    <input type="checkbox" name="spoiler" value="on" ${spoiler ? raw('checked') : raw('')}>
    <span>${t(locale, 'review.spoiler')}</span>
  </label>

  <label class="review__lang">
    <span>${t(locale, 'review.lang')}</span>
    <select name="lang" data-review-lang>
      <option value="ru" ${lang === 'ru' ? raw('selected') : raw('')}>${t(locale, 'review.lang.ru')}</option>
      <option value="en" ${lang === 'en' ? raw('selected') : raw('')}>${t(locale, 'review.lang.en')}</option>
    </select>
  </label>

  <p class="review__buttons">
    <button class="button button--primary" type="submit">${own ? t(locale, 'review.save') : t(locale, 'review.submit')}</button>
    <a class="button button--quiet" href="#reviews" data-review-close>${t(locale, 'review.cancel')}</a>
  </p>
</form>`;
}

/**
 * Блок «Ваш отзыв» целиком.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {string} args.slug
 * @param {object|null} args.own свой отзыв
 * @param {object} args.gate `{ signedIn, canWrite, reason, mute, csrf, cooldownSec }`
 * @param {object|null} [args.review] `{ matched }` — находки для подсветки
 * @param {number|null} [args.rating] текущая оценка
 * @param {object|null} [args.values] введённое после ошибки
 * @param {object|null} [args.error]
 * @param {boolean} [args.editing] форма открыта после ошибки или по запросу
 * @param {string|null} [args.timezone]
 */
export function reviewSection({
  locale, slug, own = null, gate, review = null, rating = null, values = null,
  error = null, editing = false, timezone = null,
}) {
  const action = `/${locale}/series/${slug}/reviews`;
  const cooldown = gate.cooldownSec ?? 0;

  // Гость: своего отзыва у него быть не может — только приглашение войти.
  if (gate.signedIn === false) {
    return html`
<section class="review" id="reviews" aria-labelledby="h-reviews">
  <h2 class="series__section-title" id="h-reviews">${t(locale, 'review.title')}</h2>
  <p class="review__hint">
    <a href="/${locale}/login?next=${encodeURIComponent(`/${locale}/series/${slug}`)}"
      >${t(locale, 'review.signIn')}</a>
  </p>
</section>`;
  }

  // Мьют и нехватка прав без своего отзыва: форма не рисуется, причина названа.
  if (!own && !gate.canWrite) {
    return html`
<section class="review" id="reviews" aria-labelledby="h-reviews">
  <h2 class="series__section-title" id="h-reviews">${t(locale, 'review.title')}</h2>
  ${when(gate.mute, () => muteHint({ locale, gate, timezone }))}
  ${when(!gate.mute, () => html`
  <p class="review__hint">${t(locale, `review.hint.${gate.reason ?? 'no-mark'}`)}</p>`)}
</section>`;
  }

  // Диалог живёт в разметке всегда, когда человек вправе писать: к нему ведут
  // ссылки «Изменить» и «Написать отзыв». Без элемента обе ветки — модальная
  // (скрипт) и якорная (без скрипта) — упираются в пустоту: правку нельзя
  // начать. `editing` открывает диалог сразу (после отказа 422), но не решает,
  // быть ли ему в DOM.
  const formOpen = gate.canWrite;
  const pending = own && (own.state === 'flagged' || own.state === 'checking');
  const spans = review?.matched ?? [];
  const cats = categoriesOf(spans);

  return html`
<section class="review${own ? ` review--own review--${own.state}` : ''}" id="reviews" aria-labelledby="h-reviews"
         ${own ? raw('data-review-own') : raw('')}>
  <h2 class="series__section-title" id="h-reviews">${t(locale, 'review.title')}</h2>

  ${when(gate.mute, () => muteHint({ locale, gate, timezone }))}

  ${when(own && !editing, () => html`
  <p class="review__state review__state--${own.state}" role="status">${t(locale, `review.state.${own.state}`)}</p>`)}

  ${when(own && own.state === 'published' && !editing, () => html`
  <div class="review__body">
    ${paragraphs(own.body).map((part) => html`<p>${part}</p>`)}
    ${when(own.spoiler, () => html`
    <p class="review__spoiler-note">${t(locale, 'review.spoiler')}</p>`)}
  </div>`)}

  ${when(pending && !editing, () => html`
  <div class="review__flagged">
    <p class="review__notice">${t(locale, own.state === 'checking' ? 'ugc.check.unavailable' : 'ugc.flagged')}</p>
    ${when(own.state === 'flagged', () => html`
    <p class="review__fragment">
      ${highlight(own.body, spans).map((segment) => (segment.marked
        ? html`<mark class="review__mark">${segment.text}</mark>`
        : html`${segment.text}`))}
    </p>
    ${when(cats.length > 0, () => html`
    <p class="review__category">${t(locale, 'review.category')} ${cats
      .map((c) => t(locale, `mod.category.${c}`)).join(', ')}</p>`)}`)}
  </div>`)}

  ${when(own && (own.state === 'rejected' || own.state === 'hidden') && !editing, () => html`
  <div class="review__body">
    ${paragraphs(own.body).map((part) => html`<p>${part}</p>`)}
  </div>`)}

  ${when(own && !editing && gate.canWrite, () => html`
  <p class="review__actions">
    ${when(cooldown === 0, () => html`
    <a class="button button--quiet" href="#review-dialog" data-review-open>${t(locale, 'review.edit')}</a>`)}
    ${when(cooldown > 0, () => html`
    <span class="review__cooldown">${t(locale, 'review.error.cooldown', { minutes: Math.ceil(cooldown / 60) })}</span>`)}
  </p>`)}

  ${when(!own && gate.canWrite, () => html`
  <p class="review__actions">
    <a class="button button--primary" href="#review-dialog" data-review-open>${t(locale, 'review.write')}</a>
  </p>`)}

  ${when(own && !editing, () => html`
  <form class="review__delete" method="post" action="${action}/delete" data-review-delete
        data-confirm="${t(locale, 'review.delete.confirm')}">
    <input type="hidden" name="csrf" value="${gate.csrf}">
    <button class="button button--quiet" type="submit">${t(locale, 'review.delete')}</button>
  </form>`)}

  ${when(formOpen, () => html`
  <dialog class="review__dialog" id="review-dialog" aria-labelledby="review-dialog-title"
          data-review-key="${slug}" ${error ? raw('open') : raw('')}>
    <div class="review__dialog-body">
      <h3 class="review__dialog-title" id="review-dialog-title">${own ? t(locale, 'review.edit') : t(locale, 'review.write')}</h3>
      ${reviewForm({ locale, action, csrf: gate.csrf, own, rating, values, error })}
    </div>
  </dialog>`)}
</section>`;
}

/** Строка мьюта: причина и дата окончания (F-05-08 §4). */
function muteHint({ locale, gate, timezone }) {
  return html`
  <p class="review__hint">
    ${when(gate.mute.until, () => html`${t(locale, 'review.hint.muted', {
      date: dayLabel(locale, gate.mute.until, timezone ?? undefined),
      reason: gate.mute.reason,
    })}`, () => html`${t(locale, 'review.hint.mutedNoDate', { reason: gate.mute.reason })}`)}
  </p>`;
}
