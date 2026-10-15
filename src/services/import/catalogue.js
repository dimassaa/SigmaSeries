// Правила записи сериала в каталог: состояние выхода, полнота, адрес и
// группировка выходов (F-12-06 §4, §8; H-27, H-32, H-39, H-40;
// EC-D11, EC-D13).
//
// Модуль намеренно без SQL и без сети: это правила, которые должны читаться
// без открытия базы. Запись живёт в `write.js`.

/** Значения `e_series.exit_state`. */
export const RELEASE_STATE = {
  announced: 'announced',
  airing: 'airing',
  waiting: 'waiting',
  ended: 'ended',
  cancelled: 'cancelled',
};

/** Статус TMDB → состояние выхода (H-39). */
const STATE_BY_STATUS = {
  Ended: RELEASE_STATE.ended,
  Canceled: RELEASE_STATE.cancelled,
  'In Production': RELEASE_STATE.announced,
  Planned: RELEASE_STATE.announced,
  Pilot: RELEASE_STATE.announced,
  'Returning Series': RELEASE_STATE.waiting,
};

/** Выход не древнее этого числа дней считается свежим (H-39). */
export const RECENT_WINDOW_DAYS = 14;

export const DAY_MS = 86_400_000;

/** Причины по классам — порядок классов задан §8. */
export const REASON_CLASS = {
  no_tmdb: 'blocking',
  pair_doubt: 'blocking',
  no_genre: 'publication',
  no_poster: 'content',
  no_overview: 'content',
  no_overview_ru: 'content',
  no_people: 'content',
  no_backdrop: 'layout',
  schedule_gap: 'layout',
  new_genre: 'service',
  no_age: 'info',
};

/**
 * Состояние выхода: сначала даты, потом статус (H-39, H-40).
 *
 * Порядок здесь — не украшение. Статус TMDB обновляется раз в день и о
 * наборе новых дат не знает, поэтому «Returning Series» с назначенной датой
 * на прошлой неделе должен быть «Выходит», а не «ждёт сезон».
 *
 * @param {object} options
 * @param {object} options.raw сырой слой сериала
 * @param {Date} [options.today]
 * @returns {string} значение `e_series.exit_state`
 */
export function computeExitState({ raw, today = new Date() }) {
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const horizon = todayUtc - RECENT_WINDOW_DAYS * DAY_MS;

  const dated = [raw?.nextEpisode?.date, raw?.lastEpisode?.date].filter(Boolean).sort();
  for (const value of dated) {
    const time = Date.parse(`${value}T00:00:00Z`);
    if (Number.isFinite(time) && time >= horizon) return RELEASE_STATE.airing;
  }

  if (raw?.status && STATE_BY_STATUS[raw.status]) return STATE_BY_STATUS[raw.status];

  // Статуса нет или он незнакомый: год IMDb — единственное, что осталось
  // (H-40). Неизвестный статус даёт «ждёт сезон», а не «анонс»: анонс
  // попадает в выдачу как утверждение, которого никто не проверял.
  return raw?.years?.end ? RELEASE_STATE.ended : RELEASE_STATE.waiting;
}

/**
 * Причины неполноты и уровень карточки (§8).
 *
 * @param {object} options
 * @param {object} options.raw
 * @param {{poster?:boolean, backdrop?:boolean}} [options.images]
 * @param {Date} [options.now]
 * @param {string[]} [options.unchecked] коды, которых этот прогон не проверял:
 *   они не добавляются, но и не исчезают — см. `carryOverReasons`
 * @returns {{reasons: string[], level: 'full'|'displayable'|'minimum'}}
 */
export function computeCompleteness({ raw, images = {}, now = new Date(), unchecked = [] }) {
  const reasons = [];
  const skip = new Set(unchecked);
  const add = (code) => {
    if (skip.has(code)) return;
    if (!reasons.includes(code)) reasons.push(code);
  };

  const hasTitle = Boolean(raw?.titles?.original?.text || raw?.titles?.ru?.text || raw?.titles?.en?.text);
  if (!hasTitle) add('no_tmdb');
  if (!raw?.tmdbId) add('no_tmdb');
  // Жанры приходят из IMDb, а у новинок без IMDb-идентификатора — из TMDB
  // (см. `genresFor` в write.js). Отсутствие жанров в обоих источниках —
  // вот настоящая причина `no_genre`.
  const genres = raw?.imdbGenres?.length ? raw.imdbGenres : (raw?.genres ?? []).map((g) => g.name);
  if (!genres.length) add('no_genre');
  if (!images.poster) add('no_poster');
  if (!raw?.descriptions?.ru?.text && !raw?.descriptions?.en?.text) add('no_overview');
  // `no_overview_ru` — это «русского нет, английский есть»: показать можно,
  // но полной карточка не станет — уровень «полная» требует русского описания.
  if (!raw?.descriptions?.ru?.text && raw?.descriptions?.en?.text) add('no_overview_ru');
  if (!images.backdrop) add('no_backdrop');
  if (!raw?.ageRating) add('no_age');

  const hasPeople = Boolean(raw?.people?.directors?.length || raw?.people?.cast?.length);
  if (!hasPeople) add('no_people');

  // «Ждём сезон» без дат — норма, а не дефект: причина `schedule_gap`
  // относится только к тем, кто выходит, но расписание у него неполное.
  if (raw?.status === 'Returning Series' && hasGaps(raw, now)) add('schedule_gap');

  return { reasons, level: levelOf(reasons) };
}

/**
 * Есть ли в последнем сезоне серия без даты, когда сериал выходит.
 *
 * @param {object} raw
 * @param {Date} now
 * @returns {boolean}
 */
function hasGaps(raw, now) {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const airing = computeExitState({ raw, today: new Date(todayUtc) }) === RELEASE_STATE.airing;
  if (!airing) return false;
  const seasons = raw?.seasons ?? [];
  if (!seasons.length) return false;
  const last = seasons[seasons.length - 1];
  return (last.episodes ?? []).some((episode) => !episode.date);
}

/**
 * Уровень карточки по набору причин (§8).
 *
 * Уровни не выводятся из класса причины напрямую, а различают, ЧТО именно
 * не хватает: без постера или без описания карточка не «пригодна к показу»,
 * а вот без людей или без фона она показывается вполне нормально — просто не
 * «полная». Сведение «содержания» и «размещения» в одну корзину опустило бы
 * половину каталога на уровень ниже нужного.
 *
 * `no_age` и `new_genre` уровня не трогают (EC-D13): одна отсутствующая
 * возрастная метка не делает карточку неполной.
 *
 * @param {string[]} reasons
 * @returns {'full'|'displayable'|'minimum'}
 */
export function levelOf(reasons) {
  const has = (codes) => reasons.some((code) => codes.has(code));

  // Блокирующие и те, что опускают до минимума, — результат один.
  if (has(MINIMUM_ONLY) || has(BLOCKING)) return 'minimum';
  // Остальное мешает только «полной».
  if (has(PREVENTS_FULL)) return 'displayable';
  return 'full';
}

const BLOCKING = new Set(['no_tmdb', 'pair_doubt', 'no_genre']);
const MINIMUM_ONLY = new Set(['no_poster', 'no_overview']);
const PREVENTS_FULL = new Set(['no_overview_ru', 'no_backdrop', 'schedule_gap', 'no_people']);

/**
 * Возвращает непроверенные коды из прежнего списка причин.
 *
 * Ночной прогон (F-12-07) перечитывает расписание и детали, но не качает людей
 * из датасета IMDb. Без этого переноса каждый активный сериал за одну ночь
 * получал бы причину `no_people` и падал с «полной» до «минимума» — из-за
 * того, чего прогон не смотрел, а не из-за данных.
 *
 * @param {string[]} reasons коды, найденные этим прогоном
 * @param {string[]} previous коды, записанные ранее
 * @param {string[]} unchecked коды, которых этот прогон не проверял
 * @returns {string[]} полный список причин
 */
export function carryOverReasons(reasons, previous = [], unchecked = []) {
  const out = [...reasons];
  for (const code of previous) {
    if (!unchecked.includes(code) || out.includes(code)) continue;
    out.push(code);
  }
  return out;
}

/**
 * Адрес сериала (H-32).
 *
 * Создаётся один раз и дальше меняется только админом, поэтому «занято» решается
 * добавлением года, затем `tconst`, а не случайным суффиксом: адрес из отчёта
 * должен оставаться верным.
 *
 * @param {object} options
 * @param {string} options.title название, из которого строится адрес
 * @param {number|null} options.year
 * @param {string} options.tconst
 * @param {Set<string>|string[]} options.taken занятые адреса
 * @param {string} [options.fallback] латинское название, если основное кириллическое
 * @returns {string}
 */
export function slugFor({ title, year, tconst, taken = new Set(), fallback = '' }) {
  const busy = taken instanceof Set ? taken : new Set(taken);
  const translit = (value) => value
    .normalize('NFKD')
    // Кириллица в NFKD не разворачивается в латиницу, поэтому таблица живёт
    // здесь, а латинские диакритики убираются. Ключ ищется в нижнем регистре:
    // без этого «Во все тяжкие» теряло первую букву.
    .replace(/[Ѐ-ӿ]/g, (ch) => CYRILLIC[ch.toLowerCase()] ?? '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  const base = translit(title) || translit(fallback) || '';
  if (!base) return `tt${String(tconst).replace(/^tt/, '')}`;

  if (!busy.has(base)) return base;
  // У человека года нет, поэтому шаг с годом пропускается: иначе адрес получил
  // бы вид «akter-x», а это читается как опечатка, а не как разрешение коллизии.
  if (year) {
    const withYear = `${base}-${year}`;
    if (!busy.has(withYear)) return withYear;
  }
  const withId = `${year ? `${base}-${year}` : base}-${tconst}`;
  let candidate = withId;
  let counter = 2;
  while (busy.has(candidate)) {
    candidate = `${withId}-${counter}`;
    counter += 1;
  }
  return candidate;
}

/** Кириллица → латиница. Смысл ровно один: адрес сериала. */
const CYRILLIC = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Выходы сезона: серии с одной датой образуют один (EC-D11).
 *
 * @param {object} season
 * @returns {{date: string, episodeNumbers: number[]}[]}
 */
export function groupReleases(season) {
  const byDate = new Map();
  for (const episode of season?.episodes ?? []) {
    if (!episode.date) continue;
    // Не-дата сюда не попадает: битое значение источника должно тихо
    // остаться без выхода, а не уронить запись каталога.
    const time = Date.parse(`${episode.date}T00:00:00Z`);
    if (!Number.isFinite(time)) continue;
    if (!byDate.has(episode.date)) byDate.set(episode.date, []);
    byDate.get(episode.date).push(episode.number);
  }

  return [...byDate.entries()]
    .map(([date, episodeNumbers]) => ({ date, episodeNumbers: episodeNumbers.sort((a, b) => a - b) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}