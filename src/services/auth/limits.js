// Лимиты входа и невидимая проверка.
//
// R-SEC-05: блокировка аккаунта за перебор запрещена — это готовый вектор
// отказа в обслуживании. Вместо неё нарастающая задержка и лимит по IP.
// R-SEC-34: после трёх неудач включается proof-of-work вместо картиночной
// CAPTCHA, недоступной для незрячих и для тех, кто не различает цвета.
//
// Счётчики живут в памяти процесса. Это осознанное ограничение: при
// нескольких процессах или перезапуске счётчик сбрасывается и человек
// получает ещё несколько попыток. Лимит — защита от случайного перебора,
// а не от распределённой атаки; для второй нужен общий счётчик в БД.

import crypto from 'node:crypto';
import { AUTH, MINUTE, HOUR } from '../../config/settings.js';

/** @type {Map<string, number[]>} ключ → временные метки неудачных попыток */
const failures = new Map();

/** @type {Map<string, {challenge:string, issuedAt:number}>} */
const challenges = new Map();

function prune(key, now) {
  const times = (failures.get(key) ?? []).filter((t) => now - t < AUTH.attemptsWindowMs);
  if (times.length) failures.set(key, times);
  else failures.delete(key);
  return times;
}

/** Ключ аккаунта: не по самому email, а по его хешу (R-AN-04, без PII). */
export function accountKey(email) {
  return 'a:' + crypto.createHash('sha256').update(String(email).toLowerCase(), 'utf8').digest('base64url');
}

/**
 * Задержка после неудачных попыток по аккаунту (R-SEC-05).
 *
 * Рост: 1 с, 2 с, 4 с, 8 с … потолок 5 минут. Возврат 0 до порога.
 *
 * @param {string} email
 * @param {number} now
 */
export function delayFor(email, now = Date.now()) {
  const times = prune(accountKey(email), now);
  if (times.length < AUTH.attemptsPerAccount) return 0;
  const over = times.length - AUTH.attemptsPerAccount;
  const delay = AUTH.delayStepMs * 2 ** over;
  return Math.min(delay, AUTH.delayMaxMs);
}

/** Превышен ли лимит по IP (R-SEC-05, R-SEC-31). */
export function ipLimited(ip, now = Date.now()) {
  const times = prune('ip:' + ip, now);
  return times.length >= AUTH.attemptsPerIp;
}

/**
 * Сколько секунд ждать до освобождения лимита по адресу.
 *
 * Считается по самой старой попытке в окне, а не величиной окна целиком: иначе
 * человек, у которого лимит истёк две минуты назад, ждал бы ещё тринадцать.
 *
 * @param {string} ip
 * @param {number} [now]
 * @returns {number} секунды; 0 — лимит не превышен
 */
export function ipRetryAfter(ip, now = Date.now()) {
  const times = prune('ip:' + ip, now);
  if (times.length < AUTH.attemptsPerIp) return 0;
  return Math.max(1, Math.ceil((times[0] + AUTH.attemptsWindowMs - now) / 1000));
}

/** Записывает неудачную попытку по обоим ключам. */
export function recordFailure(email, ip, now = Date.now()) {
  const a = accountKey(email);
  for (const key of [a, 'ip:' + ip]) {
    const times = prune(key, now);
    times.push(now);
    failures.set(key, times);
  }
}

/** Успешный вход сбрасывает счётчик аккаунта: человек вошёл, а не подбирал. */
export function recordSuccess(email, now = Date.now()) {
  failures.delete(accountKey(email));
}

/**
 * Нужна ли сейчас невидимая проверка (R-SEC-34).
 *
 * Включается после трёх неудач и снимается одним успешным входом.
 */
export function needsProofOfWork(email, now = Date.now()) {
  return prune(accountKey(email), now).length >= AUTH.powAfterFailures;
}

/**
 * Выдаёт задачу и запоминает её.
 *
 * @param {string} key ключ, к которому привязана задача
 * @param {number} [zeros] сколько нулей должен содержать хеш решения.
 *   По умолчанию — настройка входа. Регистрация передаёт своё число,
 *   потому что при всплеске регистраций задача должна быть дороже, чем
 *   при переборе пароля (EC-A16).
 */
export function issueChallenge(key, zeros = AUTH.powZeros) {
  const challenge = crypto.randomBytes(16).toString('base64url');
  challenges.set(key, { challenge, zeros, issuedAt: Date.now() });
  return challenge;
}

function leadingZeros(hex) {
  let n = 0;
  for (const ch of hex) {
    if (ch === '0') n++;
    else break;
  }
  return n;
}

/**
 * Проверяет решение задачи.
 *
 * Задача выдаётся на конкретный ключ и живёт `AUTH.challengeTtlMs`: иначе
 * решение можно было бы перебрать один раз и переиспользовать.
 */
export function verifyChallenge(key, nonce) {
  const task = challenges.get(key);
  if (!task) return false;
  challenges.delete(key);
  if (Date.now() - task.issuedAt > AUTH.challengeTtlMs) return false;
  if (typeof nonce !== 'string' || nonce.length > 64) return false;
  const digest = crypto.createHash('sha256').update(task.challenge + nonce, 'utf8').digest('hex');
  return leadingZeros(digest) >= task.zeros;
}

// ─── Регистрация ─────────────────────────────────────────────────────────────
//
// Счётчики регистрации отдельные от счётчиков входа намеренно: всплеск
// регистраций и перебор пароля — разные явления, и сброс одного не должен
// обнулять другое.

/** Ключ счётчика успешных регистраций по адресу сети. */
export function registrationKey(ip) {
  return 'reg:' + String(ip ?? 'unknown');
}

/**
 * Ключ счётчика попыток.
 *
 * Отдельный от ключа успехов намеренно: по сложности задачи нельзя
 * понять, прошла регистрация или нет, иначе по времени ответа
 * перебирается, какие адреса уже заняты.
 */
function attemptKey(ip) {
  return 'regtry:' + String(ip ?? 'unknown');
}

/**
 * Успешных регистраций с этого адреса за последний час.
 *
 * Успех, а не попытка: стена должна держать всплеск настоящих аккаунтов.
 * По попыткам стена не строится — иначе пять неудачных регистраций от
 * человека с кривым адресом закрывают ему регистрацию на час.
 */
export function registrationsFrom(ip, now = Date.now()) {
  return (failures.get(registrationKey(ip)) ?? [])
    .filter((t) => now - t < HOUR).length;
}

/** Превышен ли жёсткий лимит успешных регистраций (R-SEC-31, F-01-01 §9). */
export function registrationLimited(ip, now = Date.now()) {
  return registrationsFrom(ip, now) >= AUTH.registrationsPerIp;
}

/** Записывает успешную регистрацию. */
export function recordRegistration(ip, now = Date.now()) {
  const key = registrationKey(ip);
  const times = (failures.get(key) ?? []).filter((t) => now - t < HOUR);
  times.push(now);
  failures.set(key, times);
}

/** Все попытки регистрации, успешные и нет: по ним растёт сложность. */
export function registrationAttempts(ip, now = Date.now()) {
  return (failures.get(attemptKey(ip)) ?? []).filter((t) => now - t < HOUR).length;
}

/**
 * Записывает попытку.
 *
 * Считается всегда, даже если форма отвергнута: иначе по сложности
 * задачи можно было бы отличить отказ по полям от отказа по лимиту.
 */
export function recordRegistrationAttempt(ip, now = Date.now()) {
  const key = attemptKey(ip);
  const times = (failures.get(key) ?? []).filter((t) => now - t < HOUR);
  times.push(now);
  failures.set(key, times);
}

/**
 * Нужна ли невидимая проверка при регистрации и какой сложности (EC-A16).
 *
 * Включается после штатного лимита в час: до этого человек не платит за
 * решение задачи, а всплеск — платит. Сложность растёт по одному
 * дополнительному нулю на каждый превышенный лимит и ограничена потолком, иначе при большом
 * всплеске задача становится неразрешимой в разумное время.
 *
 * @param {number} [attempts] попыток до текущей. Передаётся явно, потому
 *   что маршрут записывает текущую попытку до проверки: иначе попытка,
 *   доводящая счётчик до лимита, потребовала бы решения задачи.
 * @returns {{required:boolean, zeros:number}}
 */
export function registrationChallenge(ip, now = Date.now(), attempts = registrationAttempts(ip, now)) {
  const over = attempts - AUTH.registrationsFreePerIp;
  if (over < 0) return { required: false, zeros: AUTH.powZeros };
  const zeros = Math.min(AUTH.powZeros + over, AUTH.powZeros + REGISTRATION_POW_STEP);
  return { required: true, zeros };
}

/** Насколько сложнее задача регистрации против задачи входа. */
export const REGISTRATION_POW_STEP = 2;

/** Проверка занятости ника: не чаще десяти в минуту (F-01-01 §9). */
export function nicknameCheckLimited(ip, now = Date.now()) {
  const times = (failures.get('nick:' + ip) ?? []).filter((t) => now - t < MINUTE);
  return times.length >= AUTH.nickChecksPerMinute;
}

export function recordNicknameCheck(ip, now = Date.now()) {
  const key = 'nick:' + ip;
  const times = (failures.get(key) ?? []).filter((t) => now - t < MINUTE);
  times.push(now);
  failures.set(key, times);
}

/**
 * Повторные письма: не больше пяти в час на адрес (F-01-01 §9, F-01-02 §9).
 *
 * Ключ — хеш адреса, а не сам адрес: журнал не хранит почту (R-AN-04).
 * Счётчик по адресу, а не по сессии: сессию заводит кто угодно, и лимит
 * иначе обходится перезапуском браузера.
 *
 * @returns {{ok:boolean, retryAfter:number}} пауза до освобождения окна
 */
export function resendHourly(email, now = Date.now()) {
  const times = (failures.get(resendKey(email)) ?? []).filter((t) => now - t < HOUR);
  if (times.length < AUTH.resendPerHour) return { ok: true, retryAfter: 0 };
  const oldest = Math.min(...times);
  return { ok: false, retryAfter: Math.max(1, Math.ceil((oldest + HOUR - now) / 1000)) };
}

/** Записывает отправку письма. Считается только то, что реально ушло. */
export function recordResend(email, now = Date.now()) {
  const key = resendKey(email);
  const times = (failures.get(key) ?? []).filter((t) => now - t < HOUR);
  times.push(now);
  failures.set(key, times);
}

function resendKey(email) {
  return 'resend:' + accountKey(email);
}

// ─── Сброс пароля ────────────────────────────────────────────────────────────
//
// F-01-04 §9: не больше пяти заявок в час на адрес-получатель и десяти с
// одного адреса сети.
//
// Счётчики отдельные от повторных писем подтверждения: заявка на сброс и
// повторное письмо — разные события, и общий счётчик позволил бы одним
// исчерпать лимит другого.
//
// Считается каждая заявка, а не только отправленное письмо. Если считать
// отправки, то 429 выдавался бы лишь для существующих адресов и по нему
// перебирались бы аккаунты (R-SEC-06). Цена — чужая заявка занимает место
// в окне адреса; это осознанный размен в пользу неразличимости ответа.

function resetKey(email) {
  return 'reset:' + accountKey(email);
}

function resetIpKey(ip) {
  return 'resetip:' + String(ip ?? 'unknown');
}

/**
 * Превышен ли лимит заявок на сброс (F-01-04 §9).
 *
 * @returns {{ok:boolean, retryAfter:number}} пауза до освобождения окна, секунды
 */
export function resetRequestLimited(email, ip, now = Date.now()) {
  let retryAfter = 0;
  const keys = [
    [resetKey(email), AUTH.resetPerHour],
    [resetIpKey(ip), AUTH.resetPerIpPerHour],
  ];
  for (const [key, limit] of keys) {
    const times = (failures.get(key) ?? []).filter((t) => now - t < HOUR);
    if (times.length < limit) continue;
    retryAfter = Math.max(retryAfter, Math.ceil((Math.min(...times) + HOUR - now) / 1000));
  }
  return retryAfter > 0 ? { ok: false, retryAfter: Math.max(1, retryAfter) } : { ok: true, retryAfter: 0 };
}

/** Записывает заявку на сброс: и по получателю, и по адресу сети. */
export function recordResetRequest(email, ip, now = Date.now()) {
  for (const key of [resetKey(email), resetIpKey(ip)]) {
    const times = (failures.get(key) ?? []).filter((t) => now - t < HOUR);
    times.push(now);
    failures.set(key, times);
  }
}

// ─── Двухфакторная проверка (F-01-05 §9) ─────────────────────────────────────
//
// Счётчик свой, не общий со входом: код из шести цифр перебирается иначе,
// чем пароль, и общий счётчик блокировал бы вход из-за чужих неудачных
// попыток ввести код (R-SEC-05 — блокировка аккаунта недопустима, это
// готовый вектор отказа в обслуживании).

function twoFactorKey(userId) {
  return '2fa:' + userId;
}

/**
 * Превышен ли лимит попыток ввода кода 2FA.
 *
 * @param {number|string} userId
 * @param {number} [now]
 * @returns {{ok:boolean, retryAfter:number}} пауза до освобождения окна, секунды
 */
export function twoFactorLimited(userId, now = Date.now()) {
  const key = twoFactorKey(userId);
  const times = (failures.get(key) ?? []).filter((t) => now - t < AUTH.twoFactorWindowMs);
  if (times.length < AUTH.twoFactorAttempts) return { ok: true, retryAfter: 0 };

  const retryAfter = Math.ceil((times[0] + AUTH.twoFactorWindowMs - now) / 1000);
  return { ok: false, retryAfter: Math.max(1, retryAfter) };
}

/** Записывает неудачную попытку ввода кода. */
export function recordTwoFactorFailure(userId, now = Date.now()) {
  const key = twoFactorKey(userId);
  const times = (failures.get(key) ?? []).filter((t) => now - t < AUTH.twoFactorWindowMs);
  times.push(now);
  failures.set(key, times);
}

/** Сбрасывает счётчик: верный код означает, что человек тот, за кого себя выдаёт. */
export function clearTwoFactorFailures(userId) {
  failures.delete(twoFactorKey(userId));
}

/** Сбрасывает состояние. Нужен тестам: счётчики живут в модуле. */
export function _reset() {
  failures.clear();
  challenges.clear();
}