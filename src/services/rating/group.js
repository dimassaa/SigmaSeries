// Классификация отзыва по группам (F-04-05, OP-04).
//
// Две оси, заданные автором (DEC-015, MODERATION §3): по оценке автора —
// положительные 7–10, смешанные 5–6, отрицательные 1–4; по длине текста —
// короткие < 300, длинные ≥ 1000. Средние (300–999) существуют как группа,
// но фильтром не выбираются: они «попадают только в Все» (M4 F-04-05 §8б).
//
// Числа длины — из настроек модуля (M4 §0), не из литературы: смена числа в
// настройке меняет и вкладки, и выборку, поэтому источник один. Границ оценки
// в таблице настроек нет — они из решения автора, и поэтому подписаны здесь.

import { REVIEW } from '../../config/settings.js';

/** Положительные — от этой оценки и выше (DEC-015: 7–10). */
export const POSITIVE_FROM = 7;
/** Смешанные — от этой оценки и выше, но ниже `POSITIVE_FROM` (DEC-015: 5–6). */
export const MIXED_FROM = 5;

/** Значения фильтра «группа по оценке» — он же порядок вкладок на S-09. */
export const RATING_FILTERS = ['positive', 'mixed', 'negative'];
/** Значения фильтра длины; средние остаются только во «Все». */
export const LENGTH_FILTERS = ['short', 'long'];

/**
 * Группа по текущей оценке автора.
 *
 * Значение вне шкалы 1–10 или нецелое не относится ни к одной группе: `null`
 * — честный ответ. Отнести такой отзыв к «смешанным» по умолчанию значило бы
 * разойтись с числами вкладок: человек видит одно, а фильтр отбирает другое.
 *
 * @param {number|null|undefined} value оценка автора
 * @returns {'positive'|'mixed'|'negative'|null}
 */
export function ratingGroupOf(value) {
  if (!Number.isInteger(value) || value < 1 || value > 10) return null;
  if (value >= POSITIVE_FROM) return 'positive';
  if (value >= MIXED_FROM) return 'mixed';
  return 'negative';
}

/**
 * Группа по длине текста после обрезки пробелов (M4 F-04-05 §8б).
 *
 * @param {string} text
 * @returns {'short'|'medium'|'long'}
 */
export function lengthGroupOf(text) {
  const length = String(text ?? '').trim().length;
  if (length < REVIEW.shortMaxChars) return 'short';
  if (length < REVIEW.longMinChars) return 'medium';
  return 'long';
}
