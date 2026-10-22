// Экран очереди модерации (F-05-04, S-50).
//
// Экран показывает материал крупно и даёт два действия: «Одобрить» и
// «Запретить». Найденное слово видит редактор и не видит автор — иначе
// словарь превращается в оракул, из которого автор подбирает обход (R-MOD-12).
//
// Слева — очередь в порядке разбора, сгруппированная кластерами: двадцать
// одинаковых материалов занимают одну строку, а не двадцать.

import { html, when, raw } from './render.js';
import { t } from '../i18n/strings.js';
import { dayLabel } from './dates.js';
import { paragraphs } from './reviews.js';
import { MODERATION } from '../services/settings.js';

/**
 * Кластер: разбор группы и разделение её (F-05-03 §5).
 *
 * Редактор видит материалы группы и выбирает те, к которым решение
 * относится: ошибочно объединённые материалы остаются в очереди, а решение
 * применяется только к выбранным.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.group кластер (из `groups`)
 * @param {string} args.csrf
 * @returns {object}
 */
export function clusterView({ locale, group, csrf }) {
  return html`
<div class="mod">
  <h1 class="mod__title">${t(locale, 'mod.cluster.title', { count: group.size })}</h1>
  <p class="mod__warning">
    ${t(locale, 'mod.cluster.hint', { count: group.size, authors: group.authors })}
  </p>

  <form class="mod__form" method="post" action="/${locale}/mod/cluster">
    <input type="hidden" name="csrf" value="${csrf}">
    <ol class="mod__cluster" role="list">
      ${group.materials.map((item) => html`
      <li class="mod__cluster-item">
        <label class="mod__cluster-pick">
          <input type="checkbox" name="materials" value="${item.id}">
          <span class="visually-hidden">${t(locale, 'mod.cluster.pick', { id: item.id })}</span>
        </label>
        <a class="mod__cluster-link" href="/${locale}/mod?material=${item.id}">
          <span class="mod__cluster-id">${t(locale, 'mod.item.title', { id: item.id })}</span>
          <span class="mod__cluster-text">${paragraphs(item.body)[0] ?? ''}</span>
        </a>
      </li>`)}
    </ol>

    <label class="field__label" for="mod-cluster-reason">${t(locale, 'mod.reason.label')}</label>
    <textarea class="field__input" id="mod-cluster-reason" name="reason" rows="2" required
      >${t(locale, 'mod.reason.placeholder')}</textarea>
    <p class="mod__actions">
      <button class="button button--primary" type="submit" name="decision" value="approve"
        >${t(locale, 'mod.decision.approve')}</button>
      <button class="button button--danger" type="submit" name="decision" value="reject"
        >${t(locale, 'mod.decision.reject')}</button>
    </p>
  </form>

  <p><a class="button button--quiet" href="/${locale}/mod">${t(locale, 'mod.cluster.back')}</a></p>
</div>`;
}

/**
 * Очередь модерации и разбор материала.
 *
 * @param {object} args
 * @param {string} args.locale
 * @param {object} args.queue материалы очереди (из `ordered`)
 * @param {object[]} args.clusters кластеры (из `groups`)
 * @param {object|null} args.material разбираемый материал
 * @param {string} args.csrf
 * @param {object} args.mode состояние системы (осторожный режим, давление)
 * @returns {object}
 */
export function moderationView({ locale, queue = [], clusters = [], material = null, csrf, mode = null }) {
  const clusterOf = new Map();
  for (const cluster of clusters) {
    for (const item of cluster.materials) clusterOf.set(item.id, cluster);
  }

  return html`
<div class="mod">
  <h1 class="mod__title">${t(locale, 'mod.title')}</h1>

  ${when(mode?.growing || mode?.cautious, () => html`
  <p class="mod__warning" role="status">
    ${when(mode.cautious, () => html`<span class="mod__warning-cautious">${t(locale, 'mod.mode.cautious')}</span>`)}
    ${t(locale, 'mod.mode.growing', { minutes: mode.oldestMinutes ?? 0 })}
  </p>`)}

  <div class="mod__layout">
    <ol class="mod__queue" role="list">
      ${when(!queue.length, () => html`<li class="mod__empty">${t(locale, 'mod.empty')}</li>`)}
      ${queue.map((item) => {
        const cluster = clusterOf.get(item.id);
        const isCurrent = material && material.id === item.id;
        return html`
      <li class="mod__item${isCurrent ? ' mod__item--current' : ''}">
        <a class="mod__item-link" href="/${locale}/mod?material=${item.id}">
          <span class="mod__item-title">${t(locale, 'mod.item.title', { id: item.id })}</span>
          ${when(item.complaints > 0, () => html`
          <span class="mod__item-complaints">${t(locale, 'mod.item.complaints', { count: item.complaints })}</span>`)}
          <span class="mod__item-waiting">${t(locale, 'mod.item.waiting', { minutes: item.waitingMinutes })}</span>
        </a>
        ${when(cluster, () => html`
        <a class="mod__item-cluster" href="/${locale}/mod/cluster?material=${item.id}">${t(locale, 'mod.item.cluster', { count: cluster.size })}</a>`)}
      </li>`;
      })}
    </ol>

    <section class="mod__material" aria-labelledby="h-mod-material">
      ${when(!material, () => html`
      <p class="mod__empty">${t(locale, 'mod.pick')}</p>`,
      () => html`
      <h2 class="mod__material-title" id="h-mod-material">${t(locale, 'mod.material.title', { id: material.id })}</h2>
      <p class="mod__author">
        ${t(locale, 'mod.material.author', { nickname: material.authorNickname })}
        ${when(material.history.length, () => html`
        <span class="mod__history">${t(locale, 'mod.material.history', { count: material.history.length })}</span>`)}
      </p>

      ${when(material.matches.length, () => html`
      <ul class="mod__matches" role="list">
        ${material.matches.map((match) => html`
        <li class="mod__match">
          <span class="mod__match-word">${match.word}</span>
          ${when(match.category, () => html`<span class="mod__match-category">${t(locale, `mod.match.category.${match.category}`)}</span>`)}
        </li>`)}
      </ul>`)}

      <div class="mod__body">${paragraphs(material.body).map((part) => html`<p>${part}</p>`)}</div>

      ${when(material.history.length, () => html`
      <ul class="mod__decisions" role="list">
        ${material.history.map((row) => html`
        <li class="mod__decision">
          <span class="mod__decision-kind">${t(locale, `mod.decision.${row.decision}`)}</span>
          <span class="mod__decision-reason">${row.reason}</span>
          <span class="mod__decision-date">${dayLabel(locale, row.decidedAt)}</span>
        </li>`)}
      </ul>`)}

      <form class="mod__restrict" method="post" action="/${locale}/mod/user/${material.authorId}">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="back" value="/${locale}/mod?material=${material.id}">
        <h3 class="mod__restrict-title">${t(locale, 'mod.mute.title')}</h3>
        <label class="field__label" for="mod-restrict-reason">${t(locale, 'mod.mute.reason')}</label>
        <input class="field__input" id="mod-restrict-reason" name="reason" type="text" required>
        <label class="field__label" for="mod-restrict-hours">${t(locale, 'mod.mute.hours')}</label>
        <input class="field__input" id="mod-restrict-hours" name="hours" type="number" min="1"
          value="${MODERATION.muteMinHours}">
        <label class="mod__whitelist">
          <input type="checkbox" name="hide_materials" value="1">
          <span>${t(locale, 'mod.ban.hide')}</span>
        </label>
        <p class="mod__actions">
          <button class="button button--quiet" type="submit" name="action" value="mute"
            >${t(locale, 'mod.mute.submit')}</button>
          <button class="button button--danger" type="submit" name="action" value="ban"
            >${t(locale, 'mod.ban.submit')}</button>
        </p>
      </form>

      <form class="mod__form" method="post" action="/${locale}/mod/${material.id}">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="back" value="/${locale}/mod?material=${material.id}">
        <label class="field__label" for="mod-reason">${t(locale, 'mod.reason.label')}</label>
        <textarea class="field__input" id="mod-reason" name="reason" rows="2" required
          >${t(locale, 'mod.reason.placeholder')}</textarea>
        <label class="mod__whitelist">
          <input type="checkbox" name="whitelist" value="1">
          <span>${t(locale, 'mod.whitelist.label')}</span>
        </label>
        <p class="mod__actions">
          <button class="button button--primary" type="submit" name="decision" value="approve"
            >${t(locale, 'mod.decision.approve')}</button>
          <button class="button button--danger" type="submit" name="decision" value="reject"
            >${t(locale, 'mod.decision.reject')}</button>
        </p>
      </form>`)}
    </section>
  </div>
</div>`;
}
