// Проверка полей регистрации и решение о создании аккаунта.
// Спецификация: docs/01-product/features/M1-identity.md F-01-01, F-01-02.
// Требования: R-SEC-01, R-SEC-06, R-SEC-07, R-SEC-13, R-SEC-31, R-MOD-02…05.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkEmail,
  normalizeEmail,
  checkNickname,
  checkNickAgainstSecrets,
  checkRegistration,
  checkTimezone,
  NICK_MIN,
  NICK_MAX,
} from '../src/services/auth/validate.js';
import {
  decideRegistration,
  verifyToken,
  resendAllowed,
  makeVerificationToken,
} from '../src/services/auth/register.js';
import { hashToken, hashPassword } from '../src/services/auth/password.js';
import { AUTH } from '../src/config/settings.js';

const free = async () => true;
const deps = { nicknameFree: free, emailFree: free, hashPassword: async () => 'HASH' };

// ─── Email ────────────────────────────────────────────────────────────────────

test('адрес приводится к нормальной форме', () => {
  // Без приведения регистра «Ivan@» и «ivan@» стали бы разными учётками.
  assert.equal(normalizeEmail('  Ivan@Example.COM '), 'ivan@example.com');
  assert.equal(normalizeEmail('\uFF29\uFF3A\uFF41\uFF4E\uFF20\uFF45xample.com'), 'izan@example.com');
});

test('формат адреса проверяется, настоящая проверка — письмо', () => {
  assert.deepEqual(checkEmail('a@b.co'), []);
  assert.deepEqual(checkEmail(''), ['email_required']);
  assert.ok(checkEmail('без-знака').includes('email_invalid'));
  assert.ok(checkEmail('a@b').includes('email_invalid'), 'нужен домен второго уровня');
  assert.ok(checkEmail('a@@b.c').includes('email_invalid'));
});

// ─── Ник ─────────────────────────────────────────────────────────────────────

test('длина ника из спецификации', async () => {
  assert.ok((await checkNickname('ab')).includes('nick_too_short'));
  assert.deepEqual(await checkNickname('a'.repeat(NICK_MAX)), []);
  assert.ok((await checkNickname('a'.repeat(NICK_MAX + 1))).includes('nick_too_long'));
});

test('допустимые символы — буквы, цифры, _ и -', async () => {
  assert.deepEqual(await checkNickname('anna_2026'), []);
  assert.deepEqual(await checkNickname('Анна-Мария'), []);
  assert.ok((await checkNickname('анна кошка')).includes('nick_charset'));
  assert.ok((await checkNickname('anna!')).includes('nick_charset'));
});

test('ник не начинается и не кончается разделителем', async () => {
  assert.ok((await checkNickname('_anna')).includes('nick_edges'));
  assert.ok((await checkNickname('anna_')).includes('nick_edges'));
  assert.ok((await checkNickname('-anna')).includes('nick_edges'));
});

test('зарезервированные ники не занимаются', async () => {
  for (const n of ['admin', 'Admin', 'ROOT', 'support', 'sigmaseries']) {
    assert.ok((await checkNickname(n)).includes('nick_reserved'), `занят: ${n}`);
  }
});

test('ник проверяется словарём модерации, а не своим кодом', async () => {
  // Словарь приходит снаружи, и проверяется тем же конвейером, что и
  // материалы: своя проверка обходилась бы теми же приёмами (F-01-01 (а)).
  const blocked = { block: ['плохойник'], allow: [], available: true };
  assert.ok((await checkNickname('плохойник', { dictionary: blocked })).includes('nick_blocked'));

  // Обход через латиницу не помогает: нормализация внутри конвейера.
  assert.ok((await checkNickname('плoxойник', { dictionary: blocked })).includes('nick_blocked'));

  // Белый список снимает находку, как и для материалов.
  const allowed = { block: ['плохойник'], allow: ['плохойник'], available: true };
  assert.deepEqual(await checkNickname('плохойник', { dictionary: allowed }), []);
});

test('занятый ник отклоняется по данным хранилища', async () => {
  const problems = await checkNickname('anna', { available: async () => false });
  assert.ok(problems.includes('nick_taken'));
});

test('занятость не спрашивается, если ник уже невалиден', async () => {
  // Иначе форма стучится в базу на каждый ввод символа — это и лимит
  // «10 проверок в минуту» F-01-01 §9, и просто лишняя нагрузка.
  let asked = 0;
  await checkNickname('ab', { available: async () => { asked++; return true; } });
  assert.equal(asked, 0);
});

// ─── Ник против адреса и пароля ──────────────────────────────────────────────

test('ник не может совпадать с адресом или паролем', () => {
  assert.ok(checkNickAgainstSecrets('ivan@example.com', { email: 'Ivan@example.com', password: 'x' })
    .includes('nick_is_email'), 'сравнение должно быть без учёта регистра');
  assert.deepEqual(checkNickAgainstSecrets('ivan', { email: 'Ivan@example.com', password: 'x' }), []);
  assert.ok(checkNickAgainstSecrets('Пароль', { email: 'a@b.c', password: 'пароль' })
    .includes('nick_is_password'));
  assert.deepEqual(checkNickAgainstSecrets('anna', { email: 'a@b.c', password: 'x' }), []);
});

// ─── Часовой пояс ────────────────────────────────────────────────────────────

test('часовой пояс проверяется по списку IANA', () => {
  assert.deepEqual(checkTimezone('Europe/Minsk'), []);
  assert.deepEqual(checkTimezone('UTC'), []);
  assert.deepEqual(checkTimezone('Марсианская/Колония'), ['timezone_invalid']);
  assert.deepEqual(checkTimezone(''), ['timezone_invalid']);
});

// ─── Решение о регистрации ────────────────────────────────────────────────────

test('корректные данные дают готовые к записи поля', async () => {
  const r = await decideRegistration({
    email: '  Ivan@Example.com', nickname: 'ivan', password: 'надежный-пароль-1',
    consent: true, timezone: 'Europe/Minsk', locale: 'ru',
  }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.fields.email, 'ivan@example.com');
  assert.equal(r.fields.confirmed, false, 'аккаунт сразу не активен');
  assert.ok(r.fields.tokenHash, 'токен подтверждения создаётся');
});

test('без согласия аккаунт не создаётся', async () => {
  const r = await decideRegistration({
    email: 'a@b.c', nickname: 'anna', password: 'надежный-пароль-1', consent: false,
  }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'consent_required');
});

test('занятый email даёт тот же ответ, что и свободный', async () => {
  // R-SEC-06. Отличается письмо, а не страница: по ответу иначе перебираются
  // занятые адреса.
  const base = { nickname: 'anna', password: 'надежный-пароль-1', consent: true };
  const freeReg = await decideRegistration({ ...base, email: 'a@b.c' }, deps);
  const takenReg = await decideRegistration({ ...base, email: 'taken@b.c' }, {
    ...deps, emailFree: async () => false,
  });
  assert.equal(freeReg.ok, true);
  assert.equal(takenReg.ok, true);
  assert.equal(freeReg.code, undefined);
  assert.equal(takenReg.code, undefined);
});

test('письмо шлётся даже при занятом адресе', async () => {
  // Иначе по наличию письма определяется, занят адрес или нет.
  const takenReg = await decideRegistration(
    { email: 'taken@b.c', nickname: 'anna', password: 'надежный-пароль-1', consent: true },
    { ...deps, emailFree: async () => false },
  );
  assert.equal(takenReg.emailTaken, true, 'признак есть, но наружу не отдаётся');
});

test('ник, занявшийся между проверками, отклоняется', async () => {
  // Гонка EC-A5: форма прошла проверку, место кончилось до записи.
  let calls = 0;
  const r = await decideRegistration({
    email: 'a@b.c', nickname: 'anna', password: 'надежный-пароль-1', consent: true,
  }, { ...deps, nicknameFree: async () => { calls++; return calls === 1; } });
  assert.equal(r.ok, false);
  assert.ok(r.problems.nickname.includes('nick_taken'));
});

test('слабый пароль останавливает регистрацию', async () => {
  const r = await decideRegistration({
    email: 'a@b.c', nickname: 'anna', password: 'password123', consent: true,
  }, deps);
  assert.equal(r.ok, false);
  assert.ok(r.problems.password.includes('password_common'));
});

test('плохой часовой пояс останавливает регистрацию', async () => {
  const r = await decideRegistration({
    email: 'a@b.c', nickname: 'anna', password: 'надежный-пароль-1',
    consent: true, timezone: 'не-попасть',
  }, deps);
  assert.equal(r.ok, false);
  assert.ok(r.problems.timezone.includes('timezone_invalid'));
});

test('замечания по разным полям собираются за один раз', async () => {
  // Иначе человек чинит по одному полю за подход: три круга вместо одного.
  const r = await decideRegistration({
    email: 'плохо', nickname: 'ab', password: 'password123', consent: true,
    timezone: 'не-попасть',
  }, deps);
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.problems).sort(),
    ['email', 'nickname', 'password', 'timezone']);
});

test('без согласия показывается вместе с замечаниями по полям', async () => {
  const r = await decideRegistration({
    email: 'плохо', nickname: 'anna', password: 'надежный-пароль-1', consent: false,
  }, deps);
  assert.equal(r.code, 'consent_required', 'отказ важнее прочих замечаний');
  assert.ok(r.problems.email, 'но и адрес показывается: чинить всё сразу');
  assert.ok(r.problems.consent.includes('consent_required'));
});

test('полная проверка собирает замечания по всем полям', async () => {
  const r = await checkRegistration({ email: 'плохо', nickname: 'ab', password: 'x' });
  assert.deepEqual(Object.keys(r.problems).sort(), ['email', 'nickname']);
  assert.equal(r.ok, false);
});

// ─── Токены подтверждения (R-SEC-07, EC-A4) ─────────────────────────────────

test('токен одноразовый и в базу идёт только хеш', async () => {
  const { token, hash } = makeVerificationToken();
  assert.ok(token.length >= 40);
  assert.equal(hashToken(token).equals(hash), true);
  assert.ok(!hash.toString('utf8').includes(token));
});

test('действующий токен принимается', async () => {
  const { token, hash } = makeVerificationToken();
  const row = { token_hash: hash, expires_at: new Date(Date.now() + 60_000), used_at: null };
  assert.deepEqual(verifyToken(row, token), { ok: true, reason: 'ok' });
});

test('использованный токен отличает от неверного', async () => {
  const { token, hash } = makeVerificationToken();
  const used = { token_hash: hash, expires_at: new Date(Date.now() + 60_000), used_at: new Date() };
  const r = verifyToken(used, token);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'used');
  assert.equal(r.alreadyConfirmed, true, 'нужно предложить войти, а не подтверждать заново');
});

test('просроченный токен отклоняется', async () => {
  const { token, hash } = makeVerificationToken();
  const row = { token_hash: hash, expires_at: new Date(Date.now() - 1000), used_at: null };
  assert.equal(verifyToken(row, token).reason, 'expired');
});

test('чужой токен отклоняется', async () => {
  const { hash } = makeVerificationToken();
  const row = { token_hash: hash, expires_at: new Date(Date.now() + 60_000), used_at: null };
  assert.equal(verifyToken(row, 'чужой-токен').reason, 'unknown');
  assert.equal(verifyToken(null, 'любой').reason, 'unknown');
});

// ─── Повторные письма ────────────────────────────────────────────────────────

test('повторное письмо уважает паузу', () => {
  const now = Date.now();
  assert.deepEqual(resendAllowed(null, now), { ok: true, retryAfter: 0 });
  const recent = resendAllowed(now - 1000, now);
  assert.equal(recent.ok, false);
  assert.ok(recent.retryAfter > 0 && recent.retryAfter <= AUTH.resendCooldownS);
  assert.deepEqual(resendAllowed(now - (AUTH.resendCooldownS + 1) * 1000, now),
    { ok: true, retryAfter: 0 });
});