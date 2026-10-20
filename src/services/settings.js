// Настройки сервиса: значения из базы поверх стартовых констант.
//
// Числа порогов живут в `src/config/settings.js` как стартовые значения, и
// до сих пор правка числа требовала правки кода и перезапуска. Настройка
// без права действовать — ловушка, поэтому значения читаются из базы, а
// константы остаются запасным вариантом: ключа нет — значит, работает
// стартовое значение.
//
// Значения перечитываются раз в минуту и обновляются на месте: те, кто
// меняет настройку, видят её в деле через минуту, а горячие пути не
// читают базу на каждый запрос.

import {
  UGC as UGC_DEFAULTS,
  RATING as RATING_DEFAULTS,
  REVIEW as REVIEW_DEFAULTS,
  MODERATION as MODERATION_DEFAULTS,
  ADMIN as ADMIN_DEFAULTS,
  AUTH as AUTH_DEFAULTS,
} from '../config/settings.js';

/** Стартовые значения, которые можно переопределить из базы. */
const DEFAULTS = {
  'rating.prior_weight_m': RATING_DEFAULTS.priorWeight,
  'rating.prior_mean_default': RATING_DEFAULTS.priorMeanDefault,
  'rating.min_votes_display': RATING_DEFAULTS.minVotesDisplay,
  'rating.min_account_age_h': RATING_DEFAULTS.minAccountAgeH,
  'rating.rate_per_hour': RATING_DEFAULTS.ratePerHour,
  'review.len_min': REVIEW_DEFAULTS.lenMin,
  'review.len_max': REVIEW_DEFAULTS.lenMax,
  'review.short_max_chars': REVIEW_DEFAULTS.shortMaxChars,
  'review.long_min_chars': REVIEW_DEFAULTS.longMinChars,
  'review.page_size': REVIEW_DEFAULTS.pageSize,
  'review.top_on_series_page': REVIEW_DEFAULTS.topOnSeriesPage,
  'review.read_more_chars': REVIEW_DEFAULTS.readMoreChars,
  'review.helpful_rate_per_hour': REVIEW_DEFAULTS.helpfulRatePerHour,
  'review.report_rate_per_day': REVIEW_DEFAULTS.reportRatePerDay,
  'ugc.topic_min_chars': UGC_DEFAULTS.topicMinChars,
  'ugc.topic_max_chars': UGC_DEFAULTS.topicMaxChars,
  'ugc.comment_max_chars': UGC_DEFAULTS.commentMaxChars,
  'ugc.guide_min_chars': UGC_DEFAULTS.guideMinChars,
  'ugc.guide_max_chars': UGC_DEFAULTS.guideMaxChars,
  'ugc.edits_per_day': UGC_DEFAULTS.editsPerDay,
  'ugc.link_forbidden': 1,
  'ugc.recheck_cooldown_min': 5,
  'mod.submission_rate_per_min': MODERATION_DEFAULTS.submissionRatePerMin,
  'mod.auto_block_share': MODERATION_DEFAULTS.autoBlockShare,
  'mod.cluster_window_h': MODERATION_DEFAULTS.clusterWindowH,
  'mod.cluster_min_size': MODERATION_DEFAULTS.clusterMinSize,
  'mod.queue_target_min': MODERATION_DEFAULTS.queueTargetMin,
  'admin.online_window_min': ADMIN_DEFAULTS.onlineWindowMin,
  'admin.online_avg_hours': ADMIN_DEFAULTS.onlineAvgHours,
  'admin.user_page_size': ADMIN_DEFAULTS.userPageSize,
  'admin.delete_grace_days': ADMIN_DEFAULTS.deleteGraceDays,
  'audit.retention_days': null,
  'backup.schedule': '03:30',
  'backup.keep_last': 7,
};

/**
 * Живые значения настроек.
 *
 * Объекты переиспользуются на месте: сервисы держат ссылку и видят новое
 * значение без перезапуска. Поэтому обновление — это Object.assign, а не
 * присваивание нового объекта: иначе держатели старой ссылки продолжили бы
 * работать со старыми числами.
 */
export const RATING = { ...RATING_DEFAULTS };
export const REVIEW = { ...REVIEW_DEFAULTS };
export const MODERATION = { ...MODERATION_DEFAULTS };
export const ADMIN = { ...ADMIN_DEFAULTS };
export const UGC = { ...UGC_DEFAULTS };
export const AUTH = { ...AUTH_DEFAULTS };

/** Все значения ключом — так их показывает экран настроек. */
export const RAW = { ...DEFAULTS };

/** Ключи, которые можно менять из экрана настроек. */
export const EDITABLE = Object.keys(DEFAULTS);

/**
 * Перечитать настройки из базы и обновить живые значения.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<number>} сколько ключей переопределено
 */
export async function loadSettings(pool) {
  const { rows } = await pool.query(
    "SELECT key, value FROM e_system_setting WHERE key = ANY($1::text[])",
    [EDITABLE],
  );
  const raw = { ...DEFAULTS };
  for (const row of rows) {
    if (!(row.key in DEFAULTS)) continue;
    const fallback = DEFAULTS[row.key];
    raw[row.key] = fallback === null || fallback === undefined
      ? row.value
      : castValue(row.value, fallback);
  }
  Object.assign(RAW, raw);

  Object.assign(RATING, {
    priorWeight: raw['rating.prior_weight_m'],
    priorMeanDefault: raw['rating.prior_mean_default'],
    minVotesDisplay: raw['rating.min_votes_display'],
    minAccountAgeH: raw['rating.min_account_age_h'],
    ratePerHour: raw['rating.rate_per_hour'],
  });
  Object.assign(REVIEW, {
    lenMin: raw['review.len_min'],
    lenMax: raw['review.len_max'],
    shortMaxChars: raw['review.short_max_chars'],
    longMinChars: raw['review.long_min_chars'],
    pageSize: raw['review.page_size'],
    topOnSeriesPage: raw['review.top_on_series_page'],
    readMoreChars: raw['review.read_more_chars'],
    helpfulRatePerHour: raw['review.helpful_rate_per_hour'],
    reportRatePerDay: raw['review.report_rate_per_day'],
  });
  Object.assign(MODERATION, {
    submissionRatePerMin: raw['mod.submission_rate_per_min'],
    autoBlockShare: raw['mod.auto_block_share'],
    clusterWindowH: raw['mod.cluster_window_h'],
    clusterMinSize: raw['mod.cluster_min_size'],
    queueTargetMin: raw['mod.queue_target_min'],
  });
  Object.assign(UGC, {
    topicMinChars: raw['ugc.topic_min_chars'],
    topicMaxChars: raw['ugc.topic_max_chars'],
    commentMaxChars: raw['ugc.comment_max_chars'],
    guideMinChars: raw['ugc.guide_min_chars'],
    guideMaxChars: raw['ugc.guide_max_chars'],
    editsPerDay: raw['ugc.edits_per_day'],
  });
  Object.assign(ADMIN, {
    onlineWindowMin: raw['admin.online_window_min'],
    onlineAvgHours: raw['admin.online_avg_hours'],
    userPageSize: raw['admin.user_page_size'],
    deleteGraceDays: raw['admin.delete_grace_days'],
  });
  return rows.length;
}

/**
 * Записать настройку и применить её.
 *
 * @param {import('pg').Pool} pool
 * @param {string} key
 * @param {string|number|null} value
 * @param {number|null} byId кто менял
 * @returns {Promise<boolean>}
 */
export async function setSetting(pool, key, value, byId = null) {
  if (!EDITABLE.includes(key)) return false;
  await pool.query(
    `INSERT INTO e_system_setting (key, value, changed_by, changed_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, changed_by = EXCLUDED.changed_by, changed_at = now()`,
    [key, String(value), byId],
  );
  await loadSettings(pool);
  return true;
}

/**
 * Привести строку к типу запасного значения.
 *
 * @param {string} value
 * @param {number|string|null} fallback
 * @returns {string|number|null}
 */
function castValue(value, fallback) {
  if (typeof fallback === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }
  return value;
}
