// Время запусков импорта (F-12-07 §6, §9).
//
// Здесь нет БД и сети — только разбор времени и арифметика. Так и должно быть:
// ошибка в расписании проявляется ночью, когда никто не смотрит, и самая
// дешёвая защита — проверка функции, а не интеграции.

/** Длина окна, в котором запуск считается «пора»: минута. */
export const DUE_WINDOW_MS = 60_000;

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Разбирает время запуска из вида `ЧЧ:ММ` (§9).
 *
 * Валидация строгая и падает с ошибкой: молча разобранное неверное значение
 * означало бы, что ночной запуск просто не наступит — и это выглядело бы как
 * «источник не отвечает», а не как ошибка в настройке.
 *
 * @param {string} value
 * @returns {{hours: number, minutes: number}}
 * @throws {Error} значение не вида `ЧЧ:ММ`
 */
export function parseScheduleTime(value) {
  const text = String(value ?? '').trim();
  const match = TIME.exec(text);
  if (!match) {
    throw new Error(`время запуска должно быть в формате ЧЧ:ММ, получено «${text}»`);
  }
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/**
 * Выражение cron для запуска в заданное время.
 *
 * Часы и минуты всегда с ведущими нулями: `4 * * * *` парсится как «каждые
 * четыре минуты», и такая ошибка молча ломает всё расписание.
 *
 * @param {string} value время в виде `ЧЧ:ММ`
 * @returns {string}
 */
export function cronFor(value) {
  const { hours, minutes } = typeof value === 'object' ? value : parseScheduleTime(value);
  return `${minutes} ${hours} * * *`;
}

/**
 * Наступило ли время запуска.
 *
 * Окно — минута, а не точная миллисекунда: тик планировщика приходит раз в
 * минуту, и требовать попадания в секунду означало бы пропускать ночь при
 * любом, даже мизерном, опоздании.
 *
 * @param {{hours:number, minutes:number}} time
 * @param {Date} now
 * @returns {boolean}
 */
export function isDue(time, now = new Date()) {
  const at = new Date(now);
  at.setSeconds(0, 0);
  const due = new Date(at);
  due.setHours(time.hours, time.minutes, 0, 0);
  const elapsed = at.getTime() - due.getTime();
  return elapsed >= 0 && elapsed < DUE_WINDOW_MS;
}

/**
 * Ближайшее следующее вхождение времени (строго позже `now`).
 *
 * @param {{hours:number, minutes:number}} time
 * @param {Date} now
 * @returns {Date}
 */
export function nextOccurrence(time, now = new Date()) {
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(time.hours, time.minutes, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/**
 * Понедельник в заданное время — день еженедельного обновления рейтингов.
 *
 * День и время в таблице настроек не заданы, поэтому берутся константой
 * (DEC-053): понедельник, час после ночного запуска. Рейтинги за прошедшую
 * неделю к понедельнику уже закрыты.
 *
 * @param {{hours:number, minutes:number}} time
 * @param {Date} now
 * @returns {boolean}
 */
export function isWeeklyDue(time, now = new Date()) {
  return now.getDay() === 1 && isDue(time, now);
}

/** Понедельник = 1 в `Date.getDay()`. */
const MONDAY = 1;

/**
 * Ближайший понедельник в заданное время.
 *
 * Именно понедельник, а не «ближайшее вхождение»: еженедельная задача,
 * запланированная на вторник, должна ждать следующего понедельника, иначе
 * план на семь дней вперёд превратился бы в ежедневную задачу.
 *
 * @param {{hours:number, minutes:number}} time
 * @param {Date} now
 * @returns {Date}
 */
export function nextWeekly(time, now = new Date()) {
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(time.hours, time.minutes, 0, 0);
  const daysAhead = (MONDAY - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + daysAhead);
  // Понедельник сегодняшний уже прошёл, если нужный час позади.
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 7);
  return next;
}
