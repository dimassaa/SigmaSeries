// Оценки: сериал (F-04-01, OP-03) и серия (F-04-02).
//
// Разметка шкалы одна на три места — блок на странице сериала (S-06), блок на
// странице серии (S-08) и строка в списке серий (S-07). Это одна и та же
// группа радиокнопок «Оценка 7 из 10» с управлением стрелками (M4 §12), и
// разойтись правилам доступности у неё неоткуда, пока она собрана одним кодом.
//
// Ряд из десяти чисел — радиокнопки, а не ссылки и не кнопки: выбор виден
// сразу, работает без скрипта, а выбранное отмечено рамкой и подписью, а не
// только цветом (R-A11Y-19). Право и состояние приходят с сервера: оценить
// без отметки нельзя (EC-V1), и объясняется это словами, а не молчаливым
// отсутствием блока.

import { html, when, raw } from './render.js';
import { t } from '../i18n/strings.js';
import { tPlural } from '../i18n/plural.js';
import { RATING } from '../config/settings.js';
import { dayLabel } from './dates.js';

/** Десять значений шкалы — одна последовательность на все экраны. */
const SCALE = Array.from({ length: 10 }, (_, index) => index + 1);

/**
 * Пояснения, почему серию оценить нельзя.
 *
 * У серии свои слова там, где дело в серии: «отметьте эту серию» вместо
 * «отметьте сериал», «серия ещё не вышла». Подтверждение адреса — свойство
 * человека, а не серии, и говорится о нём теми же словами, что на странице
 * сериала.
 */
const EPISODE_HINTS = {
  'no-mark': 'rating.episode.hint.no-mark',
  'not-aired': 'rating.episode.hint.not-aired',
  'not-confirmed': 'rating.hint.not-confirmed',
};

/** Число с одним знаком и разделителем языка: RU «8,7», EN «8.7» (R-I18N-04). */
export function number(locale, value) {
  const text = value.toFixed(1);
  return locale === 'en' ? text : text.replace('.', ',');
}

/**
 * Ряд из десяти радиокнопок с кнопками «оценить» и «убрать».
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {string} args.action адрес формы
 * @param {string} args.csrf
 * @param {number|null} args.own своя оценка, если она уже есть
 * @param {string} args.legend подпись группы для слуха
 * @param {string} args.submit подпись кнопки оценки
 * @param {string} [args.submitFor] уточнение для слуха: «серию 3»
 * @param {string} args.clear подпись кнопки снятия
 * @param {string} [args.clearFor] уточнение для слуха: «у серии 3»
 * @param {object|null} [args.hidden] скрытые поля формы готовой разметкой
 * @param {boolean} [args.compact] мелкий ряд для списка серий (S-07)
 */
function scaleForm({
  locale, action, csrf, own, legend, submit, submitFor = '', clear, clearFor = '',
  hidden = null, compact = false,
}) {
  return html`
<form class="rating__form${compact ? ' rating__form--compact' : ''}" method="post" action="${action}">
  <input type="hidden" name="csrf" value="${csrf}">
  ${hidden ?? ''}
  <fieldset class="rating__scale">
    <legend class="visually-hidden">${legend}</legend>
    ${SCALE.map((value) => html`
    <label class="rating__value${own === value ? ' rating__value--on' : ''}">
      <input class="rating__input" type="radio" name="value" value="${value}"
             ${own === value ? raw('checked') : raw('')}>
      <span class="rating__number" aria-hidden="true">${value}</span>
      <span class="visually-hidden">${t(locale, 'rating.value', { value })}</span>
    </label>`)}
  </fieldset>
  <button class="button button--primary" type="submit"
    >${submit}${when(submitFor, () => html`<span class="visually-hidden"> ${submitFor}</span>`)}</button>
  ${when(own !== null, () => html`
  <button class="button button--quiet" type="submit" name="value" value="0"
    >${clear}${when(clearFor, () => html`<span class="visually-hidden"> ${clearFor}</span>`)}</button>`)}
</form>`;
}

/**
 * Среднее и число голосов; ниже порога — «мало оценок».
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.summary
 * @param {number} args.threshold порог показа числа: сериал 5, серия 3
 */
function averageLine({ locale, summary, threshold }) {
  return html`
  ${when(summary.shown && summary.votes > 0, () => html`
  <p class="rating__average">
    <span class="rating__value">${number(locale, summary.average)}</span>
    <span class="rating__votes">${tPlural(locale, 'rating.votes', summary.votes)}</span>
  </p>`)}

  ${when(summary.votes > 0 && !summary.shown, () => html`
  <p class="rating__hint">${t(locale, 'rating.fewVotes', { count: threshold })}</p>`)}`;
}

/**
 * «Ваша оценка» и, если голос ещё не учтён, когда он войдёт (EC-V4).
 *
 * Человек, поставивший оценку сразу после регистрации, видит своё число и
 * должен понимать, почему оно не сдвинуло рейтинг.
 */
function ownLine({ locale, own, timezone }) {
  return when(own, () => html`
  <p class="rating__own">${t(locale, 'rating.own', { value: own.value })}${
    when(own.counted === false, () => html`
    <span class="rating__mature"> ${t(locale, 'rating.matures', {
      date: dayLabel(locale, own.maturesAt, timezone ?? undefined),
    })}</span>`)}</p>`);
}

/**
 * Блок оценки сериала (S-06).
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {string} args.slug
 * @param {object} args.rating данные блока: `summary`, `own`, `canRate`, `reason`
 * @param {string|null} [args.timezone] пояс посетителя для подписи дозревания
 */
export function seriesRatingBlock({ locale, slug, rating: block, timezone = null }) {
  const { summary, own, canRate, reason, signedIn, csrf } = block;
  const maxVotes = Math.max(1, ...SCALE.map((value) => summary.histogram.get(value) ?? 0));

  return html`
<section class="rating" aria-labelledby="h-rating">
  <h2 class="series__section-title" id="h-rating">${t(locale, 'rating.title')}</h2>

  ${averageLine({ locale, summary, threshold: RATING.minVotesDisplay })}

  ${when(signedIn && canRate, () => scaleForm({
    locale,
    action: `/${locale}/series/${slug}/rating`,
    csrf,
    own: own?.value ?? null,
    legend: t(locale, 'rating.legend'),
    submit: t(locale, 'rating.submit'),
    clear: t(locale, 'rating.clear'),
  }))}

  ${when(signedIn && !canRate, () => html`
  <p class="rating__hint">${t(locale, `rating.hint.${reason ?? 'no-mark'}`)}</p>`)}

  ${when(!signedIn, () => html`
  <p class="rating__hint">
    <a href="/${locale}/login?next=${encodeURIComponent(`/${locale}/series/${slug}`)}"
      >${t(locale, 'rating.signIn')}</a>
  </p>`)}

  ${ownLine({ locale, own, timezone })}

  ${when(summary.votes > 0, () => html`
  <div class="rating__bars">
    ${SCALE.map((value) => html`
    <div class="rating__bar">
      <span class="rating__bar-label">${value}</span>
      <!-- Нативная полоса, а не блок с шириной в процентах: у неё есть
           доступное значение для программ чтения с экрана, и стилизуется
           она через accent-color, как полоса прогресса просмотра. -->
      <progress class="rating__bar-fill" value="${summary.histogram.get(value) ?? 0}"
                max="${maxVotes}"></progress>
      <span class="rating__bar-count">${summary.histogram.get(value) ?? 0}</span>
    </div>`)}
  </div>`)}
</section>`;
}

/**
 * Блок оценки серии (S-08): крупнее строки списка, с приглашением войти.
 *
 * Якорь `ep-{номер}` нужен после записи: маршрут возвращает человека к оценке
 * той серии, которую он оценил, — на этой странице это сам блок, в списке серий
 * строка с тем же адресом.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {string} args.slug
 * @param {number} args.season
 * @param {number} args.episode номер серии
 * @param {object} args.rating данные блока: `summary`, `own`, `canRate`, `reason`
 * @param {string|null} [args.timezone]
 */
export function episodeRatingBlock({ locale, slug, season, episode, rating: block, timezone = null }) {
  const { summary, own, canRate, reason, signedIn, csrf } = block;
  const href = `/${locale}/series/${slug}/seasons/${season}/episodes/${episode}`;

  return html`
<section class="rating rating--episode" id="ep-${episode}" aria-labelledby="h-episode-rating">
  <h2 class="series__section-title" id="h-episode-rating">${t(locale, 'rating.episode.title')}</h2>

  ${averageLine({ locale, summary, threshold: RATING.minVotesEpisode })}

  ${when(signedIn && canRate, () => scaleForm({
    locale,
    action: `${href}/rating`,
    csrf,
    own: own?.value ?? null,
    legend: t(locale, 'rating.episode.legend', { number: episode }),
    submit: t(locale, 'rating.submit'),
    submitFor: t(locale, 'rating.episode.submitFor', { number: episode }),
    clear: t(locale, 'rating.clear'),
    clearFor: t(locale, 'rating.episode.clearFor', { number: episode }),
  }))}

  ${when(signedIn && !canRate, () => html`
  <p class="rating__hint">${t(locale, EPISODE_HINTS[reason] ?? 'rating.episode.hint.no-mark')}</p>`)}

  ${when(!signedIn, () => html`
  <p class="rating__hint">
    <a href="/${locale}/login?next=${encodeURIComponent(href)}">${t(locale, 'rating.signIn')}</a>
  </p>`)}

  ${ownLine({ locale, own, timezone })}
</section>`;
}

/**
 * Будет ли в строке списка что показать: среднее с числом или шкала.
 *
 * Строка списка не объясняет «почему нельзя» — это делает страница серии, где
 * человек и оказался, если шкалы не нашлось. Экспорт нужен лишь затем, чтобы
 * не рисовать пустую обёртку вокруг ничего.
 *
 * @param {object|null} rating блок оценки серии
 * @returns {boolean}
 */
export function hasEpisodeRating(rating) {
  if (!rating) return false;
  return rating.summary.votes > 0 || (rating.signedIn && rating.canRate);
}

/**
 * Оценка в строке списка серий (S-07).
 *
 * Компактно, но то же правило: среднее и число — всем, шкала — тому, кто
 * может оценить. Пояснение «почему нельзя» живёт на странице серии: двадцать
 * повторов одной фразы в списке — шум, из-за которого перестают читать и то,
 * что важно. Сервер отказывает в любом случае.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {string} args.slug
 * @param {number} args.season
 * @param {number} args.episode номер серии
 * @param {object} args.rating
 */
export function episodeRatingCell({ locale, slug, season, episode, rating: block }) {
  const { summary, own, canRate, signedIn, csrf } = block;

  return html`
<div class="season__episode-rating">
  ${when(summary.shown && summary.votes > 0, () => html`
  <span class="rating__cell">
    <span class="rating__cell-value">${number(locale, summary.average)}</span>
    <span class="rating__cell-dot" aria-hidden="true">·</span>
    <span class="rating__cell-votes">${tPlural(locale, 'rating.votes', summary.votes)}</span>
  </span>`)}

  ${when(summary.votes > 0 && !summary.shown, () => html`
  <span class="rating__cell rating__cell--few">${t(locale, 'rating.episode.few')}</span>`)}

  ${when(signedIn && canRate, () => scaleForm({
    locale,
    action: `/${locale}/series/${slug}/seasons/${season}/episodes/${episode}/rating`,
    csrf,
    own: own?.value ?? null,
    legend: t(locale, 'rating.episode.legend', { number: episode }),
    submit: t(locale, 'rating.submit'),
    submitFor: t(locale, 'rating.episode.submitFor', { number: episode }),
    clear: t(locale, 'rating.clear'),
    clearFor: t(locale, 'rating.episode.clearFor', { number: episode }),
    // Откуда пришёл запрос: чтобы вернуть человека в список, а не увести на
    // страницу серии. Значение выбирает одну из двух внутренних страниц одного
    // сериала, поэтому чужих адресов здесь появиться не может.
    hidden: html`<input type="hidden" name="from" value="season">`,
    compact: true,
  }))}
</div>`;
}
