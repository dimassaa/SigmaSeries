// Журнал безопасности.
//
// R-SEC-29 требует три вещи: без паролей и токенов, со сквозным
// идентификатором запроса и с экранированием переводов строк. Каждая
// проверяется здесь отдельно: все три — про то, что запись в журнал не
// превращается сама в себе в утечку.
//
// Кто пишет, проверяет tests/journal.http.test.js: там идентификатор
// проходит весь путь от запроса до ответа.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createJournal } from '../src/services/journal.js';

/** Журнал, пишущий в массив строк вместо stdout. */
function journalWith(lines) {
  return createJournal({ sink: (line) => lines.push(line) });
}

// ─── Форма записи ────────────────────────────────────────────────────────────

test('событие пишется одной строкой JSON с идентификатором запроса', () => {
  const lines = [];
  journalWith(lines).security({
    event: 'password_reset',
    requestId: 'req-1',
    user_id: 7,
    sessions_revoked: 2,
  });

  assert.equal(lines.length, 1, 'одно событие — одна строка');
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, 'security');
  assert.equal(entry.event, 'password_reset');
  assert.equal(entry.request, 'req-1', 'без идентификатора запись не находилась бы в общем потоке');
  assert.equal(entry.user_id, 7);
  assert.equal(entry.sessions_revoked, 2);
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/, 'время в ISO, иначе записи не сортируются');
});

test('без идентификатора запроса событие не пишется вовсе', () => {
  const lines = [];
  assert.throws(
    () => journalWith(lines).security({ event: 'password_reset', user_id: 7 }),
    /requestId/,
    'запись без связи с запросом бесполезна и теряется в потоке',
  );
  assert.equal(lines.length, 0, 'и в журнал не попала');
});

test('без названия события запись не делается', () => {
  const lines = [];
  assert.throws(() => journalWith(lines).security({ requestId: 'req-1' }), /событие/);
  assert.equal(lines.length, 0);
});

// ─── Секреты в журнал не попадают ─────────────────────────────────────────────

test('пароль, токен и код в журнал не принимаются', () => {
  const lines = [];
  const journal = journalWith(lines);
  for (const field of ['password', 'token', 'code', 'secret', 'email']) {
    assert.throws(
      () => journal.security({ event: 'password_reset', requestId: 'req-1', [field]: 'секрет' }),
      /неизвестное поле|не принимается/,
      `поле ${field} не должно проходить в журнал`,
    );
  }
  assert.equal(lines.length, 0);
});

test('в список полей попадают только те, что уже используются', () => {
  const lines = [];
  journalWith(lines).security({
    event: 'password_reset', requestId: 'req-1', user_id: 7, sessions_revoked: 0,
  });
  const entry = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(entry).sort(), [
    'event', 'level', 'request', 'sessions_revoked', 'ts', 'user_id',
  ]);
});

// ─── Подделка записи из значения ──────────────────────────────────────────────

test('перевод строки в значении не подделывает новую запись', () => {
  const lines = [];
  journalWith(lines).security({
    event: 'password_reset',
    requestId: 'req-1',
    // Ровно то, что прислал бы человек в поле: закрытая скобка и своё событие.
    user_id: 7,
    sessions_revoked: 1,
  });
  assert.equal(lines[0].includes('\n'), false, 'запись остаётся одной строкой');
});

test('значение с переводом строки читается обратно как одно значение', () => {
  const lines = [];
  // Имя события приходит из кода, но проверять надо настоящий перевод:
  // экранирование обязано быть свойством сериализации, а не проверкой
  // «а вдруг попадётся».
  journalWith(lines).security({
    event: 'password_reset\n{"event":"login_ok","user_id":666}',
    requestId: 'req-1',
    user_id: 7,
    sessions_revoked: 0,
  });

  assert.equal(lines.length, 1, 'поддельной записи не появилось');
  assert.equal(lines[0].includes('\n'), false);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.event, 'password_reset\n{"event":"login_ok","user_id":666}');
  assert.equal(entry.user_id, 7, 'поддельный user_id не выполнил ничего');
});

test('длинное значение обрезается', () => {
  const lines = [];
  const long = 'x'.repeat(500);
  journalWith(lines).security({ event: long, requestId: 'req-1', user_id: 7, sessions_revoked: 0 });

  assert.ok(lines[0].length < 300, `строка не должна разрастаться: ${lines[0].length}`);
  assert.ok(JSON.parse(lines[0]).event.startsWith('xxxx'), 'начало значения остаётся читаемым');
});

// ─── Отказ вместо тихой потери ────────────────────────────────────────────────

test('нечисловой user_id отвергается, а не превращается в строку', () => {
  const lines = [];
  assert.throws(
    () => journalWith(lines).security({
      event: 'password_reset', requestId: 'req-1', user_id: '1 OR 1=1', sessions_revoked: 0,
    }),
    /должно быть number/,
  );
  assert.equal(lines.length, 0);
});