// Журнал аудита. Тесты.
// Спецификация: docs/01-product/features/M9-admin.md F-09-03.
// Требования: R-SEC-29, R-SEC-33.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEntry, sanitize, diff, REDACTED } from '../src/services/audit/log.js';

// ─── Секреты ──────────────────────────────────────────────────────────────────

test('пароль не попадает в метаданные', () => {
  const e = buildEntry({
    actorId: 1, action: 'user.update', objectType: 'user', objectId: 7,
    reason: 'смена email',
    before: { email: 'a@b.c', passwordHash: 'argon2:...' },
    after: { email: 'd@e.f', passwordHash: 'argon2:...' },
  });
  assert.equal(e.before_data.passwordHash, REDACTED);
  assert.equal(e.before_data.email, 'a@b.c', 'остальное сохраняется: разбор инцидента нужен');
});

test('секрет находится на любой глубине', () => {
  // Проверка только верхнего уровня пропустила бы secret внутри user.
  const s = sanitize({ user: { profile: { apiToken: 'abc', nickname: 'anna' } } });
  assert.equal(s.user.profile.apiToken, REDACTED);
  assert.equal(s.user.profile.nickname, 'anna');
});

test('название поля сверяется без учёта регистра и подчёркиваний', () => {
  const s = sanitize({ Password_Hash: 1, passwordhash: 2, SALT: 3, cookie: 4, privateKey: 5 });
  for (const v of Object.values(s)) assert.equal(v, REDACTED);
});

test('обычное поле под подозрительным словом не маскируется зря', () => {
  // «hashrate» не секрет; маскировать всё подряд — значит потерять данные.
  const s = sanitize({ title: 'Хеширование', keywords: ['hash'], description: 'ключевая сцена' });
  assert.equal(s.title, 'Хеширование');
  assert.deepEqual(s.keywords, ['hash']);
  assert.equal(s.description, 'ключевая сцена');
});

test('массивы и вложенные объекты чистятся целиком', () => {
  const s = sanitize([{ token: 'x' }, { ok: 1 }]);
  assert.equal(s[0].token, REDACTED);
  assert.equal(s[1].ok, 1);
});

// ─── Обязательные поля ────────────────────────────────────────────────────────

test('запись без причины не создаётся', () => {
  // F-09-03 правило (в): причина хранится в записи, иначе теряется при выгрузке.
  assert.throws(() => buildEntry({ actorId: 1, action: 'ban', objectType: 'user', reason: '  ' }),
    /Причина обязательна/);
});

test('запись без действия или типа объекта не создаётся', () => {
  assert.throws(() => buildEntry({ actorId: 1, objectType: 'user', reason: 'х' }), /Действие/);
  assert.throws(() => buildEntry({ actorId: 1, action: 'x', reason: 'х' }), /объекта/);
});

test('причина обрезается от пробелов и сохраняется', () => {
  const e = buildEntry({ actorId: 1, action: 'ban', objectType: 'user', reason: '  флуд  ' });
  assert.equal(e.reason, 'флуд');
});

// ─── Результат действия ───────────────────────────────────────────────────────

test('отказ записывается так же, как успех, но со своим результатом', () => {
  // На экране журнала отказ должен быть виден: он объясняет, почему
  // действие не состоялось (F-09-03).
  const ok = buildEntry({ actorId: 1, action: 'ban', objectType: 'user', reason: 'флуд' });
  const denied = buildEntry({ actorId: 1, action: 'delete', objectType: 'user', result: 'denied', reason: 'последний админ' });
  assert.equal(ok.result, 'ok');
  assert.equal(denied.result, 'denied');
  assert.equal(denied.reason, 'последний админ');
});

test('запись может остаться без актёра — система действует и без человека', () => {
  const e = buildEntry({ actorId: null, action: 'backup.run', objectType: 'job', reason: 'план' });
  assert.equal(e.actor_id, null);
});

// ─── Различие ─────────────────────────────────────────────────────────────────

test('в журнал попадает только изменившееся', () => {
  const d = diff(
    { email: 'a@b.c', nickname: 'anna', status: 'active' },
    { email: 'a@b.c', nickname: 'anna', status: 'banned' },
  );
  assert.deepEqual(Object.keys(d.before), ['status']);
  assert.equal(d.after.status, 'banned');
});

test('различие без изменений даёт пусто', () => {
  assert.equal(diff({ a: 1 }, { a: 1 }), null);
});

test('различие не тащит в журнал чужие поля', () => {
  // Если бы diff писал снимки, в журнал уехали бы все персональные данные
  // объекта, а журнал читают и выгружают.
  const d = diff({ nick: 'anna', secretHash: 'h', status: 'active' },
                 { nick: 'anna', secretHash: 'h', status: 'banned' });
  assert.deepEqual(Object.keys(d.before), ['status']);
  assert.equal(JSON.stringify(d).includes('h'), false);
});

test('пустые состояния не создают полей', () => {
  const e = buildEntry({ actorId: 1, action: 'ban', objectType: 'user', reason: 'флуд', before: {}, after: null });
  assert.equal('before_data' in e, false);
  assert.equal('after_data' in e, false);
});