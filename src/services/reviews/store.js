// Отзыв: хранение и конвейер публикации (F-04-04, OP-01 на входе).
//
// Правила, из-за которых сервис существует:
//
//  1. Один отзыв на пару «автор и сериал» (F-04-04 §8а). Правка идёт той же
//     строкой и поднимает `version`, поэтому «один отзыв» — это свойство
//     данных, а не только интерфейса: прямой POST второй строки не создаст.
//  2. Право проверяется на сервере (EC-V1): подтверждённый адрес и отметка
//     сериала нужны только для нового отзыва — правку своего человек может
//     сделать и после того, как отметки не стало.
//  3. Проверка текста — тот же конвейер, что у любого материала (OP-01):
//     словарь недоступен — «проверка», слово найдено — «помечен», иначе
//     «опубликован». Оценка при этом сохраняется отдельно (EC-V8, H-75).
//  4. Правка опубликованного не теряет прежнюю версию: пока новая не прошла
//     проверку, читателям виден прежний текст (R-MOD-21, EC-V9). Для этого
//     `visible_body`/`visible_spoiler` хранят снимок, а не ссылку на историю:
//     у материала одна видимая версия, и её достаточно.
//  5. Лимиты считаются по `submitted_at`, а не по `created_at`: правка — это
//     новая подача, и интервал повторной проверки отсчитывается от неё
//     (R-MOD-09). Правки не входят в часовой лимит публикаций (R-MOD-10):
//     иначе исправление пометки съедало бы право писать.
//  6. Мьют читается из `e_restriction` (M1 F-01-08) и отклоняет отправку с
//     датой окончания — чтение и оценка при этом работают.

import { HOUR } from '../../config/settings.js';
import { REVIEW, MODERATION } from '../settings.js';
import { pgModerationBudget } from '../moderation/budget.js';
import { notifyStaff } from '../notify/staff.js';
import { pgModerationClusters } from '../moderation/cluster.js';

/** Причина отказа — короткая строка, по ней маршрут выбирает текст. */
export const REASONS = {
  MUTED: 'muted',
  /** F-05-03: шестой материал автора за минуту — отказ (mod.submission_rate_per_min). */
  RATE: 'rate',
  NOT_CONFIRMED: 'not-confirmed',
  NO_MARK: 'no-mark',
  LIMIT: 'limit',
  COOLDOWN: 'cooldown',
  /** F-05-03: очередь модерации переполнена (R-MOD-11). */
  QUEUE_FULL: 'queue-full',
  EMPTY: 'empty',
  SHORT: 'short',
  LONG: 'long',
};

/** Состояния, в которых отзыв ждёт решения редактора. */
const PENDING = new Set(['flagged', 'checking']);

/** Состояния, в которых прежняя версия может быть видна читателям. */
const VISIBLE = new Set(['published', 'approved']);

/**
 * Язык текста по письменности (R-I18N-08).
 *
 * Считаются буквы: кириллических не меньше латинских — русский. Поле языка
 * в форме есть, но подставить его можно и неверно, поэтому при отсутствии
 * значения язык определяется здесь, а не берётся из интерфейса.
 *
 * @param {string} text
 * @returns {'ru'|'en'}
 */
export function detectLang(text) {
  let cyrillic = 0;
  let latin = 0;
  for (const ch of String(text ?? '')) {
    if (/\p{Script=Cyrillic}/u.test(ch)) cyrillic += 1;
    else if (/\p{Script=Latin}/u.test(ch)) latin += 1;
  }
  return cyrillic >= latin ? 'ru' : 'en';
}

/**
 * Сколько секунд осталось до конца интервала повторной проверки.
 *
 * @param {{state: string, submittedAt: Date}} own
 * @param {Date} [at]
 * @returns {number} 0 — интервал прошёл
 */
export function cooldownLeft(own, at = new Date()) {
  if (!own || !PENDING.has(own.state)) return 0;
  const until = new Date(own.submittedAt).getTime() + REVIEW.recheckMin * 60 * 1000;
  return Math.max(0, Math.ceil((until - at.getTime()) / 1000));
}

/** Строка отзыва для вида: имена полей — как в остальном коде. */
function reviewOf(row) {
  return {
    id: Number(row.id),
    state: row.state,
    body: row.body,
    spoiler: row.spoiler,
    lang: row.lang,
    version: Number(row.version),
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    visibleBody: row.visible_body,
    visibleSpoiler: row.visible_spoiler,
  };
}

/**
 * Источник данных отзывов.
 *
 * @param {import('pg').Pool} pool
 */
export function pgReviews(pool, { budget = null, restrictions = null, moderationClusters = null } = {}) {
  // Бюджеты модерации живут здесь же: они считают по той же таблице
  // материалов, что и отзывы, и спрашивать их должен тот же код, что и
  // отправляет материал (F-05-03). Бюджет подставляется снаружи: «осторожный»
  // режим — состояние всего сервиса, и проверять его поведение можно, не
  // включая его для всех подряд.
  const limits = budget ?? pgModerationBudget(pool);
  // Кластеры: решение редактора по группе распространяется на новые
  // материалы с той же сигнатурой (подтверждено автором 21.10).
  const clusters = moderationClusters ?? pgModerationClusters(pool);

  return {
    /**
     * Действующий мьют или `null`.
     *
     * Просроченный мьют не мешает, даже если его не сняли руками: срок —
     * часть записи, и ждать редактора для разблокировки человек не должен
     * (F-05-08 §5).
     *
     * @param {number} userId
     * @param {Date} [at]
     * @returns {Promise<{reason: string, until: Date|null}|null>}
     */
    async muteOf(userId, at = new Date()) {
      const { rows } = await pool.query(
        `SELECT reason, expires_at
           FROM e_restriction
          WHERE user_id = $1 AND kind IN ('mute', 'ban') AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > $2)`,
        [userId, at],
      );
      return rows[0] ? { reason: rows[0].reason, until: rows[0].expires_at } : null;
    },

    /**
     * Свой отзыв по сериалу — включая помеченный и ожидающий проверки.
     *
     * Удалённый отзыв не возвращается: для автора он перестал существовать,
     * а строка остаётся в хранилище ради истории (мягкое удаление, §1.4).
     *
     * @param {number} userId
     * @param {number} seriesId
     * @returns {Promise<object|null>}
     */
    async ownReview(userId, seriesId) {
      const { rows } = await pool.query(
        `SELECT id, state, body, spoiler, lang, version,
                submitted_at, created_at, visible_body, visible_spoiler
           FROM e_material
          WHERE author_id = $1 AND series_id = $2 AND kind = 'review' AND state <> 'deleted'`,
        [userId, seriesId],
      );
      return rows[0] ? reviewOf(rows[0]) : null;
    },

    /**
     * Отправляет отзыв в конвейер.
     *
     * @param {object} input
     * @param {number} input.userId
     * @param {number} input.seriesId
     * @param {string} input.body
     * @param {boolean} [input.spoiler]
     * @param {'ru'|'en'|null} [input.lang] если не задан — по письменности
     * @param {{block: Array, allow: Array, available: boolean}} input.dictionary
     * @param {Date} [input.at]
     * @returns {Promise<{ok: boolean, reason?: string, state?: string,
     *   matched?: object[], version?: number, retryAfterSec?: number,
     *   until?: Date|null}>}
     */
    async submit({
      userId, seriesId, body, spoiler = false, lang = null, dictionary, at = new Date(),
    }) {
      const text = String(body ?? '').trim();
      if (text.length < REVIEW.lenMin) return { ok: false, reason: REASONS.SHORT };
      if (text.length > REVIEW.lenMax) return { ok: false, reason: REASONS.LONG };

      const mute = await this.muteOf(userId, at);
      if (mute) return { ok: false, reason: REASONS.MUTED, until: mute.until };

      // F-05-03: один автор не должен завалить очередь частотой. Шестой
      // материал за минуту — отказ, дальше лимит снова наполняется.
      const burst = await limits.submissionsInMinute(userId, at);
      if (burst >= MODERATION.submissionRatePerMin) {
        return { ok: false, reason: REASONS.RATE, retryAfterSec: 60 };
      }

      const existing = await this.ownReview(userId, seriesId);
      if (!existing) {
        const right = await this.rightToWrite(userId, seriesId);
        if (!right.ok) return right;
      } else {
        const left = cooldownLeft(existing, at);
        if (left > 0) return { ok: false, reason: REASONS.COOLDOWN, retryAfterSec: left };
      }

      // Проверка текста — до записи: отклонённый материал не создаёт строку,
      // и «пустой» текст не занимает единственный слот отзыва.
      const { checkMaterial } = await import('../moderation/check.js');
      const result = checkMaterial({ body: text, dictionary });
      if (result.decision === 'reject') return { ok: false, reason: REASONS.EMPTY };

      // «Осторожный» режим (F-05-03): доля помеченных превысила порог —
      // новый материал не публикуется автоматически, а ждёт решения
      // редактора. Материалы, которые проверка сама отклонила или
      // отложила, в очередь попадают как обычно.
      const state = result.decision === 'publish'
        ? ((await limits.cautiousState()).cautious ? 'checking' : 'published')
        : result.decision === 'queue' ? 'flagged' : 'checking';
      const chosen = lang === 'ru' || lang === 'en' ? lang : detectLang(text);

      // Потолок очереди (R-MOD-11): когда ожидающих слишком много, новый
      // помеченный материал от автора с историей модерации в очередь не
      // ставится. Автор получает отказ, а в базе остаётся только хэш текста —
      // для кластеров. Текст не хранится: материал в очередь не попал и
      // разбирать его некому.
      let stored = text;
      let storedState = state;
      let queueFull = false;
      if (state === 'flagged') {
        const { signatureOf } = await import('../moderation/cluster.js');

        // Решение редактора по кластеру (F-05-03, подтверждено автором
        // 21.10): по этой сигнатуре материалы уже запрещены — новый материал
        // с той же сигнатурой отклоняется сразу, ждать нового разбора не
        // нужно. В базе остаётся хэш текста: читать его всё равно некому.
        const verdict = await clusters.forbidden(signatureOf(text));
        if (verdict.forbidden) {
          stored = signatureOf(text);
          storedState = 'rejected';
          await pool.query(
            `INSERT INTO e_notification (user_id, kind, category, params, dedup_key)
             VALUES ($1, 'material_decision', 'service', $2, $3)
             ON CONFLICT (user_id, dedup_key) DO NOTHING`,
            [
              userId,
              JSON.stringify({ decision: 'rejected', reason: verdict.reason ?? 'запрещено кластером' }),
              `material-decision-cluster:${signatureOf(text)}:${userId}`,
            ],
          );
        }

        // Потолок очереди (R-MOD-11): когда ожидающих слишком много, новый
        // помеченный материал от автора с историей модерации в очередь не
        // ставится. Автор получает отказ, а в базе остаётся только хэш текста —
        // для кластеров. Текст не хранится: материал в очередь не попал и
        // разбирать его некому.
        const overflow = await limits.queueOverflow(userId, at);
        if (!verdict.forbidden && overflow.refuse) {
          stored = signatureOf(text);
          storedState = 'rejected';
          queueFull = true;
        }
      }

      // Найденные слова: редактор видит, что сработало (R-MOD-12), автор — нет.
      const matches = JSON.stringify((result.matched ?? []).map((item) => ({
        word: item.word,
        list: item.list ?? null,
        category: item.category ?? null,
        start: item.start ?? null,
        end: item.end ?? null,
      })));

      if (existing) {
        const snapshot = VISIBLE.has(existing.state);
        await pool.query(
          `UPDATE e_material
              SET body = $3, spoiler = $4, lang = $5, state = $6,
                  version = version + 1, submitted_at = $7,
                  matches = $9,
                  visible_body = CASE WHEN $8 THEN body ELSE visible_body END,
                  visible_spoiler = CASE WHEN $8 THEN spoiler ELSE visible_spoiler END
            WHERE id = $1 AND author_id = $2`,
          [existing.id, userId, text, spoiler, chosen, state, at, snapshot, matches],
        );
        // Новая версия прошла проверку и снова видна — снимок больше не нужен.
        if (storedState === 'published') {
          await pool.query(
            'UPDATE e_material SET visible_body = NULL, visible_spoiler = FALSE WHERE id = $1',
            [existing.id],
          );
        }
        if (queueFull) {
          return { ok: false, reason: REASONS.QUEUE_FULL, retryAfterSec: 900 };
        }
        return {
          ok: true,
          state: storedState,
          matched: result.matched,
          version: existing.version + 1,
        };
      }

      // Новый отзыв. Часовой лимит проверяется здесь, а не раньше: правка
      // своего отзыва не должна съедать право написать первый (R-MOD-10).
      const limited = await this.overLimit(userId, at);
      if (limited) return limited;

      const { rows } = await pool.query(
        `INSERT INTO e_material (author_id, kind, series_id, body, spoiler, lang, state, submitted_at, matches)
         VALUES ($1, 'review', $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, version`,
        [userId, seriesId, stored, spoiler, chosen, storedState, at, matches],
      );
      if (queueFull) {
        return { ok: false, reason: REASONS.QUEUE_FULL, retryAfterSec: 900 };
      }
      // Бюджет помеченных попыток (R-MOD-08): пятый помеченный материал за
      // час — автоматический мьют на час, повтор — на сутки. Мьют ставит
      // система, поэтому у него нет автора.
      if (state === 'flagged' && restrictions) {
        const budget = await limits.flaggedBudget(userId, at);
        if (budget.mute) {
          await restrictions.mute({
            userId, hours: budget.hours, reason: budget.reason, byId: null,
          });
          // Третий раз превышения — сигнал администратору (R-MOD-08): система
          // справилась сама, но решение о блокировке принимает человек.
          if (budget.notify) {
            await notifyStaff({
              pool,
              kind: 'spam_budget_hit',
              params: { userId },
              dedupKey: `spam-budget-hit:${userId}:${at.toISOString().slice(0, 13)}`,
            }).catch(() => { /* лента не заменит решение о блокировке */ });
          }
        }
      }
      return { ok: true, state, matched: result.matched, version: Number(rows[0].version) };
    },

    /**
     * Право написать новый отзыв: подтверждённый адрес и отметка сериала.
     *
     * Та же пара условий, что у оценки (EC-V1), и та же причина отказа:
     * читатель блока видит один текст, независимо от того, пришёл он
     * смотреть или отправлять.
     *
     * @param {number} userId
     * @param {number} seriesId
     * @returns {Promise<{ok: boolean, reason?: string}>}
     */
    async rightToWrite(userId, seriesId) {
      const { rows } = await pool.query(
        `SELECT u.email_confirmed,
                EXISTS (SELECT 1
                          FROM e_watch_mark m
                          JOIN e_episode e ON e.id = m.episode_id
                          JOIN e_season s ON s.id = e.season_id
                         WHERE m.user_id = $1 AND m.precision = 'exact'
                           AND s.series_id = $2) AS marked
           FROM e_user u WHERE u.id = $1`,
        [userId, seriesId],
      );
      const row = rows[0];
      if (!row) return { ok: false, reason: REASONS.NOT_CONFIRMED };
      if (!row.email_confirmed) return { ok: false, reason: REASONS.NOT_CONFIRMED };
      if (!row.marked) return { ok: false, reason: REASONS.NO_MARK };
      return { ok: true };
    },

    /**
     * Часовой лимит публикаций (R-MOD-10).
     *
     * Считаются строки материалов за последний час, а не только отзывы:
     * лимит общий для всех видов, иначе счёт разошёлся бы, когда появятся
     * комментарии и темы. Молодой аккаунт получает меньший потолок.
     *
     * Счёт идёт по `created_at` — первой подаче, а не по `submitted_at`:
     * правка не является новой публикацией и лимит не расходует (R-MOD-10).
     *
     * @param {number} userId
     * @param {Date} at
     * @returns {Promise<{ok:false, reason:string, retryAfterSec:number}|null>}
     */
    async overLimit(userId, at) {
      const { rows } = await pool.query(
        `SELECT u.registered_at,
                count(m.id)::int AS used,
                min(m.created_at) AS oldest
           FROM e_user u
           LEFT JOIN e_material m
             ON m.author_id = u.id AND m.state <> 'deleted'
            AND m.created_at > $2::timestamptz - interval '1 hour'
          WHERE u.id = $1
          GROUP BY u.registered_at`,
        [userId, at],
      );
      const row = rows[0];
      if (!row) return null;

      const ageH = (at.getTime() - new Date(row.registered_at).getTime()) / HOUR;
      const limit = ageH < MODERATION.youngAccountH
        ? MODERATION.materialsPerHourYoung
        : MODERATION.materialsPerHour;
      if (row.used < limit) return null;

      // Когда освободится место: самое старое из учтённых уходит из окна.
      const oldest = row.oldest ? new Date(row.oldest).getTime() : at.getTime();
      const retryAfterSec = Math.max(1, Math.ceil((oldest + HOUR - at.getTime()) / 1000));
      return { ok: false, reason: REASONS.LIMIT, retryAfterSec };
    },

    /**
     * Удаляет свой отзыв (F-04-04 §8ж). Оценка остаётся: это разные записи,
     * и человек, убравший текст, не теряет свою оценку.
     *
     * @param {{userId: number, seriesId: number}} input
     * @returns {Promise<boolean>} был ли отзыв
     */
    async deleteOwn({ userId, seriesId }) {
      const { rowCount } = await pool.query(
        `UPDATE e_material SET state = 'deleted'
          WHERE author_id = $1 AND series_id = $2 AND kind = 'review' AND state <> 'deleted'`,
        [userId, seriesId],
      );
      return rowCount > 0;
    },
  };
}
