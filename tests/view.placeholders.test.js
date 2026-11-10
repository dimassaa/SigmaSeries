// Подстановки в текстах экранов: сырой `{...}` не должен доходить до человека.
//
// `t()` оставляет незнакомую подстановку как есть — это нужно шаблону прогресса
// итогов, который читает клиентский скрипт. Обратная сторона: забытый параметр
// не падает, а печатается в интерфейсе. Найдено в браузерной QA (№253); тот же
// класс дефекта обнаружился ещё в двух местах, поэтому проверка общая: три
// экрана, которые уже один раз это пропустили.

import test from 'node:test';
import assert from 'node:assert/strict';

import { settingsView } from '../src/view/settings.js';
import { adminUserView } from '../src/view/adminUsers.js';
import { notificationText } from '../src/view/notification.js';
import { AUTH } from '../src/config/settings.js';
import { t } from '../src/i18n/strings.js';

/** Сырая подстановка вида `{min}` в готовой разметке. */
const RAW_PLACEHOLDER = /\{[a-z][a-z0-9]*\}/i;

/**
 * Раздел безопасности: подсказка пароля обязана называть число из настроек.
 *
 * @param {string} locale
 * @returns {string}
 */
function securityPage(locale) {
  return settingsView({
    locale,
    csrf: 'токен',
    error: null,
    section: 'security',
    sections: { security: 'settings.security.title' },
    user: { id: 1, email: 'reader@example.com', nickname: 'reader' },
    staff: false,
  }).__raw;
}

test('подсказка пароля называет предел из настроек, а не шаблон {min}', () => {
  for (const locale of ['ru', 'en']) {
    const page = securityPage(locale);
    assert.ok(!page.includes('{min}'), `${locale}: сырой шаблон не доходит до человека`);
    assert.ok(page.includes(String(AUTH.passwordMin)),
      `${locale}: подсказка называет ${AUTH.passwordMin} символов`);
  }
});

test('на разделе безопасности один акцент — смена пароля (R-DES-06)', () => {
  for (const locale of ['ru', 'en']) {
    const page = securityPage(locale);
    const primaries = page.match(/button--primary/g) ?? [];
    assert.equal(primaries.length, 1, `${locale}: на экране ровно одна главная кнопка`);
    assert.ok(
      page.includes(`<button class="button button--primary form__submit" type="submit">${t(locale, 'settings.security.change')}</button>`),
      `${locale}: главная — смена пароля, а не смена адреса`,
    );
  }
});

test('карточка админа не печатает шаблон в подписи строки', () => {
  const user = {
    id: 7,
    nickname: 'reader',
    address: 'r****r@example.com',
    registeredAt: new Date('2026-01-15T10:00:00Z'),
    status: 'active',
    roles: [],
    ratings: 2,
    materials: 3,
    restrictions: [],
    materialList: [],
    decisions: [],
  };
  for (const locale of ['ru', 'en']) {
    const page = adminUserView({ locale, user }).__raw;
    assert.ok(!RAW_PLACEHOLDER.test(page), `${locale}: в карточке нет сырых подстановок`);
    assert.ok(page.includes('2') && page.includes('3'),
      `${locale}: числа оценок и материалов показаны`);
  }
});

test('заголовок «Итоги года» называет год, а не {year}', () => {
  const ru = notificationText('ru', { kind: 'recap_ready', params: { year: 2026 } });
  const en = notificationText('en', { kind: 'recap_ready', params: { year: 2026 } });
  assert.ok(!RAW_PLACEHOLDER.test(ru.title), 'ru: год подставлен');
  assert.ok(!RAW_PLACEHOLDER.test(en.title), 'en: год подставлен');
  assert.match(ru.title, /2026/);
  assert.match(en.title, /2026/);
});
