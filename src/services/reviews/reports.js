// Жалоба на отзыв (F-04-07).
//
// Правила приёма:
//
//  1. Жалобу подаёт подтверждённый аккаунт — «Зритель и выше» (M2 §2), и не
//     на свой отзыв (F-04-07 §2). Правило проверяет сервис, а не разметка:
//     пункт меню можно скрыть как угодно, правда — в одном месте.
//  2. Жалоба единственная на пару пользователь–материал: уникальность держит
//     первичный ключ, повторная подача — не строка, а вежливое «уже
//     пожаловались» (EC-V16). Никто не может поднять порог повторами.
//  3. Жалуется читатель тому, что видит: видимость — тот же предикат, что
//     сортирует список (H-75). Снимок правки на проверке виден им же.
//  4. Порог R-MOD-16: трое разных податчиков скрывают материал до решения
//     редактора. Переход «Опубликован → Помечен» (STATES §1): Помечен —
//     состояние очереди редактора (`ix_material_queue`). Снимок видимой
//     версии при скрытии очищается (R-MOD-16 «скрыт до решения» сильнее
//     R-MOD-21 о прежней версии правки: решение редактора вернёт отзыв,
//     снимок правки пересоздаётся при следующей подаче). Переход повторно
//     не срабатывает: условие требует прежнего состояния — выделить
//     транзакцию незачем, гонка двух одновременных податчиков безопасна
//     (UPDATE увидит только одну публикацию).
//  5. Счётчик порога считает все жалобы материала, включая разрешённые
//     редактором: разбор жалоб (F-05-05) снимет это, если редакторская
//     логика назовёт иначе — сейчас в очереди нет ни снятия жалобы, ни
//     возврата в «Опубликован», и считать иное нечем.

import { READABLE } from './list.js';
import { MODERATION } from '../../config/settings.js';

export const REPORT_REASONS = {
  MISSING: 'missing',
  KIND: 'kind',
  OWN: 'own',
  NOT_CONFIRMED: 'not-confirmed',
  ALREADY: 'already',
};

/** Причины жалобы (F-04-07 §4). Индексы — значения колонки `reason`. */
export const REPORT_CODES = ['spam', 'harassment', 'spoiler', 'offtopic', 'other'];

/** Отзыв принимает жалобу: существует, это отзыв, виден читателю,
 * принадлежит сериалу из адреса — чужая витрина не жалуется. */
const ELIGIBLE = `SELECT m.kind, m.author_id,
       (SELECT u.email_confirmed FROM e_user u WHERE u.id = $1) AS confirmed
  FROM e_material m
 WHERE m.id = $2 AND m.series_id = $3 AND ${READABLE}`;

/**
 * Жалобы на отзывы (E-Report).
 *
 * @param {import('pg').Pool} pool
 */
export function pgReviewReports(pool) {
  return {
    /**
     * Подать жалобу. Повторная — «уже подано», без второй строки.
     *
     * @param {object} input
     * @param {number} input.userId податель
     * @param {number} input.materialId отзыв
     * @param {number} input.seriesId сериал из адреса: жалоба идёт материалу
     *   своей витрины
     * @param {string} input.reason причина из `REPORT_CODES` (проверяет
     *   маршрут; колонка держит CHECK)
     * @param {string} [input.comment] необязательный комментарий до 300
     *   знаков (проверяет маршрут)
     * @returns {Promise<{ok: true, reported: true, hidden: boolean} |
     *   {ok: false, reason: string}>}
     */
    async submit({ userId, materialId, seriesId, reason, comment = '' }) {
      // Дубль прежде видимости (EC-V16): своя прежняя жалоба правдива и о
      // материале, который уже скрыт по жалобам или ушёл в очередь, —
      // вежливый ответ честнее «отзыва нет».
      const { rowCount: duplicate } = await pool.query(
        'SELECT 1 FROM e_report WHERE user_id = $1 AND material_id = $2',
        [userId, materialId],
      );
      if (duplicate > 0) return { ok: false, reason: REPORT_REASONS.ALREADY };

      const { rows: [row] } = await pool.query(ELIGIBLE, [userId, materialId, seriesId]);
      if (!row) return { ok: false, reason: REPORT_REASONS.MISSING };
      if (row.kind !== 'review') return { ok: false, reason: REPORT_REASONS.KIND };
      if (Number(row.author_id) === Number(userId)) {
        return { ok: false, reason: REPORT_REASONS.OWN };
      }
      if (!row.confirmed) {
        return { ok: false, reason: REPORT_REASONS.NOT_CONFIRMED };
      }

      const added = await pool.query(
        `INSERT INTO e_report (user_id, material_id, reason, comment)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, material_id) DO NOTHING`,
        [userId, materialId, reason, comment],
      );
      if (added.rowCount === 0) return { ok: false, reason: REPORT_REASONS.ALREADY };

      // Порог по разным податчикам, а не по строкам: повторы не помогают.
      const { rows: [countRow] } = await pool.query(
        `SELECT count(DISTINCT user_id)::int AS n
           FROM e_report
          WHERE material_id = $1`,
        [materialId],
      );
      const crossed = countRow.n >= MODERATION.reportHideThreshold;
      if (crossed) {
        await pool.query(
          `UPDATE e_material
              SET state = 'flagged'
                , visible_body = NULL
                , visible_spoiler = FALSE
            WHERE id = $1 AND state IN ('published', 'checking', 'flagged')`,
          [materialId],
        );
      }
      return { ok: true, reported: true, hidden: crossed };
    },
  };
}
