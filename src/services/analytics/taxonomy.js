// Таксономия событий (ANALYTICS §2, R-AN-01).
//
// Имя события — из закрытого списка: новое имя требует правки стандарта,
// иначе приёмник отвергнет событие молча, и таксономию нельзя будет
// починить (F-08-01 §8б).
//
// Свойства — из белого списка по имени события. Это защита от случайной
// утечки, а не от злоумысла (F-08-01 §8в): свойство не в списке означает,
// что событие отбрасывается целиком, а не чистится. Вычищенное событие
// вводит в заблуждение при анализе (EC-N1).
//
// Общие свойства (R-AN-02) задаёт приёмник: событие приходит без них, и
// сервер дописывает свои — время, адрес и то, что он знает о человеке.

/**
 * @typedef {object} EventSpec
 * @property {boolean} client событие приходит из браузера
 * @property {boolean} server событие пишет сервер
 * @property {string[]} props допустимые свойства события
 */

/**
 * События и их свойства.
 *
 * @type {Record<string, EventSpec>}
 */
export const EVENTS = {
  page_view: { client: true, server: false, props: ['page_type', 'series_id'] },
  splash_shown: { client: true, server: false, props: ['way', 'duration'] },
  splash_skipped: { client: true, server: false, props: ['way', 'duration'] },
  banner_impression: { client: true, server: false, props: ['position', 'reason'] },
  banner_click: { client: true, server: false, props: ['position', 'reason'] },
  poster_card_open: { client: true, server: false, props: ['way'] },
  search_submit: { client: true, server: false, props: ['length', 'results'] },
  search_no_results: { client: true, server: false, props: ['length'] },
  search_suggestion_click: { client: true, server: false, props: ['length'] },
  series_view: { client: true, server: false, props: ['source'] },
  status_set: { client: true, server: false, props: ['old', 'new'] },
  episode_mark: { client: true, server: false, props: ['precision', 'bulk'] },
  rating_set: { client: true, server: false, props: ['value', 'object'] },
  material_submit: { client: true, server: true, props: ['kind', 'result'] },
  flag_fix_attempt: { client: true, server: false, props: ['attempt'] },
  notification_open: { client: true, server: false, props: ['kind'] },
  calendar_view: { client: true, server: false, props: ['view', 'filter'] },
  reco_impression: { client: true, server: false, props: ['place', 'position', 'algorithm'] },
  reco_click: { client: true, server: false, props: ['place', 'position', 'algorithm'] },
  reco_dismiss: { client: true, server: false, props: ['place', 'position', 'algorithm'] },
  recap_open: { client: true, server: false, props: ['slide', 'period'] },
  recap_slide_view: { client: true, server: false, props: ['slide', 'period'] },
  recap_share: { client: true, server: false, props: ['slide', 'period'] },
  signup_step: { client: true, server: true, props: ['step'] },
  signup_complete: { client: true, server: true, props: ['step'] },
  login: { client: false, server: true, props: ['method', 'twofa'] },
  logout: { client: false, server: true, props: ['method', 'twofa'] },
  theme_toggle: { client: true, server: false, props: ['value'] },
  locale_switch: { client: true, server: false, props: ['value'] },
  client_error: { client: true, server: false, props: ['code', 'page'] },
  web_vitals: { client: true, server: false, props: ['lcp', 'inp', 'cls', 'page', 'device'] },
  moderation_decision: { client: false, server: true, props: ['decision', 'cluster', 'queue_time'] },
  spam_budget_hit: { client: false, server: true, props: ['limit'] },
  import_run_finished: { client: false, server: true, props: ['series', 'errors'] },
  notification_sent: { client: false, server: true, props: ['kind', 'channel'] },
  subscription_toggle: { client: true, server: false, props: ['kind', 'way'] },
  review_helpful_toggle: { client: true, server: false, props: ['action', 'review'] },
  review_report: { client: true, server: false, props: ['reason'] },
};

/**
 * События, которые считаются активностью (словарь метрик §3).
 *
 * Просмотр страницы сам по себе активностью не считается: человек мог
 * оставить вкладку открытой.
 *
 * @type {string[]}
 */
export const ACTIVE_EVENTS = [
  'status_set',
  'episode_mark',
  'rating_set',
  'material_submit',
  'reco_click',
  'banner_click',
];

/**
 * Имя события известно приёмнику?
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isKnownEvent(name) {
  return Object.prototype.hasOwnProperty.call(EVENTS, String(name ?? ''));
}

/**
 * Свойства события допустимы?
 *
 * @param {string} name
 * @param {string[]} props
 * @returns {boolean}
 */
export function propsAllowed(name, props) {
  const spec = EVENTS[String(name ?? '')];
  if (!spec) return false;
  return props.every((key) => spec.props.includes(key));
}
