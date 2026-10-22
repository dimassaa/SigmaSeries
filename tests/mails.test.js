// Тексты служебных писем.
//
// F-01-12 §8(а): письма пишутся на языке пользователя (R-I18N-13). Тексты
// лежат в каталоге, а не в почтовом шлюзе: письмо кладётся в очередь и
// отправляется позже, другим процессом, и собирать его там, где отправляют,
// означало бы, что правка текста не попадёт в уже стоящие в очереди письма.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mailText, MAIL_KINDS } from '../src/i18n/mails.js';

const LINK = 'http://127.0.0.1:3000/ru/password/reset?token=abc123';
/** @type {Record<string, any>} */
const NEEDED_VARS = { link: LINK };

test('у каждого вида письма есть тема и тело в обоих языках', () => {
  for (const kind of MAIL_KINDS) {
    for (const locale of ['ru', 'en']) {
      const text = mailText(kind, locale, NEEDED_VARS);
      assert.ok(text.subject.length > 0, `${kind}/${locale}: тема пуста`);
      assert.ok(text.body.length > 0, `${kind}/${locale}: тело пусто`);
      assert.equal(
        text.subject.includes('{'), false,
        `${kind}/${locale}: в теме осталась неподставленная переменная`,
      );
      assert.equal(
        text.body.includes('{link}'), false,
        `${kind}/${locale}: в теле осталась неподставленная ссылка`,
      );
    }
  }
});

test('ссылка попадает в тело письма целиком', () => {
  // Обрезанная ссылка бесполезна: подтвердить адрес или сменить пароль
  // нечем, и человек решит, что письмо пришло пустым.
  const { body } = mailText('password_reset', 'ru', NEEDED_VARS);
  assert.ok(body.includes(LINK), 'ссылка обязана быть в теле целиком');
});

test('русский и английский тексты действительно разные', () => {
  for (const kind of MAIL_KINDS) {
    assert.notEqual(
      mailText(kind, 'ru', NEEDED_VARS).subject,
      mailText(kind, 'en', NEEDED_VARS).subject,
      `${kind}: темы совпадают, второй язык не переведён`,
    );
  }
});

test('неизвестный вид письма и неизвестный язык падают, а не молчат', () => {
  // Молчание здесь означало бы письмо без темы: человек не поймёт, что
  // произошло, а отправитель не узнает, что ошибка.
  assert.throws(() => mailText('нет-такого', 'ru', NEEDED_VARS), /вид письма|неизвестн/);
  assert.throws(() => mailText('password_reset', 'fr', NEEDED_VARS), /язык|неизвестн/);
});

test('в письмо не попадают пароль и его хеш', () => {
  // Слово «пароль» в тексте письма — обычное дело, особенно по-английски.
  // Проверяется то, чего в письме быть не должно: сам пароль и его хеш.
  const password = 'правильный-пароль-из-десяти';
  const hash = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$abcdefghijklmnopqrstuvwxyz012345';

  for (const kind of MAIL_KINDS) {
    for (const locale of ['ru', 'en']) {
      const { body, subject } = mailText(kind, locale, { ...NEEDED_VARS, password, hash });
      assert.equal(body.includes(password), false, `${kind}/${locale}: пароль в теле`);
      assert.equal(subject.includes(password), false, `${kind}/${locale}: пароль в теме`);
      assert.equal(body.includes(hash), false, `${kind}/${locale}: хеш пароля в теле`);
    }
  }
});

test('письмо о смене пароля не содержит ссылки', () => {
  // Уведомление о смене — не приглашение войти. Ссылка в таком письме была бы
  // приглашением, которым воспользуется тот, кто письмо перехватил.
  const { body } = mailText('password_changed', 'ru', {});
  assert.equal(body.includes('{link}'), false);
  assert.ok(body.length > 0);
});