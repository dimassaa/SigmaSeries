// Словарь метрик и их значения (M8, F-08-02, F-08-03).
//
// У каждой метрики есть определение, формула, источник, пример с числами и
// известные искажения: «пользователей 128» без этого значит четыре разные
// вещи у четырёх людей (F-08-02 §8а).
//
// Определение версионируется: изменение формулы не переписывает историю,
// старые периоды остаются посчитанными по старому правилу, и в карточке
// метрики это написано (F-08-02 §8в, EC-N4).
//
// Демо и реальные не смешиваются ни в одной метрике (R-AN-11): демо-событие
// помечено, и фильтр «исключить демо» включён по умолчанию.

import pg from 'pg';

import { ANALYTICS } from '../../config/settings.js';
import { ACTIVE_EVENTS } from './taxonomy.js';

/**
 * @typedef {object} Metric
 * @property {string} key ключ метрики
 * @property {string} titleRu название по-русски
 * @property {string} titleEn название по-английски
 * @property {string} definitionRu определение по-русски
 * @property {string} definitionEn определение по-английски
 * @property {string} formula формула
 * @property {string} source источник данных
 * @property {string} exampleRu пример с числами
 * @property {string} exampleEn пример с числами
 * @property {string[]} distortionsRu известные искажения
 * @property {string[]} distortionsEn известные искажения
 * @property {string} version версия определения
 * @property {string} changedAt дата изменения версии
 */

/**
 * Словарь метрик (ANALYTICS §3).
 *
 * @type {Metric[]}
 */
export const METRICS = [
  {
    key: 'active_users',
    titleRu: 'Активные пользователи',
    titleEn: 'Active users',
    definitionRu: 'Уникальные псевдонимы с «значимым» событием: отметка, статус, оценка, материал, клик по баннеру или рекомендации. Просмотр страницы сам по себе активностью не считается.',
    definitionEn: 'Unique pseudonyms with a “meaningful” event: a mark, a status, a rating, a post, a banner or recommendation click. A page view alone is not activity.',
    formula: 'count(distinct user_pseudo_id)',
    source: 'e_event, ts_server',
    exampleRu: 'За сутки — столько уникальных псевдонимов, сколько было значимых событий; демо-события исключены по умолчанию.',
    exampleEn: 'For a day — as many unique pseudonyms as there were meaningful events; demo events are excluded by default.',
    distortionsRu: [
      'Не различает человека, который смотрит сериал, и человека, оставившего вкладку открытой',
      'Не учитывает гостей без событий',
    ],
    distortionsEn: [
      'Does not tell a person watching from a person who left the tab open',
      'Does not count guests without events',
    ],
    version: '1',
    changedAt: '2026-10-21',
  },
  {
    key: 'signups',
    titleRu: 'Новые пользователи',
    titleEn: 'New users',
    definitionRu: 'Событие «регистрация завершена» — сколько человек завело аккаунт.',
    definitionEn: 'The “sign-up completed” event — how many people created an account.',
    formula: 'count(*) where name = signup_complete',
    source: 'e_event, ts_server',
    exampleRu: 'За неделю — число завершённых регистраций; событие пишет сервер, подделать его из браузера нельзя.',
    exampleEn: 'For a week — the number of completed sign-ups; the server writes the event, so a browser cannot forge it.',
    distortionsRu: ['Считает создание аккаунта, а не первую активность'],
    distortionsEn: ['Counts account creation, not first activity'],
    version: '1',
    changedAt: '2026-10-21',
  },
  {
    key: 'activation',
    titleRu: 'Активация',
    titleEn: 'Activation',
    definitionRu: 'Доля новых пользователей, отметивших серию или поставивших статус в течение семи дней после регистрации.',
    definitionEn: 'The share of new users who marked a series or set a status within seven days of signing up.',
    formula: 'count(distinct activated) / count(distinct signed_up)',
    source: 'e_event, ts_server',
    exampleRu: 'Из ста зарегистрировавшихся активировались семьдесят четыре.',
    exampleEn: 'Out of a hundred sign-ups, seventy-four activated.',
    distortionsRu: ['Отметка ретро-сетом тоже считается активацией, хотя человек не выбирал сериал'],
    distortionsEn: ['A retro mark counts as activation even though the person picked nothing'],
    version: '1',
    changedAt: '2026-10-21',
  },
  {
    key: 'tracked_per_user',
    titleRu: 'Отслеживаемых сериалов на пользователя',
    titleEn: 'Tracked series per user',
    definitionRu: 'Сколько сериалов у человека со статусом «Смотрю» или «В планах».',
    definitionEn: 'How many series a person has with the status “watching” or “planned”.',
    formula: 'count(e_watch_status) / count(distinct user)',
    source: 'e_watch_status',
    exampleRu: 'Считается по всем, у кого есть статус, а не только по тем, кто смотрит прямо сейчас.',
    exampleEn: 'Counts everyone with a status, not only those watching right now.',
    distortionsRu: ['Статус «В планах» годами стоит на одном сериале и завышает число'],
    distortionsEn: ['A “planned” status can sit on one series for years and inflate the number'],
    version: '1',
    changedAt: '2026-10-21',
  },
  {
    key: 'north_star',
    titleRu: 'Отметок на активного пользователя в неделю',
    titleEn: 'Marks per active user per week',
    definitionRu: 'Сколько отметок приходится на одного активного пользователя за неделю.',
    definitionEn: 'How many marks fall on one active user per week.',
    formula: 'count(episode_mark) / count(distinct active)',
    source: 'e_event, ts_server',
    exampleRu: 'Значение помечено как гипотеза: подтверждается замерами, а не правдой.',
    exampleEn: 'The value is marked as a hypothesis: it is confirmed by measurements, not taken as true.',
    distortionsRu: ['Ретро-отметки не считаются, хотя человек отметил сразу двадцать серий'],
    distortionsEn: ['Retro marks are not counted, though the person marked twenty series at once'],
    version: '1',
    changedAt: '2026-10-21',
  },
  {
    key: 'retention',
    titleRu: 'Удержание',
    titleEn: 'Retention',
    definitionRu: 'Доля когорты (по неделе регистрации), снова активной через неделю, две и четыре.',
    definitionEn: 'The share of a cohort (by sign-up week) active again after one, two and four weeks.',
    formula: 'count(distinct active in week N) / count(distinct signed up)',
    source: 'e_event, ts_server',
    exampleRu: 'Когорта — люди, зарегистрировавшиеся в одну неделю; сравниваются по активности в следующие.',
    exampleEn: 'A cohort is the people who signed up in one week; they are compared by later activity.',
    distortionsRu: ['Когорты меньше тридцати человек показывают шум, и это написано рядом'],
    distortionsEn: ['Cohorts under thirty people show noise, and that is written next to them'],
    version: '1',
    changedAt: '2026-10-21',
  },
  {
    key: 'banner_ctr',
    titleRu: 'CTR баннеров',
    titleEn: 'Banner CTR',
    definitionRu: 'Доля показов баннера, после которых по нему перешли.',
    definitionEn: 'The share of banner impressions followed by a click.',
    formula: 'count(banner_click) / count(banner_impression)',
    source: 'e_event, ts_server',
    exampleRu: 'Считается по парам показов и кликов за один период.',
    exampleEn: 'Counted over impressions and clicks within one period.',
    distortionsRu: ['Показ считается, когда карточка появилась, а не когда её увидели'],
    distortionsEn: ['An impression is counted when the card appeared, not when it was seen'],
    version: '1',
    changedAt: '2026-10-21',
  },
  {
    key: 'reco_ctr',
    titleRu: 'CTR рекомендаций',
    titleEn: 'Recommendation CTR',
    definitionRu: 'Доля показов рекомендации, после которых по ней перешли.',
    definitionEn: 'The share of recommendation impressions followed by a click.',
    formula: 'count(reco_click) / count(reco_impression)',
    source: 'e_event, ts_server',
    exampleRu: 'Показ — позиция в строке «для вас» или в «похожих».',
    exampleEn: 'An impression is a position in the “for you” or “similar” row.',
    distortionsRu: ['Показ без клика засчитывается и при уходе со страницы'],
    distortionsEn: ['An impression without a click is counted even when the person left the page'],
    version: '1',
    changedAt: '2026-10-21',
  },
  {
    key: 'first_pass',
    titleRu: 'Прошли с первого раза',
    titleEn: 'Passed first time',
    definitionRu: 'Доля материалов, опубликованных без помеченности модерацией.',
    definitionEn: 'The share of materials published without being flagged by moderation.',
    formula: 'count(material_submit where result = published) / count(material_submit)',
    source: 'e_event, ts_server',
    exampleRu: 'Считается по всем отправкам, а не по опубликованным.',
    exampleEn: 'Counted over all submissions, not only the published ones.',
    distortionsRu: ['Материал может быть помечен позже — тогда доля занижена'],
    distortionsEn: ['A material may be flagged later — then the share is understated'],
    version: '1',
    changedAt: '2026-10-21',
  },
  {
    key: 'moderation_queue',
    titleRu: 'Время в очереди модерации',
    titleEn: 'Time in the moderation queue',
    definitionRu: 'Медиана и девяностый процентиль времени от появления материала в очереди до решения редактора.',
    definitionEn: 'The median and the ninetieth percentile of the time from a material entering the queue to an editor’s decision.',
    formula: 'percentile_cont(moderation_decision.queue_time)',
    source: 'e_event, ts_server',
    exampleRu: 'Время считается в минутах и показывается двумя числами.',
    exampleEn: 'The time is in minutes and shown as two numbers.',
    distortionsRu: ['Материал, оставшийся без решения, в медиану не попадает'],
    distortionsEn: ['A material left without a decision does not enter the median'],
    version: '1',
    changedAt: '2026-10-21',
  },
  {
    key: 'search_no_results',
    titleRu: 'Поиск без результата',
    titleEn: 'Search without results',
    definitionRu: 'Доля поисковых запросов, не найдящих ни одного сериала.',
    definitionEn: 'The share of searches that found no series at all.',
    formula: 'count(search_no_results) / count(search_submit)',
    source: 'e_event, ts_server',
    exampleRu: 'Тексты запросов не хранятся: отчёт строится из агрегатов по длине и числу результатов (R-AN-19).',
    exampleEn: 'Search texts are not stored: the report is built from aggregates over length and result count (R-AN-19).',
    distortionsRu: ['Запрос с опечаткой считается так же, как запрос несуществующего сериала'],
    distortionsEn: ['A typo is counted like a search for a series that does not exist'],
    version: '1',
    changedAt: '2026-10-21',
  },
  {
    key: 'false_positives',
    titleRu: 'Ложные срабатывания',
    titleEn: 'False positives',
    definitionRu: 'Сколько слов редактор вернул в белый список за период: каждое такое слово — ложное срабатывание, измеренное фактом возврата, а не самооценкой.',
    definitionEn: 'How many words an editor returned to the allow list within the period: each one is a false positive, measured by the fact of the return and not by self-assessment.',
    formula: 'count(e_dictionary_word where list = allow and added_at in period)',
    source: 'e_dictionary_word',
    exampleRu: 'Считаются слова, добавленные в белый список за период; слово, добавленное давно, в счёт не попадает.',
    exampleEn: 'Only the words added to the allow list within the period are counted; an old word is not.',
    distortionsRu: ['Считаются все добавленные слова, а не те, что сработали на реальном материале'],
    distortionsEn: ['Counts every added word, not only those that fired on a real material'],
    version: '1',
    changedAt: '2026-10-21',
  },
  {
    key: 'vitals',
    titleRu: 'Показатели скорости',
    titleEn: 'Speed metrics',
    definitionRu: 'p75 LCP, INP и CLS по страницам и устройствам.',
    definitionEn: 'p75 LCP, INP and CLS by page and device.',
    formula: 'percentile_cont(0.75)',
    source: 'e_event (web_vitals)',
    exampleRu: 'Считается по событиям web_vitals, которые браузер присылает сам.',
    exampleEn: 'Counted over web_vitals events the browser sends itself.',
    distortionsRu: ['Событие приходит только при загрузке страницы: долгий сеанс без загрузок не виден'],
    distortionsEn: ['The event arrives only on page load: a long session without loads is invisible'],
    version: '1',
    changedAt: '2026-10-21',
  },
];

/**
 * Метрика по ключу.
 *
 * @param {string} key
 * @returns {Metric|null}
 */
export function metricOf(key) {
  return METRICS.find((metric) => metric.key === key) ?? null;
}

/**
 * Значения метрик и агрегаты (M8, F-08-03…F-08-05).
 *
 * @param {pg.Pool} pool
 */
export function pgAnalyticsMetrics(pool) {
  /** @type {Map<string, {at: number, value: any}>} */
  const cache = new Map();

  /**
   * Число событий по имени за период.
   *
   * @param {string} name
   * @param {number} hours период в часах
   * @param {boolean} excludeDemo
   * @returns {Promise<number>}
   */
  async function countEvents(name, hours, excludeDemo) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n
         FROM e_event
        WHERE name = $1 AND ts_server > now() - ($2 || ' hours')::interval
          AND ($3::boolean IS FALSE OR is_demo = FALSE)`,
      [name, String(hours), excludeDemo],
    );
    return Number(rows[0].n);
  }

  /**
   * Активные пользователи за период.
   *
   * @param {number} hours
   * @param {boolean} excludeDemo
   * @returns {Promise<number>}
   */
  async function activeUsers(hours, excludeDemo) {
    const { rows } = await pool.query(
      `SELECT count(DISTINCT user_pseudo_id)::int AS n
         FROM e_event
        WHERE name = ANY($1::text[])
          AND ts_server > now() - ($2 || ' hours')::interval
          AND user_pseudo_id IS NOT NULL
          AND ($3::boolean IS FALSE OR is_demo = FALSE)`,
      [ACTIVE_EVENTS, String(hours), excludeDemo],
    );
    return Number(rows[0].n);
  }

  /**
   * Обзор: пять крупных чисел и два графика.
   *
   * @param {{hours?: number, excludeDemo?: boolean}} [options]
   * @returns {Promise<any>}
   */
  async function overview({ hours = 24, excludeDemo = true } = {}) {
    const key = `overview:${hours}:${excludeDemo}`;
    const fresh = cache.get(key);
    if (fresh && Date.now() - fresh.at < ANALYTICS.dashboardCacheS * 1000) return fresh.value;

    const [active, signups, reviews, catalogue, flagged, byHour, byDay] = await Promise.all([
      activeUsers(hours, excludeDemo),
      countEvents('signup_complete', hours, excludeDemo),
      countEvents('material_submit', hours, excludeDemo),
      catalogueSeries(),
      flaggedShare(),
      seriesByHour(hours, excludeDemo),
      seriesByDay(hours, excludeDemo),
    ]);

    const value = {
      hours,
      excludeDemo,
      demoShare: await demoShare(hours),
      numbers: [
        { key: 'active_users', value: active, metric: 'active_users' },
        { key: 'signups', value: signups, metric: 'signups' },
        { key: 'catalogue', value: catalogue, metric: null },
        { key: 'reviews', value: reviews, metric: 'first_pass' },
        { key: 'flagged', value: flagged, metric: 'first_pass' },
      ],
      graphs: [
        { key: 'active_by_hour', titleRu: 'Активные по часам', titleEn: 'Active by hour', points: byHour },
        { key: 'signups_by_day', titleRu: 'Регистрации по дням', titleEn: 'Sign-ups by day', points: byDay },
      ],
    };
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * Сколько сериалов в каталоге.
   *
   * Сериалы не помечены как демо: метка стоит на событиях и оценках, а
   * каталог один и тот же для всех.
   *
   * @returns {Promise<number>}
   */
  async function catalogueSeries() {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM e_series
        WHERE publication_state = 'published' AND archived_at IS NULL`,
    );
    return Number(rows[0].n);
  }

  /**
   * Доля помеченных модерацией.
   *
   * @returns {Promise<number>}
   */
  async function flaggedShare() {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM e_material WHERE state = 'flagged') AS flagged,
         (SELECT count(*)::int FROM e_material
            WHERE kind IN ('review','guide','topic') AND state <> 'draft') AS total`,
    );
    const total = Number(rows[0].total) || 1;
    return Math.round((Number(rows[0].flagged) / total) * 1000) / 10;
  }

  /**
   * Доля демо среди событий.
   *
   * @param {number} hours
   * @returns {Promise<number>}
   */
  async function demoShare(hours) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE is_demo)::int AS demo
         FROM e_event
        WHERE ts_server > now() - ($1 || ' hours')::interval`,
      [String(hours)],
    );
    const total = Number(rows[0].total) || 1;
    const demo = Number(rows[0].demo);
    const share = Math.round((demo / total) * 1000) / 10;
    // Один демо-событие среди тысяч обычных — это не «0,0 %»: полоса должна
    // показать, что демо-данные есть, иначе проверка «доля посчитана» врёт.
    return demo > 0 && share === 0 ? 0.1 : share;
  }

  /**
   * Активные по часам суток: только значимые события, просмотр страницы
   * активностью не считается.
   *
   * @param {number} hours
   * @param {boolean} excludeDemo
   * @returns {Promise<any[]>}
   */
  async function seriesByHour(hours, excludeDemo) {
    const { rows } = await pool.query(
      `SELECT EXTRACT(HOUR FROM ts_server)::int AS hour, count(*)::int AS n
         FROM e_event
        WHERE name = ANY($3::text[])
          AND ts_server > now() - ($1 || ' hours')::interval
          AND ($2::boolean IS FALSE OR is_demo = FALSE)
        GROUP BY hour ORDER BY hour`,
      [String(hours), excludeDemo, ACTIVE_EVENTS],
    );
    return rows.map((row) => ({ label: String(row.hour), value: Number(row.n) }));
  }

  /**
   * События по дням.
   *
   * @param {number} hours
   * @param {boolean} excludeDemo
   * @returns {Promise<any[]>}
   */
  async function seriesByDay(hours, excludeDemo) {
    const { rows } = await pool.query(
      `SELECT (ts_server AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS n
         FROM e_event
        WHERE name = 'signup_complete'
          AND ts_server > now() - ($1 || ' hours')::interval
          AND ($2::boolean IS FALSE OR is_demo = FALSE)
        GROUP BY day ORDER BY day`,
      [String(hours), excludeDemo],
    );
    return rows.map((row) => ({ label: row.day, value: Number(row.n) }));
  }

  /**
   * Воронка: визит → регистрация → активация → активность на второй неделе.
   *
   * @param {{hours?: number, excludeDemo?: boolean}} [options]
   * @returns {Promise<any[]>}
   */
  async function funnel({ hours = 168, excludeDemo = true } = {}) {
    const [visits, signups, activation, week2] = await Promise.all([
      countEvents('page_view', hours, excludeDemo),
      countEvents('signup_complete', hours, excludeDemo),
      countEvents('episode_mark', hours, excludeDemo),
      countEvents('status_set', hours, excludeDemo),
    ]);
    return [
      { key: 'visit', value: visits },
      { key: 'signup', value: signups },
      { key: 'activation', value: activation },
      { key: 'week2', value: week2 },
    ];
  }

  /**
   * Качество модерации: помечено, разобрано, возвращено в белый список.
   *
   * @param {{hours?: number, excludeDemo?: boolean}} [options]
   * @returns {Promise<any>}
   */
  async function moderation({ hours = 168, excludeDemo = true } = {}) {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM e_material m
            JOIN e_user u ON u.id = m.author_id
           WHERE m.state = 'flagged'
             AND m.submitted_at > now() - ($1 || ' hours')::interval
             AND ($2::boolean IS FALSE OR u.is_demo = FALSE)) AS flagged,
         (SELECT count(*)::int FROM e_material m
            JOIN e_user u ON u.id = m.author_id
           WHERE m.state IN ('published','approved','rejected')
             AND m.submitted_at > now() - ($1 || ' hours')::interval
             AND ($2::boolean IS FALSE OR u.is_demo = FALSE)) AS decided,
         (SELECT count(*)::int FROM e_editor_decision d
            JOIN e_material m ON m.id = d.material_id
            JOIN e_user u ON u.id = m.author_id
           WHERE d.decided_at > now() - ($1 || ' hours')::interval
             AND ($2::boolean IS FALSE OR u.is_demo = FALSE)) AS decisions,
         (SELECT count(*)::int FROM e_dictionary_word
            WHERE list = 'allow' AND added_at > now() - ($1 || ' hours')::interval) AS fixed`,
      [String(hours), excludeDemo],
    );
    const flagged = Number(rows[0].flagged) || 1;
    return {
      flagged: Number(rows[0].flagged),
      decided: Number(rows[0].decided),
      decisions: Number(rows[0].decisions),
      falsePositive: Math.round((Number(rows[0].fixed) / flagged) * 1000) / 10,
    };
  }

  /**
   * Поиск: запросов, без результата, средняя длина.
   *
   * @param {{hours?: number, excludeDemo?: boolean}} [options]
   * @returns {Promise<any>}
   */
  async function search({ hours = 168, excludeDemo = true } = {}) {
    const [submits, empty, avgLength] = await Promise.all([
      countEvents('search_submit', hours, excludeDemo),
      countEvents('search_no_results', hours, excludeDemo),
      avgSearchLength(hours, excludeDemo),
    ]);
    return {
      submits,
      empty,
      emptyShare: submits ? Math.round((empty / submits) * 1000) / 10 : 0,
      avgLength,
    };
  }

  /**
   * Средняя длина запроса — из агрегата, тексты не хранятся (R-AN-19).
   *
   * @param {number} hours
   * @param {boolean} excludeDemo
   * @returns {Promise<number>}
   */
  async function avgSearchLength(hours, excludeDemo) {
    const { rows } = await pool.query(
      `SELECT coalesce(avg((props->>'length')::float), 0)::float AS n
         FROM e_event
        WHERE name = 'search_submit'
          AND ts_server > now() - ($1 || ' hours')::interval
          AND ($2::boolean IS FALSE OR is_demo = FALSE)`,
      [String(hours), excludeDemo],
    );
    return Math.round(Number(rows[0].n) * 10) / 10;
  }

  /**
   * Показатели скорости: p75 по трём метрикам.
   *
   * @param {{hours?: number, excludeDemo?: boolean}} [options]
   * @returns {Promise<any>}
   */
  async function vitals({ hours = 168, excludeDemo = true } = {}) {
    const { rows } = await pool.query(
      `SELECT
         percentile_cont(0.75) WITHIN GROUP (ORDER BY (props->>'lcp')::float) AS lcp,
         percentile_cont(0.75) WITHIN GROUP (ORDER BY (props->>'inp')::float) AS inp,
         percentile_cont(0.75) WITHIN GROUP (ORDER BY (props->>'cls')::float) AS cls
        FROM e_event
       WHERE name = 'web_vitals'
         AND ts_server > now() - ($1 || ' hours')::interval
         AND ($2::boolean IS FALSE OR is_demo = FALSE)`,
      [String(hours), excludeDemo],
    );
    const row = rows[0] ?? {};
    return {
      lcp: Math.round(Number(row.lcp ?? 0)),
      inp: Math.round(Number(row.inp ?? 0)),
      cls: Math.round(Number(row.cls ?? 0) * 1000) / 1000,
    };
  }

  /**
   * Отказы приёма — видно на обзоре (F-08-01 §8д).
   *
   * @returns {Promise<any[]>}
   */
  async function rejects() {
    const { rows } = await pool.query(
      `SELECT name, reason, day::text AS day, count
         FROM e_event_reject
        WHERE day > current_date - 7
        ORDER BY count DESC LIMIT 20`,
    );
    return rows.map((row) => ({
      name: row.name,
      reason: row.reason,
      day: row.day,
      count: Number(row.count),
    }));
  }

  return {
    overview,
    funnel,
    moderation,
    search,
    vitals,
    rejects,
    metrics: METRICS,
  };
}
