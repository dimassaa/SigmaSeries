// Дашборды аналитики (M8, F-08-03…F-08-05).
//
// У каждого числа есть определение, и оно открывается прямо на дашборде
// (R-AN-13): «пользователей 128» без определения значит четыре разные вещи
// у четырёх людей.
//
// Крупных чисел не больше пяти — их больше пяти, и ни одно не запоминается
// (F-08-03 §8а). Под каждым числом подписан период: число без периода —
// не число (F-08-03 §8г).

import { html, raw, when } from './render.js';
import { t } from '../i18n/strings.js';
import { metricOf } from '../services/analytics/metrics.js';

/**
 * Число в формате читателя.
 *
 * @param {string} locale
 * @param {number} value
 * @returns {string}
 */
function number(locale, value) {
  return new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'ru-RU').format(value);
}

/**
 * Столбиковая диаграмма: подпись под осью и текстовая сводка.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {string} args.title
 * @param {any[]} args.points
 * @returns {any}
 */
function barChart({ locale, title, points }) {
  const max = Math.max(1, ...points.map((point) => point.value));
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const bars = points.map((point, index) => {
    const height = Math.round((point.value / max) * 60);
    const x = 6 + index * 6;
    return html`<rect class="chart__bar" x="${x}" y="${66 - height}" width="4" height="${height}"></rect>`;
  });
  const labels = points.map((point, index) => {
    const x = 6 + index * 6;
    return html`<text class="chart__label" x="${x + 2}" y="76">${point.label}</text>`;
  });
  return html`
<div class="chart">
  <h3 class="chart__title">${title}</h3>
  <svg class="chart__svg" viewBox="0 0 ${Math.max(60, points.length * 6 + 6)} 80"
     role="img" aria-label="${title}">
    ${bars}${labels}
  </svg>
  <p class="chart__summary">${t(locale, 'analytics.chart.summary', { total: number(locale, total) })}</p>
</div>`;
}

/**
 * Карточка метрики: определение, формула, пример и известные искажения.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {string} args.key
 * @returns {any}
 */
function metricCard({ locale, key }) {
  const metric = metricOf(key);
  if (!metric) return html``;
  const title = locale === 'en' ? metric.titleEn : metric.titleRu;
  const definition = locale === 'en' ? metric.definitionEn : metric.definitionRu;
  const example = locale === 'en' ? metric.exampleEn : metric.exampleRu;
  const distortions = locale === 'en' ? metric.distortionsEn : metric.distortionsRu;
  return html`
<details class="metric">
  <summary class="metric__summary">${title}</summary>
  <div class="metric__body">
    <p class="metric__definition">${definition}</p>
    <p class="metric__line"><b>${t(locale, 'analytics.metric.formula')}</b> <code>${metric.formula}</code></p>
    <p class="metric__line"><b>${t(locale, 'analytics.metric.source')}</b> <code>${metric.source}</code></p>
    <p class="metric__example">${example}</p>
    <p class="metric__distortions-title">${t(locale, 'analytics.metric.distortions')}</p>
    <ul class="metric__distortions" role="list">
      ${distortions.map((line) => html`<li>${line}</li>`)}
    </ul>
    <p class="metric__version">${t(locale, 'analytics.metric.version', {
      version: metric.version, date: metric.changedAt,
    })}</p>
  </div>
</details>`;
}

/**
 * Обзор (S-60).
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {any} args.data
 * @returns {any}
 */
export function analyticsOverviewView({ locale, data }) {
  return html`
<div class="dash">
  <header class="dash__head">
    <h1 class="dash__title">${t(locale, 'analytics.overview.title')}</h1>
    <p class="dash__period">${t(locale, 'analytics.period.hours', { hours: data.hours })}</p>
  </header>

  ${when(data.demoShare > 0, () => html`
  <p class="dash__demo">${t(locale, 'analytics.demo.band', { share: data.demoShare })}</p>`)}

  <section class="dash__numbers" aria-labelledby="dash-numbers">
    <h2 class="visually-hidden" id="dash-numbers">${t(locale, 'analytics.overview.numbers')}</h2>
    ${data.numbers.map((item) => html`
    <div class="dash__number">
      <p class="dash__value">${number(locale, item.value)}</p>
      <p class="dash__label">${t(locale, `analytics.number.${item.key}`)}</p>
      ${when(item.metric, () => metricCard({ locale, key: item.metric }))}
    </div>`)}
  </section>

  <section class="dash__graphs" aria-labelledby="dash-graphs">
    <h2 class="visually-hidden" id="dash-graphs">${t(locale, 'analytics.overview.graphs')}</h2>
    ${data.graphs.map((graph) => html`
    ${barChart({
      locale,
      title: locale === 'en' ? graph.titleEn : graph.titleRu,
      points: graph.points,
    })}`)}
  </section>

  ${when(data.rejects?.length, () => html`
  <section class="dash__rejects" aria-labelledby="dash-rejects">
    <h2 class="dash__section" id="dash-rejects">${t(locale, 'analytics.rejects.title')}</h2>
    <ul class="dash__reject-list" role="list">
      ${data.rejects.map((row) => html`
      <li class="dash__reject">${row.name || '—'} · ${row.reason} · ${row.count}</li>`)}
    </ul>
  </section>`)}
</div>`;
}

/**
 * Воронка и удержание (S-61).
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {any} args.data
 * @returns {any}
 */
export function analyticsRetentionView({ locale, data }) {
  const max = Math.max(1, ...data.funnel.map((step) => step.value));
  const steps = data.funnel.map((step) => html`
  <li class="funnel__step">
    <span class="funnel__label">${t(locale, `analytics.funnel.${step.key}`)}</span>
    <span class="funnel__value">${number(locale, step.value)}</span>
    <span class="funnel__bar" style="--funnel-width:${Math.round((step.value / max) * 100)}%"></span>
  </li>`);
  return html`
<div class="dash">
  <header class="dash__head">
    <h1 class="dash__title">${t(locale, 'analytics.retention.title')}</h1>
    <p class="dash__period">${t(locale, 'analytics.period.hours', { hours: data.hours })}</p>
  </header>
  <section class="funnel" aria-labelledby="funnel-title">
    <h2 class="dash__section" id="funnel-title">${t(locale, 'analytics.funnel.title')}</h2>
    <ol class="funnel__list" role="list">${steps}</ol>
  </section>
</div>`;
}

/**
 * Контент и поиск (S-62).
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {any} args.data
 * @returns {any}
 */
export function analyticsContentView({ locale, data }) {
  return html`
<div class="dash">
  <header class="dash__head">
    <h1 class="dash__title">${t(locale, 'analytics.content.title')}</h1>
    <p class="dash__period">${t(locale, 'analytics.period.hours', { hours: data.hours })}</p>
  </header>
  <section class="dash__rows" aria-labelledby="content-search">
    <h2 class="dash__section" id="content-search">${t(locale, 'analytics.content.search')}</h2>
    <dl class="dash__pairs">
      <div class="dash__pair"><dt>${t(locale, 'analytics.content.requests')}</dt><dd>${number(locale, data.search.submits)}</dd></div>
      <div class="dash__pair"><dt>${t(locale, 'analytics.content.empty')}</dt><dd>${data.search.emptyShare}%</dd></div>
      <div class="dash__pair"><dt>${t(locale, 'analytics.content.length')}</dt><dd>${data.search.avgLength}</dd></div>
    </dl>
    <p class="dash__note">${t(locale, 'analytics.content.note')}</p>
  </section>
</div>`;
}

/**
 * Качество модерации (S-63).
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {any} args.data
 * @returns {any}
 */
export function analyticsModerationView({ locale, data }) {
  return html`
<div class="dash">
  <header class="dash__head">
    <h1 class="dash__title">${t(locale, 'analytics.moderation.title')}</h1>
    <p class="dash__period">${t(locale, 'analytics.period.hours', { hours: data.hours })}</p>
  </header>
  <section class="dash__rows" aria-labelledby="mod-quality">
    <h2 class="dash__section" id="mod-quality">${t(locale, 'analytics.moderation.quality')}</h2>
    <dl class="dash__pairs">
      <div class="dash__pair"><dt>${t(locale, 'analytics.moderation.flagged')}</dt><dd>${number(locale, data.moderation.flagged)}</dd></div>
      <div class="dash__pair"><dt>${t(locale, 'analytics.moderation.decided')}</dt><dd>${number(locale, data.moderation.decided)}</dd></div>
      <div class="dash__pair"><dt>${t(locale, 'analytics.moderation.false')}</dt><dd>${data.moderation.falsePositive}%</dd></div>
    </dl>
    ${metricCard({ locale, key: 'false_positives' })}
  </section>
</div>`;
}

/**
 * Показатели скорости (S-64).
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {any} args.data
 * @returns {any}
 */
export function analyticsPerformanceView({ locale, data }) {
  return html`
<div class="dash">
  <header class="dash__head">
    <h1 class="dash__title">${t(locale, 'analytics.performance.title')}</h1>
    <p class="dash__period">${t(locale, 'analytics.period.hours', { hours: data.hours })}</p>
  </header>
  <section class="dash__rows" aria-labelledby="vitals">
    <h2 class="dash__section" id="vitals">${t(locale, 'analytics.performance.vitals')}</h2>
    <dl class="dash__pairs">
      <div class="dash__pair"><dt>LCP</dt><dd>${data.vitals.lcp} мс</dd></div>
      <div class="dash__pair"><dt>INP</dt><dd>${data.vitals.inp} мс</dd></div>
      <div class="dash__pair"><dt>CLS</dt><dd>${data.vitals.cls}</dd></div>
    </dl>
    ${metricCard({ locale, key: 'vitals' })}
  </section>
</div>`;
}

export { raw };
