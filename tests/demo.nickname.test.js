// Ник демо-аккаунта (F-01-12, S-84).
//
// Ник создаётся генератором демо-базы, а не человеком через форму, поэтому
// правило регистрации к нему не применяется автоматически. Пробел в нике
// проходил в базу и обрывал публичный профиль: маршрут `/u/{nick}` отвергает
// такой ник до поиска (№255). Проверка держит инвариант: сгенерированный ник
// обязан проходить те же правила, что и введённый руками.

import test from 'node:test';
import assert from 'node:assert/strict';

import { demoNickname } from '../src/cli/demo-nickname.js';
import { checkNickname, NICK_ALLOWED, NICK_SEPARATOR } from '../src/services/auth/validate.js';

test('ник демо-аккаунта проходит правило регистрации', async () => {
  for (const base of ['зритель', 'администратор']) {
    const nick = demoNickname(base, '9db140ec');
    assert.equal(nick, `${base}-9db140ec`, 'суффикс отделён дефисом');
    assert.ok(NICK_ALLOWED.test(nick), 'только буквы, цифры, дефис и подчёркивание');
    assert.ok(!NICK_SEPARATOR.test(nick), 'дефис не на краю');
    assert.deepEqual(await checkNickname(nick), [], 'ник свободен от замечаний валидатора');
  }
});
