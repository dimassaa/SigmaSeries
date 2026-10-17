// Настройки уведомлений (F-03-10, S-32).
//
// Модуль маленький и существует по одной причине: правило «категорию можно
// выключить» должно быть в одном месте. Список категорий и каналов — тот же,
// что у реестра типов (`notify/types.js`): если настройка разрешит выключить
// категорию, которой нет в реестре, человек получит уведомление, которое не
// сумеет отключить, и второй список разойдётся с первым при первом же новом типе.
//
// Отсутствие строки означает «включено»: по умолчанию человек получает всё, а
// выключает то, что мешает. Иначе пустая таблица настроек молча отключила бы
// уведомления всем подряд.

/** Категории, которые человек может выключить (F-03-10 §4). */
export const CATEGORIES = ['release', 'reply', 'service'];

/** Категория, которую выключить нельзя: человек должен знать судьбу материала (R-MOD-19). */
export const MANDATORY = ['moderation'];

/** Каналы: «в сервисе» есть всегда, почта и push появятся со своими модулями. */
export const CHANNELS = ['in_service', 'email', 'push'];

/** Канал, который работает в этой сборке. */
export const DEFAULT_CHANNEL = 'in_service';

/**
 * Источник настроек уведомлений.
 *
 * @param {import('pg').Pool} pool
 */
export function pgNotificationPreferences(pool) {
  return {
    /**
     * Матрица «категория × канал» для одного человека.
     *
     * Возвращается полной: отсутствие строки в таблице означает включённое
     * состояние, иначе пустая таблица настроек отключила бы всё сразу.
     *
     * @param {number} userId
     * @returns {Promise<Record<string, Record<string, boolean>>>}
     */
    async matrix(userId) {
      const { rows } = await pool.query(
        `SELECT category, channel, enabled FROM e_notification_preference WHERE user_id = $1`,
        [userId],
      );

      const stored = new Map(rows.map((row) => [`${row.category}:${row.channel}`, row.enabled]));
      const matrix = {};
      for (const category of [...CATEGORIES, ...MANDATORY]) {
        matrix[category] = {};
        for (const channel of CHANNELS) {
          matrix[category][channel] = stored.get(`${category}:${channel}`) ?? true;
        }
      }
      return matrix;
    },

    /**
     * Включить или выключить категорию в канале.
     *
     * Отказ здесь — не формальность: сервер проверяет то же, что и форма, иначе
     * запрет обходится прямым запросом (R-SEC-24).
     *
     * @param {object} args
     * @param {number} args.userId
     * @param {string} args.category
     * @param {string} args.channel
     * @param {boolean} args.enabled
     * @returns {Promise<{ok: boolean, reason?: string}>}
     */
    async set({ userId, category, channel, enabled }) {
      // Обязательные категории проверяются первыми: человеку, который tries
      // выключить результат проверки, нужен отказ с этой формулировкой, а не
      // «неизвестная категория» — иначе он решит, что ошибся адресом.
      if (!enabled && MANDATORY.includes(category)) return { ok: false, reason: 'mandatory' };
      if (![...CATEGORIES, ...MANDATORY].includes(category)) return { ok: false, reason: 'unknown-category' };
      if (!CHANNELS.includes(channel)) return { ok: false, reason: 'unknown-channel' };

      // Обязательная категория остаётся включённой при любом значении, остальные
      // получают ровно то, что человек выбрал.
      const wanted = MANDATORY.includes(category) ? true : Boolean(enabled);

      await pool.query(
        `INSERT INTO e_notification_preference (user_id, category, channel, enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, category, channel)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
        [userId, category, channel, wanted],
      );
      return { ok: true };
    },

    /**
     * Условие SQL «уведомление этой категории этому человеку не запрещено».
     *
     * Живёт здесь, а не в трёх местах создания уведомлений: правило «человек
     * выключил — не присылаем» обязано быть одно, иначе забудут про новый путь.
     *
     * @param {number} categoryIndex номер параметра с категорией в запросе
     * @returns {string}
     */
    allowedSql(categoryIndex) {
      return `NOT EXISTS (
        SELECT 1 FROM e_notification_preference p
         WHERE p.user_id = u AND p.channel = 'in_service'
           AND p.category = $${categoryIndex} AND p.enabled = FALSE)`;
    },
  };
}