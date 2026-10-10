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
import { AUTH } from '../../config/settings.js';

/** @type {Map<string, number[]>} ключ → временные метки неудачных попыток */
const failures = new Map();

/** @type {Map<string, number>} ключ задачи → момент, когда можно повторить */
const blocked = new Map();

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

/** Выдаёт задачу и запоминает её. */
export function issueChallenge(key) {
  const challenge = crypto.randomBytes(16).toString('base64url');
  challenges.set(key, { challenge, issuedAt: Date.now() });
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
 * Задача выдаётся на конкретный ключ и живёт пять минут: иначе решение
 * можно было бы перебрать один раз и переиспользовать.
 */
export function verifyChallenge(key, nonce) {
  const task = challenges.get(key);
  if (!task) return false;
  challenges.delete(key);
  if (Date.now() - task.issuedAt > 5 * 60 * 1000) return false;
  if (typeof nonce !== 'string' || nonce.length > 64) return false;
  const digest = crypto.createHash('sha256').update(task.challenge + nonce, 'utf8').digest('hex');
  return leadingZeros(digest) >= AUTH.powZeros;
}

/** Сбрасывает состояние. Нужен тестам: счётчики живут в модуле. */
export function _reset() {
  failures.clear();
  blocked.clear();
  challenges.clear();
}