// Лента уведомлений (F-03-09, S-31).
//
// Три правила, которые этот файл держит:
//
//  1. День группировки — локальный день читателя, а не серверный. Уведомление,
//     созданное в 22:40 по Минску, для жителя Калифорнии приходит «вчера»,
//     и лента, разложенная по серверным дням, показывала бы «сегодня» там, где
//     человек уже спал. Группировка поэтому делается в его поясе (`H-72`).
//  2. Чужие строки не видны и не трогаются: `user_id` стоит в каждом запросе,
//     а не в проверке после выборки (`R-SEC-10`).
//  3. Открытая страница ничего не помечает прочитанным. Иначе человек вернулся
//     посмотреть ленту — и обнаружил, что она уже прочитана, потому что он её
//     открыл.

import pg from 'pg';

/** Строк на странице ленты (F-03-09 §4). */
export const PAGE_SIZE = 30;

/** `notify.retention_read_days` и `notify.retention_unread_days` (M3 §0). */
export const RETENTION = { readDays: 90, unreadDays: 180 };

/** `notify.max_per_user` (M3 §0). */
export const MAX_PER_USER = 500;

/** `notify.poll_s` (M3 §0) — период опроса счётчика непрочитанных. */
export const POLL_SECONDS = 60;

/**
 * Источник данных ленты.
 *
 * @param {pg.Pool} pool
 */
export function pgNotificationFeed(pool) {
  return {
    /**
     * Лента по дням.
     *
     * @param {object} args
     * @param {number} args.userId
     * @param {number} [args.page]
     * @param {string|null} [args.category] фильтр по категории
     * @param {string} [args.today] сегодняшняя дата пояса читателя `YYYY-MM-DD`
     * @param {number} [args.size]
     * @returns {Promise<any>}
     */
    async feed({ userId, page = 1, category = null, today, size = PAGE_SIZE }) {
      const current = Math.max(1, Number(page) || 1);
      /** @type {any[]} */
      const values = [userId, size, (current - 1) * size];
      const filter = category ? 'AND n.category = $4' : '';
      if (category) values.push(category);

      const { rows } = await pool.query(
        `SELECT n.id, n.kind, n.category, n.params, n.created_at, n.read_at,
                (n.created_at AT TIME ZONE u.timezone)::date::text AS day,
                s.slug AS series_slug,
                (s.id IS NOT NULL AND s.publication_state = 'published'
                   AND s.archived_at IS NULL) AS available
           FROM e_notification n
           JOIN e_user u ON u.id = n.user_id
           LEFT JOIN e_series s ON s.slug = n.params->>'seriesSlug'
          WHERE n.user_id = $1 ${filter}
          ORDER BY n.created_at DESC, n.id DESC
          LIMIT $2 OFFSET $3`,
        values,
      );

      const { rows: [count] } = await pool.query(
        `SELECT count(*)::int AS n FROM e_notification
          WHERE user_id = $1 ${category ? 'AND category = $2' : ''}`,
        category ? [userId, category] : [userId],
      );

      // Дни собираются уже на выбранной странице: пагинация по записям, а
      // разбивка по дням — представление. Иначе «сегодня» могло бы оказаться
      // на третьей странице, и человек искал бы его, не зная, что оно есть.
      const groups = [];
      for (const row of rows) {
        const last = groups[groups.length - 1];
        if (last && last.day === row.day) {
          last.items.push(row);
        } else {
          groups.push({ day: row.day, items: [row] });
        }
      }

      return {
        groups,
        total: count.n,
        page: current,
        pages: Math.max(1, Math.ceil(count.n / size)),
        size,
        category: category ?? null,
        today: today ?? rows[0]?.day ?? null,
      };
    },

    /**
     * Сколько непрочитанных — число на аватаре (UI-11).
     *
     * @param {number|null} userId
     * @returns {Promise<number>}
     */
    async unreadCount(userId) {
      if (!userId) return 0;

      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM e_notification WHERE user_id = $1 AND read_at IS NULL',
        [userId],
      );
      return rows[0].n;
    },

    /**
     * Прочитать или вернуть в непрочитанные — только свою запись.
     *
     * @param {object} args
     * @param {number} args.userId
     * @param {number} args.id
     * @param {boolean} args.read
     * @returns {Promise<{ok: boolean}>}
     */
    async setRead({ userId, id, read }) {
      const { rowCount } = await pool.query(
        `UPDATE e_notification SET read_at = CASE WHEN $3 THEN now() ELSE NULL END
          WHERE id = $1 AND user_id = $2`,
        [id, userId, read],
      );
      return { ok: rowCount > 0 };
    },

    /**
     * Удалить свою запись. Уведомления не восстанавливаются: человек решил,
     * что оно ему не нужно.
     *
     * @param {object} args
     * @param {number} args.userId
     * @param {number} args.id
     * @returns {Promise<{ok: boolean}>}
     */
    async remove({ userId, id }) {
      const { rowCount } = await pool.query(
        'DELETE FROM e_notification WHERE id = $1 AND user_id = $2', [id, userId],
      );
      return { ok: rowCount > 0 };
    },

    /**
     * Прочитать всё — одна операция, а не по одной на запись.
     *
     * @param {number} userId
     * @returns {Promise<number>} сколько стало прочитанным
     */
    async readAll(userId) {
      const { rowCount } = await pool.query(
        'UPDATE e_notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
        [userId],
      );
      return rowCount;
    },

    /**
     * Открыть запись: пометить прочитанной и сказать, куда вести (F-03-09 §4).
     *
     * @param {object} args
     * @param {number} args.userId
     * @param {number} args.id
     * @returns {Promise<{ok: boolean, target: string|null}>}
     */
    async open({ userId, id }) {
      const { rows } = await pool.query(
        'UPDATE e_notification SET read_at = now() WHERE id = $1 AND user_id = $2 RETURNING params',
        [id, userId],
      );
      if (!rows.length) return { ok: false, target: null };

      const params = rows[0].params ?? {};
      const slug = params.seriesSlug;
      if (!slug) return { ok: true, target: null };

      // Ссылка ведёт туда, где человек сможет открыть, а не туда, где запись
      // была создана: сериал могли снять с публикации или удалить (EC-T14).
      const { rows: [series] } = await pool.query(
        `SELECT 1 AS ok FROM e_series
          WHERE slug = $1 AND publication_state = 'published' AND archived_at IS NULL`,
        [slug],
      );
      if (!series) return { ok: true, target: null };

      // На одну серию ведём прямо на неё: из уведомления человек идёт читать,
      // а не выбирать серию заново. Несколько серий одним днём — это сезон или
      // группа, и точной «страницы одной серии» у них нет.
      const only = Array.isArray(params.episodes) && params.episodes.length === 1
        ? params.episodes[0]
        : null;
      const season = Number.isInteger(params.season) ? params.season : null;

      return {
        ok: true,
        target: only && season && season > 0
          ? `/series/${slug}/seasons/${season}/episodes/${only}`
          : `/series/${slug}`,
      };
    },

    /**
     * Уборка по срокам хранения (F-03-09 §8в).
     *
     * Прочитанное живёт `readDays`, непрочитанное — дольше: человек может
     * вернуться через месяц, и «вышло три месяца назад» его не интересует,
     * а пропущенное уведомление о переносе — интересует.
     *
     * @param {object} [args]
 * @param {any} [args.maxPerUser]
 * @param {any} [args.readDays]
 * @param {any} [args.unreadDays]
     * @returns {Promise<number>} сколько записей убрано
     */
    async prune({ readDays = RETENTION.readDays, unreadDays = RETENTION.unreadDays, maxPerUser = MAX_PER_USER } = {}) {
      const { rowCount } = await pool.query(
        `WITH aged AS (
           DELETE FROM e_notification
            WHERE (read_at IS NOT NULL AND read_at < now() - ($1 || ' days')::interval)
               OR (read_at IS NULL AND created_at < now() - ($2 || ' days')::interval)
         ),
         numbered AS (
           -- Потолок списка: у каждого человека остаются последние непрочитанные,
           -- а не «случайные $3 из большего». Порядок нужен и здесь: по времени
           -- создания, и по идентификатору — иначе при равных секундах выборка
           -- случайна и человек теряет то, что ещё не прочитал.
           SELECT id FROM (
             SELECT id, row_number() OVER (
                      PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS pos
               FROM e_notification WHERE read_at IS NULL
           ) t WHERE pos > $3
         )
         DELETE FROM e_notification WHERE id IN (SELECT id FROM numbered)`,
        [String(readDays), String(unreadDays), maxPerUser],
      );
      return rowCount;
    },
  };
}
