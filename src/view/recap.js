// Персональные итоги (M7, S-33).
//
// Слайды приходят одним ответом и переключаются на клиенте: сервер отдаёт
// все разом, а листание — дело браузера. Каждый слайд читается вслух целиком —
// заголовок, число и пояснение (F-07-02 §8а): слайд из одного числа был бы
// картинкой, а не доступным текстом.
//
// Страница всегда noindex: персональные числа не индексируются, даже если
// человек открыл свои итоги публично (M7 §13).

import { html, raw, when } from './render.js';
import { t } from '../i18n/strings.js';
import { tPlural } from '../i18n/plural.js';
import { monthTitle } from './dates.js';

/**
 * Число в формате читателя.
 *
 * @param {string} locale
 * @param {number|string} value
 * @returns {string}
 */
function number(locale, value) {
  if (typeof value === 'string') return value;
  return new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'ru-RU').format(value);
}

/**
 * Итоги: слайды, периоды и шеринг.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {import('../services/insights/recap.js').RecapData} args.recap данные итогов
 * @param {string} args.period выбранный период
 * @param {Array<{slug: string, title: string}>} args.popular что можно отметить
 * @param {boolean} [args.own] свои итоги (для кнопки «поделиться»)
 * @param {boolean} [args.public] итоги открыты публично
 * @param {string} [args.csrf] токен формы (для сборки картинки)
 * @returns {any} готовая разметка
 */
export function recapView({
  locale, recap, period, popular = [], own = true, public: isPublic = false, csrf = '',
}) {
  const slides = recap.slides ?? [];
  const title = period === 'all'
    ? t(locale, 'recap.title.all')
    : period === 'month'
      ? t(locale, 'recap.title.month', { month: monthTitle(locale, recap.year, recap.month) })
      : t(locale, 'recap.title.year', { year: recap.year });

  return html`
<div class="recap" data-recap data-advance="8000">
  <header class="recap__head">
    <h1 class="recap__title">${title}</h1>
    <nav class="recap__periods" aria-label="${t(locale, 'recap.periods.label')}">
      <a class="recap__period${period === 'year' ? ' recap__period--current' : ''}"
        href="?period=year"${raw(period === 'year' ? ' aria-current="page"' : '')}
        >${recap.year}</a>
      <a class="recap__period${period === 'month' ? ' recap__period--current' : ''}"
        href="?period=month"${raw(period === 'month' ? ' aria-current="page"' : '')}
        >${monthTitle(locale, recap.year, recap.month)}</a>
      <a class="recap__period${period === 'all' ? ' recap__period--current' : ''}"
        href="?period=all"${raw(period === 'all' ? ' aria-current="page"' : '')}
        >${t(locale, 'recap.periods.all')}</a>
    </nav>
  </header>

  ${when(!recap.enough, () => html`
  <section class="recap__little">
    <h2 class="recap__little-title">${t(locale, 'recap.little.title')}</h2>
    <p class="recap__little-text">${t(locale, 'recap.little.text', {
      marks: recap.marks ?? 0,
      need: 50,
    })}</p>
    ${when(popular.length > 0, () => html`
    <ul class="recap__popular" role="list">
      ${popular.map((item) => html`
      <li class="recap__popular-item">
        <a class="recap__popular-link" href="/${locale}/series/${item.slug}">${item.title}</a>
      </li>`)}
    </ul>`)}
    <p><a class="button button--primary" href="/${locale}/">${t(locale, 'recap.little.go')}</a></p>
  </section>`)}

  ${when(recap.enough && slides.length > 0, () => html`
  <div class="recap__deck">
    ${slides.map((slide, index) => html`
    <section class="recap__slide" data-slide="${index + 1}"${raw(index === 0 ? '' : ' hidden')}>
      <h2 class="recap__slide-title">${t(locale, `recap.slide.${slide.key}.title`)}</h2>
      <p class="recap__value">${number(locale, slide.value)}</p>
      ${when(slide.unit, () => html`
      <p class="recap__unit">${tPlural(locale, `recap.unit.${slide.unit}`, Number(slide.value))}</p>`)}
      ${when(slide.notePlural, () => html`
      <p class="recap__note">${tPlural(locale, `recap.slide.${slide.key}.note`, Number(slide.params?.count ?? 0))}</p>`,
      () => html`
      <p class="recap__note">${t(locale, `recap.slide.${slide.key}.note`, slide.params ?? {})}</p>`)}
      ${when(slide.link, () => html`
      <a class="recap__link" href="/${locale}${slide.link.href}">${slide.link.title}</a>`)}
    </section>`)}

    <section class="recap__slide recap__slide--final" data-slide="${slides.length + 1}" hidden>
      <h2 class="recap__slide-title">${t(locale, 'recap.final.title')}</h2>
      <p class="recap__note">${t(locale, 'recap.final.text')}</p>
      ${when(own, () => html`
      <p class="recap__final-actions">
        <button class="button button--primary" type="button" data-share
          >${t(locale, 'recap.final.share')}</button>
      </p>`)}
      <p class="recap__note">${isPublic
        ? t(locale, 'recap.final.public')
        : t(locale, 'recap.final.private')}</p>
    </section>
  </div>

  <p class="recap__progress" data-progress aria-live="polite"
    data-template="${t(locale, 'recap.progress.template')}"
    >${t(locale, 'recap.progress', { page: 1, pages: slides.length + 1 })}</p>

  <div class="recap__controls">
    <button class="button button--quiet" type="button" data-prev
      >${t(locale, 'recap.prev')}</button>
    <button class="button button--quiet" type="button" data-next
      >${t(locale, 'recap.next')}</button>
  </div>`)}

  ${when(own, () => html`
  <dialog class="recap__share" data-share-dialog>
    <h2 class="recap__slide-title">${t(locale, 'recap.share.title')}</h2>
    <div class="recap__share-body" data-share-body
      data-error="${t(locale, 'recap.share.error')}"
      >${t(locale, 'recap.share.building')}</div>
    <p class="recap__final-actions">
      <a class="button button--primary" data-share-download download="recap.png" hidden
        >${t(locale, 'recap.share.download')}</a>
      <button class="button" type="button" data-share-copy
        data-copied="${t(locale, 'recap.share.copied')}"
        >${t(locale, 'recap.share.copy')}</button>
    </p>
    <form method="post" action="/${locale}/recap/share" hidden>
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="period" value="${period}">
      <button class="button" type="submit">${t(locale, 'recap.share.download')}</button>
    </form>
  </dialog>`)}
</div>`;
}
