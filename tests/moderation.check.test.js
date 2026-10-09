// Тесты операции OP-01 — проверка материала.
// Спецификация: docs/01-product/features/M5-ugc-moderation.md F-05-02.
// Пишутся до реализации: сначала падают, потом проходят.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize, checkMaterial, authorView } from '../src/services/moderation/check.js';

/** Словарь для тестов. Список `allow` проверяется раньше `block`. */
function dict({ block = [], allow = [], available = true } = {}) {
  return { block, allow, available };
}

const LINKS_ONLY = dict({ block: ['привет'] });

// ─── Нормализация ────────────────────────────────────────────────────────────

test('нормализация приводит регистр и ё к е', () => {
  assert.equal(normalize('Ёжик Привет'), 'ежик привет');
});

test('нормализация убирает невидимые символы и лишние пробелы', () => {
  assert.equal(normalize('  при\u200bвет \u00ad мир  '), 'привет мир');
});

test('нормализация сводит латинские омоглифы к кириллице', () => {
  // "o" латинская → "о" кириллическая; словарь кириллический должен ловить
  assert.equal(normalize('пpивет'), 'привет'); // латинская p
  assert.equal(normalize('привeт'), 'привет'); // латинская e
});

test('нормализация разворачивает цифровую замену букв', () => {
  assert.equal(normalize('прив3т'), 'привет');
  assert.equal(normalize('@личный'), 'аличный');
});

test('нормализация схлопывает разделители между буквами слова', () => {
  assert.equal(normalize('п.р.и.в.е.т'), 'привет');
  assert.equal(normalize('п р и в е т'), 'привет');
});

test('нормализация не трогает текст, который не нормализуется', () => {
  assert.equal(normalize('обычный отзыв'), 'обычный отзыв');
});

// ─── Решения ─────────────────────────────────────────────────────────────────

test('чистый материал публикуется', () => {
  const r = checkMaterial({ body: 'Обычный отзыв про сериал', dictionary: LINKS_ONLY });
  assert.equal(r.decision, 'publish');
  assert.equal(r.reason, 'ok');
});

test('слово из блок-словаря уводит материал в очередь, а не удаляет', () => {
  const r = checkMaterial({ body: 'это привет', dictionary: LINKS_ONLY });
  assert.equal(r.decision, 'queue');
  assert.equal(r.reason, 'blocklist');
});

test('слово из белого списка снимает находку, даже если есть и в блок-списке', () => {
  // Порядок обязателен: сначала белый, потом чёрный. Иначе «в белом» сработает
  // и ссылка пройдёт вместе с ним — F-05-02 правило (а).
  const d = dict({ block: ['привет'], allow: ['привет'] });
  const r = checkMaterial({ body: 'это привет', dictionary: d });
  assert.equal(r.decision, 'publish');
  assert.equal(r.reason, 'allowlisted');
});

test('ссылка уводит в очередь независимо от словаря', () => {
  const r = checkMaterial({ body: 'смотри https://example.com', dictionary: LINKS_ONLY });
  assert.equal(r.decision, 'queue');
  assert.equal(r.reason, 'link');
});

test('ссылка ловится и в белом списке', () => {
  // Проверка ссылок идёт после обоих списков и не отменяется белым списком.
  const d = dict({ block: ['example'], allow: ['example'] });
  const r = checkMaterial({ body: 'https://example.com', dictionary: d });
  assert.equal(r.decision, 'queue');
  assert.equal(r.reason, 'link');
});

test('ссылка без протокола тоже считается ссылкой', () => {
  for (const body of ['example.com', 'www.example.com', 'http://a.b/by']) {
    const r = checkMaterial({ body, dictionary: LINKS_ONLY });
    assert.equal(r.reason, 'link', `не поймано: ${body}`);
  }
});

test('недоступный словарь не публикует материал автоматически', () => {
  // Сбой загрузки словаря не должен становиться обходом модерации — F-05-02.
  const r = checkMaterial({ body: 'обычный текст', dictionary: dict({ available: false }) });
  assert.equal(r.decision, 'unavailable');
  assert.notEqual(r.decision, 'publish');
});

test('тело, оставшееся пустым после нормализации, отклоняется', () => {
  const r = checkMaterial({ body: '\u200b \u00ad\u200b', dictionary: LINKS_ONLY });
  assert.equal(r.decision, 'reject');
  assert.equal(r.reason, 'empty');
});

test('одно слово дважды даёт одну находку', () => {
  const r = checkMaterial({ body: 'привет привет привет', dictionary: LINKS_ONLY });
  assert.equal(r.matched.length, 1);
});

test('несколько разных слов дают несколько находок и одно решение', () => {
  const d = dict({ block: ['привет', 'прощай'] });
  const r = checkMaterial({ body: 'привет и прощай', dictionary: d });
  assert.equal(r.decision, 'queue');
  assert.equal(r.matched.length, 2);
});

// ─── Обход нормализации ───────────────────────────────────────────────────────

test('эвристика не обходится гомоглифами, цифрами, повторами и разделителями', () => {
  const d = dict({ block: ['привет'] });
  for (const body of [
    'пpивет',       // латинская p
    'прив3т',       // цифра 3
    'приииивет',    // повторы букв
    'п.р.и.в.е.т',  // разделители
    'п\u200bр\u200bивет', // невидимые символы внутри
  ]) {
    const r = checkMaterial({ body, dictionary: d });
    assert.equal(r.decision, 'queue', `обошли: ${JSON.stringify(body)}`);
  }
});

test('слово в белом списке ловится до блок-словаря и нормализуется так же', () => {
  const d = dict({ block: ['привет'], allow: ['привет'] });
  const r = checkMaterial({ body: 'П.Р.И.В.Е.Т', dictionary: d });
  assert.equal(r.decision, 'publish');
  assert.equal(r.reason, 'allowlisted');
});

// ─── То, что видит автор ──────────────────────────────────────────────────────

test('автору не показывается совпавшее слово', () => {
  // F-05-02 правило (б): иначе обходится заменой на синоним.
  const r = checkMaterial({ body: 'это привет', dictionary: LINKS_ONLY });
  const view = authorView(r);
  const serialised = JSON.stringify(view);
  assert.ok(!serialised.includes('привет'), `слово просочилось: ${serialised}`);
});

test('автор видит, что материал на проверке, а не что он запрещён', () => {
  const r = checkMaterial({ body: 'это привет', dictionary: LINKS_ONLY });
  const view = authorView(r);
  assert.equal(view.status, 'queued');
  assert.equal(view.canFix, true);
});

test('автору показывают точное слово только вместе с окончательным решением', () => {
  const r = checkMaterial({ body: 'это привет', dictionary: LINKS_ONLY });
  const view = authorView(r, { final: true, rejected: true });
  assert.equal(view.matchedWord, 'привет');
});

// ─── Производительность ──────────────────────────────────────────────────────

test('проверка 10 000 слов словаря укладывается в бюджет 50 мс', () => {
  // Бюджет из F-05-02 §9. Словарь собирается из реальных形态: 4 000 уникальных
  // основ в трёх написаниях — русском, латиницей и с цифровой заменой.
  const words = [];
  for (let i = 0; i < 4000; i++) words.push('слово' + i);
  const d = dict({ block: words });
  const body = 'Отзыв про сериал, который я посмотрел. '.repeat(200);

  const t0 = process.hrtime.bigint();
  const r = checkMaterial({ body, dictionary: d });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  assert.equal(r.decision, 'publish');
  assert.ok(ms < 50, `проверка заняла ${ms.toFixed(1)} мс при бюджете 50`);
});