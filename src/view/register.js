// Регистрация: шаг «Данные», шаг «Проверьте почту», подтверждение.
//
// Спецификация: SCREENS S-20, S-21; F-01-01 §4 (шаги с прогрессом),
// R-DES-34, R-A11Y-11 (ошибка названа текстом, связана с полем и объявляется),
// R-DES-30 (подсказка о формате видна до ошибки, а не вместо неё).

import { html, raw, when } from './render.js';
import { t } from '../i18n/strings.js';
import { revealButton } from './field.js';
import * as TASTE from '../services/recommendations/taste.js';
import { AUTH } from '../config/settings.js';

/** Поля шага 1: подпись, код подсказки, коды замечаний. */
const FIELDS = [
  { name: 'email', label: 'register.email', type: 'email', autocomplete: 'email' },
  { name: 'nickname', label: 'register.nickname', type: 'text', autocomplete: 'nickname', hint: 'register.nickname.hint' },
  { name: 'password', label: 'register.password', type: 'password', autocomplete: 'new-password', hint: 'register.password.hint' },
];

/**
 * @param {object} ctx
 * @param {string} ctx.locale
 * @param {number} ctx.step 1 | 2
 * @param {number} ctx.steps всегда 3
 * @param {string} ctx.csrf
 * @param {string|null} [ctx.challenge] задача невидимой проверки
 * @param {number} [ctx.zeros] сколько нулей требует проверка
 * @param {any} [ctx.values] значения полей, чтобы не вводить заново
 * @param {Record<string,string[]>} [ctx.problems] коды замечаний по полям
 * @param {string|null} [ctx.error] общий текст ошибки формы
 * @param {any} [ctx.pending] адрес и ник на шаге 2
 * @param {boolean} [ctx.sent] письмо отправлено повторно
 * @param {string} [ctx.statusUrl] куда опрашивать подтверждение
 * @param {string} [ctx.nextUrl] куда переходить после подтверждения
 * @param {string} [ctx.demoLink] ссылка на демо-подтверждение без почты
 */
export function registerView(ctx) {
  const { locale, step, steps, csrf } = ctx;

  return html`
${steps_(locale, step, steps)}

<div class="form__status" role="alert" aria-live="assertive">
  ${when(ctx.error, () => html`<p class="form__error">${ctx.error}</p>`)}
</div>

${step === 1 ? stepOne(ctx) : ''}
${step === 2 ? stepTwo(ctx) : ''}`;
}

/**
 * S-21 — подтверждение адреса.
 *
 * Отдельная карточка, а не шаг с прогрессом: экран открывается по ссылке из
 * письма, и «шаг 3 из 3» читался бы как продолжение формы, которой рядом нет
 * (F-01-02 §19). Заголовок меняется по состоянию, потому что состояние и
 * есть главное, что человеку нужно узнать.
 */
export function verifyView(ctx) {
  const { locale, csrf, state, token } = ctx;
  const headings = {
    await: 'verify.title',
    stale: 'verify.stale.title',
    already: 'verify.already.title',
    error: 'error.generic.title',
  };

  return html`
<h1 class="form__title">${t(locale, headings[state] ?? 'verify.title')}</h1>

${state === 'await' ? html`
<p class="form__text">${t(locale, 'verify.text')}</p>
<form class="form" method="post" action="/${locale}/verify">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="token" value="${token ?? ''}">
  <button class="button form__submit" type="submit">${t(locale, 'verify.submit')}</button>
</form>` : ''}

${state === 'stale' ? html`
<p class="form__text">${t(locale, 'verify.stale.text')}</p>
<p class="form__links"><a href="/${locale}/register">${t(locale, 'verify.stale.back')}</a></p>` : ''}

${state === 'already' ? html`
<p class="form__text">${t(locale, 'verify.already.text')}</p>
<p class="form__links"><a href="/${locale}/login">${t(locale, 'verify.already.login')}</a></p>` : ''}

${state === 'error' ? html`<p class="form__error">${t(locale, 'error.generic.text')}</p>` : ''}`;
}

// ─── Шаги ────────────────────────────────────────────────────────────────────

/**
 * S-20 — шаг 3: «Выберите любимые» (F-01-01 §4).
 *
 * Сетка карточек с выбором и поиском. «Готово» без скрипта работает только с
 * тремя–пятью: при меньшем числе сервер всё равно откажет, и человек увидел бы
 * отказ там, где можно было просто не дать нажать.
 *
 * Выбранное отмечается рамкой и подписью, а не только цветом (R-A11Y-19), а
 * счётчик «выбрано N из 3–5» называет границы словами.
 *
 * @param {object} ctx
 * @param {string} ctx.locale
 * @param {string} ctx.csrf
 * @param {any[]} ctx.items сериалы для сетки
 * @param {string} ctx.query что ищет человек
 * @param {number[]} ctx.chosen уже сохранённый выбор
 * @param {string|null} ctx.reason причина последнего отказа
 */
export function tasteStepView(ctx) {
  const { locale, csrf, items = [], query = '', chosen = [], reason = null } = ctx;
  const picked = new Set(chosen.map(Number));

  return html`
${steps_(locale, 3, 3)}

<div class="form__status" role="alert" aria-live="assertive">
  ${when(reason, () => html`<p class="form__error">${t(locale, `register.step3.error.${reason}`)}</p>`)}
</div>

<p class="form__text">${t(locale, 'register.step3.lead', {
    min: TASTE.MIN_CHOICE, max: TASTE.MAX_CHOICE,
  })}</p>

<form class="form" method="get" action="/${locale}/register/taste" role="search">
  <label class="visually-hidden" for="taste-q">${t(locale, 'register.step3.search')}</label>
  <input class="field__input" id="taste-q" type="search" name="q" value="${query}"
         placeholder="${t(locale, 'register.step3.search')}">
</form>

<form class="form taste" method="post" action="/${locale}/register/taste">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="action" value="save">

  <ul class="taste__grid" role="list">
    ${items.map((item) => html`
    <li class="posters__item">
      <label class="taste__pick${picked.has(Number(item.id)) ? ' taste__pick--on' : ''}">
        <input class="taste__input" type="checkbox" name="series" value="${item.id}"
               ${picked.has(Number(item.id)) ? raw('checked') : raw('')}>
        <span class="poster__frame">
          ${when(item.posterWidth, () => html`<img class="poster__img"
             src="/${locale}/images/${item.slug}/poster-${item.posterWidth}.webp"
             alt="" width="185" height="278" loading="lazy" decoding="async">`)}
          ${when(!item.posterWidth, () => html`<span class="poster__fallback" aria-hidden="true"></span>`)}
        </span>
        <span class="poster__title">${item.title}</span>
        ${when(item.genreRu, () => html`<span class="poster__meta"
          >${locale === 'en' ? (item.genreEn ?? item.genreRu) : item.genreRu}</span>`)}
        ${when(picked.has(Number(item.id)), () => html`
        <span class="visually-hidden">${t(locale, 'register.step3.picked')}</span>`)}
      </label>
    </li>`)}
  </ul>

  ${when(!items.length, () => html`
  <p class="form__note">${t(locale, 'register.step3.empty')}</p>`)}

  <p class="taste__count">${t(locale, 'register.step3.count', {
    min: TASTE.MIN_CHOICE, max: TASTE.MAX_CHOICE,
  })}</p>

  <button class="button button--primary" type="submit">${t(locale, 'register.step3.done')}</button>
  <button class="button button--quiet" type="submit" name="action" value="skip"
    >${t(locale, 'register.step3.skip')}</button>
</form>`;
}

function steps_(locale, step, steps) {
  return html`
<h1 class="form__title">${t(locale, step === 2 ? 'register.step2.title' : step === 3 ? 'register.step3.title' : 'register.title')}</h1>

<ol class="steps" aria-label="${t(locale, 'register.progress')}">
  ${[1, 2, 3].map((n) => html`<li class="steps__item${n === step ? ' steps__item--current' : ''}"
      ${n === step ? raw('aria-current="step"') : ''}>
    <span class="visually-hidden">${t(locale, 'register.stepLabel', { n })}</span>
    <span aria-hidden="true">${n}</span>
  </li>`)}
</ol>
<p class="steps__label">${t(locale, 'register.stepOf', { n: step, total: steps })}</p>`;
}

// ─── Шаг 1 ───────────────────────────────────────────────────────────────────

function stepOne(ctx) {
  const { locale, csrf, values = {}, problems = {}, challenge, zeros } = ctx;

  return html`
<form class="form" method="post" action="/${locale}/register" novalidate>
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="timezone" value="${values.timezone ?? 'UTC'}">
  ${when(challenge, () => html`<input type="hidden" name="pow" id="pow"
      data-challenge="${challenge}" data-zeros="${zeros ?? 3}">`)}

  ${FIELDS.map((f) => field(locale, f, values[f.name] ?? '', problems[f.name] ?? []))}

  <p class="field__status" id="nickname-status" role="status" aria-live="polite"
     data-free-text="${t(locale, 'register.error.nick_free')}"></p>

  <div class="field field--check">
    <input id="consent" name="consent" type="checkbox" required
           ${raw(problems.consent ? 'aria-invalid="true"' : '')}>
    <label for="consent">${t(locale, 'register.consent')}</label>
  </div>

  <button class="button form__submit" type="submit">${t(locale, 'register.submit')}</button>
</form>

<p class="form__links">
  ${t(locale, 'register.haveAccount')} <a href="/${locale}/login">${t(locale, 'register.signIn')}</a>
</p>

${when(challenge, () => html`<p class="form__pow" aria-hidden="true">${t(locale, 'signin.pow')}</p>`)}`;
}

function field(locale, f, value, problems) {
  const hintId = `${f.name}-hint`;
  const bad = problems.length > 0;
  // Числа подставляются в текст подсказки и замечания из настроек модуля:
  // при правке спецификации меняются числа, а не надписи вручную.
  const params = { min: AUTH.passwordMin, max: AUTH.passwordMax };

  const input = html`<input class="field__input" id="${f.name}" name="${f.name}" type="${f.type}"
           autocomplete="${f.autocomplete}" value="${value}"
           ${raw(f.hint ? `aria-describedby="${hintId}"` : '')}
           ${raw(bad ? `aria-invalid="true" aria-describedby="${f.name}-error"${f.hint ? ` ${hintId}` : ''}` : '')}
           required>`;

  return html`
  <div class="field${bad ? ' field--invalid' : ''}">
    <label class="field__label" for="${f.name}">${t(locale, f.label)}</label>
    ${f.type === 'password'
      ? html`<div class="field__row">${input}${revealButton({ locale, id: f.name })}</div>`
      : raw(input)}
    ${when(f.hint, () => html`<p class="field__hint" id="${hintId}">${t(locale, f.hint, params)}</p>`)}
    ${bad ? html`<p class="field__error" id="${f.name}-error">${t(locale, `register.error.${problems[0]}`, params)}</p>` : ''}
  </div>`;
}

// ─── Шаг 2 ───────────────────────────────────────────────────────────────────

function stepTwo(ctx) {
  const { locale, csrf, pending = {}, sent, statusUrl, nextUrl, demoLink = '' } = ctx;

  return html`
<section class="block block--message">
  <p class="message__lead">${t(locale, 'register.step2.lead', { email: pending.email ?? '' })}</p>
  ${when(sent, () => html`<p class="form__note" role="status">${t(locale, 'register.step2.sent')}</p>`)}
  <p class="message__text">${t(locale, 'register.step2.spam')}</p>
  <p class="message__text" role="status" id="verify-poll" aria-live="polite"></p>
</section>

<!--
  Демо-помощник (F-01-12 §4, H-51): в режиме devbox письмо никуда не ушло, и
  без этой подсказки показать подтверждение на офлайн-защите нечем. Ссылка
  ведёт на письмо, созданное этим же браузером.
-->
${when(demoLink, () => html`
<div class="block block--message">
  <p class="form__warning">${t(locale, 'register.demo.open')}</p>
  <p class="form__links"><a href="${demoLink}">${demoLink}</a></p>
</div>`)}

<form class="form" method="post" action="/${locale}/register/resend">
  <input type="hidden" name="csrf" value="${csrf}">
  <button class="button form__submit" type="submit">${t(locale, 'register.step2.resend')}</button>
</form>

<p class="form__links"><a href="/${locale}/register">${t(locale, 'register.step2.change')}</a></p>

${when(statusUrl, () => html`<script src="/app.js" data-poll-status="${statusUrl}" data-poll-next="${nextUrl ?? ''}" defer></script>`)}`;
}
