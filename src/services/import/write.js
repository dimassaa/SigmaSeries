// Запись сериала в каталог (F-12-06 §4).
//
// Правила вынесены в `catalogue.js`, а этот модуль превращает сырой слой в
// строки базы. Ключевые свойства:
//
//   • всё внутри одной транзакции на сериал: сбой одного не оставляет
//     половину карточки (F-12-06 §5);
//   • поля из `e_field_lock` не трогаются — ручная правка переживает импорт
//     (EC-D8), и «переживает» здесь означает «не перезаписывается», а не
//     «совпадает по значению»;
//   • повторный прогон идемпотентен: сериал, сезон, серия и выход опознаются по
//     ключам, а не создаются заново.

import {
  computeExitState,
  computeCompleteness,
  carryOverReasons,
  levelOf,
  groupReleases,
  slugFor,
} from './catalogue.js';

/**
 * Справочник жанров: имя IMDb → [код, русское название].
 *
 * Переводы — стартовое наполнение, их правят в студии (F-10-03): «Action &
 * Adventure» читается и как «Приключения», и как «Боевик», и это решение
 * редактора, а не импорта. Неизвестный IMDb-жанр создаёт скрытую запись
 * справочника и попадает в отчёт как `new_genre` (§4(3)): выбросить его
 * молча нельзя, а придумать перевод — тоже.
 */
export const GENRE_DICTIONARY = {
  Action: ['action', 'Боевик'],
  Adventure: ['adventure', 'Приключения'],
  Animation: ['animation', 'Мультфильм'],
  Biography: ['biography', 'Биография'],
  Comedy: ['comedy', 'Комедия'],
  Crime: ['crime', 'Криминал'],
  Documentary: ['documentary', 'Документальный'],
  Drama: ['drama', 'Драма'],
  Family: ['family', 'Семейный'],
  Fantasy: ['fantasy', 'Фэнтези'],
  History: ['history', 'История'],
  Horror: ['horror', 'Ужасы'],
  Music: ['music', 'Музыка'],
  Mystery: ['mystery', 'Детектив'],
  Romance: ['romance', 'Романтика'],
  'Sci-Fi': ['sci-fi', 'Фантастика'],
  Sport: ['sport', 'Спорт'],
  'Talk-Show': ['talk-show', 'Ток-шоу'],
  Thriller: ['thriller', 'Триллер'],
  War: ['war', 'Военный'],
  Western: ['western', 'Вестерн'],
};

/** Код жанра из словаря; для неизвестного — код от самого имени IMDb. */
export function genreCode(name) {
  const known = GENRE_DICTIONARY[name];
  if (known) return known[0];
  return `imdb:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/** Русское название жанра из словаря; у неизвестного — само имя IMDb. */
export function genreNameRu(name) {
  return GENRE_DICTIONARY[name]?.[1] ?? name;
}

/** Поля сериала, которые импорт вообще пишет. */
const WRITABLE = [
  'imdb_key',
  'tmdb_id',
  'title_ru',
  'title_en',
  'title_original',
  'year_start',
  'year_end',
  'description_ru',
  'description_en',
  'exit_state',
  // Три поля ниже — результат расчёта F-12-06, а не данные источника: они
  // пересчитываются целиком на каждом прогоне, и блокировать их нельзя,
  // иначе карточка навсегда осталась бы с чужим уровнем.
  'publication_state',
  'reasons',
  'level',
];

/** `slug` создаётся один раз и дальше меняется только админом (H-32). */
const NEVER_OVERWRITTEN = new Set(['imdb_key', 'slug']);

/**
 * Пишет один сериал в каталог.
 *
 * @param {object} deps
 * @param {any} deps.pool
 * @param {any} deps.raw сырой слой сериала
 * @param {Set<string>} [deps.slugs] занятые адреса; берётся один раз на прогон
 * @param {Date} [deps.now]
 * @param {{poster?:boolean, backdrop?:boolean}} [deps.images]
 * @param {string[]} [deps.unchecked] коды полноты, которых этот прогон не
 *   проверял (F-12-07): они сохраняются из прежнего списка, иначе частичное
 *   обновление обнуляло бы то, чего просто не смотрело
 * @returns {Promise<{seriesId:number, tconst:string, slug:string, exitState:string, level:string,
 *   reasons:string[], published:boolean, seasons:number, episodes:number, releases:number}>}
 * @throws {Error} транзакция откатывается, сериал остаётся как был
 */
export async function writeSeries({ pool, raw, slugs, now = new Date(), unchecked = [] }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: found } = await client.query(
      'SELECT id, slug, reasons FROM e_series WHERE imdb_key = $1',
      [raw.tconst],
    );
    const existing = found[0] ?? null;

    const locked = existing
      ? new Set((await client.query('SELECT field FROM e_field_lock WHERE series_id = $1', [existing.id]))
        .rows.map((row) => row.field))
      : new Set();

    // Картинки загружает отдельная фича (F-12-05), поэтому полнота считается по
    // тому, что уже лежит в базе: когда постер появится, уровень поднимется при
    // следующем прогоне, а не останется навсегда заниженным.
    const images = await loadImages(client, existing?.id);

    const exitState = computeExitState({ raw, today: now });
    const computed = computeCompleteness({ raw, images, now, unchecked });
    const reasons = carryOverReasons(computed.reasons, existing?.reasons ?? [], unchecked);
    const level = levelOf(reasons);

    const slug = existing?.slug ?? slugFor({
      title: raw.titles?.original?.text || raw.titles?.ru?.text || '',
      year: raw.years?.start ?? null,
      tconst: raw.tconst,
      taken: slugs,
      fallback: raw.titles?.en?.text ?? '',
    });

    // Публикуется только минимум: название, год, жанр, состояние выхода
    // (§4(6)). Всё остальное — бейдж на карточке, а не повод не публиковать.
    const published = Boolean(
      (raw.titles?.original?.text || raw.titles?.ru?.text)
      && raw.years?.start
      && genresFor(raw).length,
    );
    // Архивный сериал обновляет данные, но остаётся архивным (§5).
    const publication = existing
      ? await currentPublication(client, existing.id, published)
      : published ? 'published' : 'imported';

    const seriesId = existing
      ? await updateSeries({ client, id: existing.id, raw, locked, exitState, reasons, level, publication })
      : await insertSeries({ client, raw, locked, exitState, reasons, level, publication, slug });

    await writeGenres({ client, seriesId, genres: genresFor(raw) });
    await writeRatings({ client, seriesId, raw });
    await writeOrigins({ client, seriesId, countries: raw.countries ?? [], networks: raw.networks ?? [] });
    const counts = await writeSeasons({ client, seriesId, raw });
    await writePeople({ client, seriesId, people: raw.people, slugs });

    await client.query('COMMIT');
    slugs.add(slug);
    return { seriesId, tconst: raw.tconst, slug, exitState, level, reasons, published, ...counts };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Состояние публикации прежнее или новое.
 *
 * В архиве импорт не возвращает: снятие с публикации — решение человека.
 */
async function currentPublication(client, seriesId, published) {
  const { rows } = await client.query('SELECT publication_state FROM e_series WHERE id = $1', [seriesId]);
  const current = rows[0]?.publication_state ?? 'imported';
  if (current === 'archived') return 'archived';
  return published ? 'published' : 'imported';
}

/** Значения полей, которые пишет импорт. */
function seriesValues({ raw, exitState, publication, reasons, level }) {
  return {
    imdb_key: raw.tconst,
    tmdb_id: raw.tmdbId ?? null,
    title_ru: raw.titles?.ru?.text || null,
    title_en: raw.titles?.en?.text || null,
    title_original: raw.titles?.original?.text || '',
    year_start: raw.years?.start ?? null,
    year_end: raw.years?.end ?? null,
    description_ru: raw.descriptions?.ru?.text || null,
    description_en: raw.descriptions?.en?.text || null,
    exit_state: exitState,
    publication_state: publication,
    reasons,
    level,
  };
}

/**
 * Колонки, которые эта запись действительно трогает.
 *
 * Блокировки применяются и при вставке: если редактор заранее заблокировал
 * поле, новая карточка тоже не должна его заполнять из источника.
 */
const updatable = (values, locked) => WRITABLE
  .filter((column) => !locked.has(column))
  .map((column) => [column, values[column]]);

async function insertSeries({ client, raw, locked, exitState, reasons, level, publication, slug }) {
  const values = seriesValues({ raw, exitState, publication, reasons, level });
  const entries = updatable(values, locked);
  // `imdb_key` — бизнес-ключ, по нему идёт повторный поиск сериала, поэтому
  // при вставке он обязателен в отличие от `slug`.
  const columns = ['slug', ...entries.map(([column]) => column)];
  const params = [slug, ...entries.map(([, value]) => value)];

  const { rows } = await client.query(
    `INSERT INTO e_series (${columns.join(', ')})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})
     RETURNING id`,
    params,
  );
  return rows[0].id;
}

async function updateSeries({ client, id, raw, locked, exitState, reasons, level, publication }) {
  const values = seriesValues({ raw, exitState, publication, reasons, level });
  // При обновлении `imdb_key` и `slug` не трогаются: ключ опознания сериала и
  // его публичный адрес создаются один раз (H-32).
  const entries = updatable(values, locked).filter(([column]) => !NEVER_OVERWRITTEN.has(column));
  if (!entries.length) return id;

  const params = entries.map(([, value]) => value);
  const assignments = entries.map(([column], index) => `${column} = $${index + 1}`);
  // Версия растёт на каждую правку: её читает оптимистичная блокировка (EC-R2).
  const { rows } = await client.query(
    `UPDATE e_series SET ${assignments.join(', ')}, version = version + 1
      WHERE id = $${params.length + 1} RETURNING id`,
    [...params, id],
  );
  return rows[0].id;
}

/**
 * Жанры для записи: сначала IMDb, а если его нет — TMDB.
 *
 * Новинка, найденная обзором TMDB, может не иметь IMDb-идентификатора
 * (F-12-04 §4: таких около 17%). Тогда жанров IMDb нет физически, и запись по
 * правилу «жанры только из IMDb» оставила бы сериал неопубликованным навсегда
 * — то есть обзор добавлял бы то, что никто не увидит. Имена у TMDB и IMDb
 * совпадают для большинства жанров, а несовпавшие попадут в справочник как
 * скрытые записи и всплывут в отчёте как `new_genre`.
 *
 * @param {any} raw
 * @returns {string[]}
 */
export function genresFor(raw) {
  const imdb = raw.imdbGenres ?? [];
  if (imdb.length) return imdb;
  return (raw.genres ?? []).map((genre) => genre.name).filter(Boolean);
}

/**
 * Рейтинги внешних площадок для шапки карточки (DATA-SOURCES §2).
 *
 * Обе шкалы десятибалльные, поэтому `scale_max` один. Оценка без голосов не
 * пишется: «9,5 у одного человека» — это не рейтинг, а шум, и в шапке он
 * выглядел бы как уверенное число.
 */
async function writeRatings({ client, seriesId, raw }) {
  const pairs = [
    ['imdb', raw.votes?.average, raw.votes?.count],
    ['tmdb', raw.tmdbVotes?.average, raw.tmdbVotes?.count],
  ];

  for (const [platform, value, votes] of pairs) {
    if (value === null || value === undefined || !votes) continue;
    await client.query(
      `INSERT INTO e_external_rating (series_id, platform, value, scale_max, votes, measured_on)
       VALUES ($1, $2, $3, 10, $4, CURRENT_DATE)
       ON CONFLICT (series_id, platform) DO UPDATE SET
         value = EXCLUDED.value, votes = EXCLUDED.votes, measured_on = CURRENT_DATE`,
      [seriesId, platform, Number(value).toFixed(1), votes],
    );
  }
}

/**
 * Страна производства и сети сериала (F-12-03 §4(4), фильтры S-02).
 *
 * Названия стран берутся из `Intl.DisplayNames`, а не из справочника в коде:
 * переводы, написанные руками, разошлись бы с ICU при первом обновлении Node,
 * а страна при этом осталась бы с прежним названием навсегда.
 *
 * @param {object} deps
 * @param {any} deps.client
 * @param {number} deps.seriesId
 * @param {string[]} [deps.countries] ISO 3166-1, коды верхнего регистра
 * @param {{id: number, name: string, countryCode?: string|null}[]} [deps.networks]
 */
export async function writeOrigins({ client, seriesId, countries = [], networks = [] }) {
  const codes = [...new Set(countries.filter((code) => typeof code === 'string' && /^[A-Z]{2}$/.test(code)))];
  for (const code of codes) {
    // Страна сети может прийти раньше страны сериала: сеть пишется в тот же
    // справочник, поэтому подстраховка от ограничения нужна.
    await client.query(
      `INSERT INTO e_country (code, name_ru, name_en) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO NOTHING`,
      [code, regionName(code, 'ru'), regionName(code, 'en')],
    );
  }
  await client.query('DELETE FROM e_series_country WHERE series_id = $1', [seriesId]);
  for (const code of codes) {
    await client.query(
      'INSERT INTO e_series_country (series_id, country_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [seriesId, code],
    );
  }

  await client.query('DELETE FROM e_series_network WHERE series_id = $1', [seriesId]);
  for (const network of networks) {
    if (!Number.isInteger(network?.id) || !network.name) continue;
    if (network.countryCode && /^[A-Z]{2}$/.test(network.countryCode)) {
      await client.query(
        `INSERT INTO e_country (code, name_ru, name_en) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO NOTHING`,
        [network.countryCode, regionName(network.countryCode, 'ru'), regionName(network.countryCode, 'en')],
      );
    }
    await client.query(
      `INSERT INTO e_network (id, name, country_code) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, country_code = EXCLUDED.country_code`,
      [network.id, String(network.name).slice(0, 200), network.countryCode ?? null],
    );
    await client.query(
      'INSERT INTO e_series_network (series_id, network_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [seriesId, network.id],
    );
  }

  return { countries: codes.length, networks: networks.length };
}

/**
 * Название региона по ISO 3166-1.
 *
 * @param {string} code
 * @param {'ru'|'en'} locale
 * @returns {string} код, если ICU его не знает: выдуманное название страны
 *   хуже кода — код хотя бы однозначен
 */
function regionName(code, locale) {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Жанры: справочник пополняется, неизвестные — скрытые записи. */
async function writeGenres({ client, seriesId, genres }) {
  await client.query('DELETE FROM e_series_genre WHERE series_id = $1', [seriesId]);
  for (const name of genres) {
    const code = genreCode(name);
    await client.query(
      `INSERT INTO e_genre (code, name_ru, name_en, is_raw)
       VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING`,
      [code, genreNameRu(name), name, code.startsWith('imdb:')],
    );
    await client.query(
      'INSERT INTO e_series_genre (series_id, genre_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [seriesId, code],
    );
  }
}

/**
 * Сезоны, серии и выходы.
 *
 * Выходы сезона пересобираются целиком: серии под одной датой группируются в
 * один выход (EC-D11), и их число может измениться — старые строки тогда
 * указывали бы на несуществующие серии.
 */
async function writeSeasons({ client, seriesId, raw }) {
  let seasons = 0;
  let episodes = 0;
  let releases = 0;

  for (const season of raw.seasons ?? []) {
    if (!Number.isInteger(season.number)) continue;

    const { rows: seasonRows } = await client.query(
      `INSERT INTO e_season (series_id, number, title_ru, description_ru)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (series_id, number) DO UPDATE SET
         title_ru = EXCLUDED.title_ru, description_ru = EXCLUDED.description_ru
       RETURNING id`,
      [seriesId, season.number, season.titleRu?.text || null, season.descriptionRu?.text || null],
    );
    const seasonId = seasonRows[0].id;
    seasons += 1;

    const episodeIds = new Map();
    for (const episode of season.episodes ?? []) {
      if (!Number.isInteger(episode.number)) continue;
      const { rows: episodeRows } = await client.query(
        `INSERT INTO e_episode (season_id, number, title_ru, description_ru, runtime_min)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (season_id, number) DO UPDATE SET
           title_ru = EXCLUDED.title_ru, description_ru = EXCLUDED.description_ru,
           runtime_min = EXCLUDED.runtime_min
         RETURNING id`,
        [seasonId, episode.number, episode.titleRu?.text || null, episode.descriptionRu?.text || null, episode.runtimeMin ?? null],
      );
      episodeIds.set(episode.number, episodeRows[0].id);
      episodes += 1;
    }

    // Выходы обновляются, а не пересоздаются (DEC-061). Удаление и вставка
    // каждый раз меняли идентификатор выхода, а вместе с ним — ключ
    // дедупликации уведомлений, ссылки и состояние, выставленное вручную:
    // ночной прогон обнулял «перенесён» и «отменён», и на следующей ночи
    // каждый подписчик получал то же уведомление заново (#133).
    const grouped = groupReleases(season);
    const touched = [];

    for (const release of grouped) {
      const { rows: releaseRows } = await client.query(
        `INSERT INTO e_release (season_id, release_date, precision, state)
         VALUES ($1, $2, 'date', 'scheduled')
         ON CONFLICT (season_id, release_date) DO UPDATE
           SET precision = EXCLUDED.precision
         -- locked — ручная правка: импорт её не трогает, иначе редактор
         -- написал дату, а ночной прогон её стёр.
         WHERE e_release.locked = FALSE
         RETURNING id`,
        [seasonId, release.date],
      );
      // Ничего не вернулось — значит строка защищена правкой человека.
      if (!releaseRows.length) continue;
      const releaseId = releaseRows[0].id;
      touched.push(releaseId);
      releases += 1;

      await client.query('DELETE FROM e_release_episode WHERE release_id = $1', [releaseId]);
      for (const number of release.episodeNumbers) {
        const episodeId = episodeIds.get(number);
        if (!episodeId) continue;
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          'INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [releaseId, episodeId],
        );
      }
    }

    // Даты, которых больше нет в источнике, уходят. Защищённые правкой
    // остаются: человек поставил дату руками, и «источник её не знает» —
    // не повод её стирать.
    if (grouped.length) {
      await client.query(
        `DELETE FROM e_release
          WHERE season_id = $1 AND locked = FALSE
            AND NOT (release_date = ANY($2::date[]))`,
        [seasonId, grouped.map((one) => one.date)],
      );
    }
  }

  return { seasons, episodes, releases };
}

/**
 * Режиссёры и «В ролях» (F-12-03 §4(3)).
 *
 * Человек опознаётся по `nconst`, а не по имени: тёзок у IMDb десятки, и имя
 * в адресе (`slug`) — только для страницы. Иначе один и тот же актёр при
 * втором появлении получил бы второй адрес и вторую строку справочника.
 */
async function writePeople({ client, seriesId, people, slugs }) {
  const directors = people?.directors ?? [];
  const cast = people?.cast ?? [];
  if (!directors.length && !cast.length) return;

  await client.query('DELETE FROM e_series_person WHERE series_id = $1', [seriesId]);

  for (const [kind, list] of [['director', directors], ['actor', cast]]) {
    for (const [index, person] of list.entries()) {
      if (!person?.name) continue;

      const { rows: known } = await client.query(
        'SELECT id FROM e_person WHERE imdb_key = $1',
        [person.nconst ?? null],
      );
      let personId = known[0]?.id;

      if (!personId) {
        const slug = slugFor({ title: person.name, year: null, tconst: person.nconst, taken: slugs });
        const { rows } = await client.query(
          `INSERT INTO e_person (imdb_key, slug, name, kind) VALUES ($1, $2, $3, $4)
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, imdb_key = EXCLUDED.imdb_key
           RETURNING id`,
          [person.nconst ?? null, slug, person.name, kind],
        );
        personId = rows[0].id;
        slugs.add(slug);
      }

      await client.query(
        `INSERT INTO e_series_person (series_id, person_id, role, ordinal)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [seriesId, personId, kind, index],
      );
    }
  }
}

/** Занятые адреса сериалов и людей — берутся один раз на прогон. */
export async function loadSlugs(pool) {
  const { rows } = await pool.query('SELECT slug FROM e_series UNION SELECT slug FROM e_person');
  return new Set(rows.map((row) => row.slug));
}

/**
 * Записывает страны и сети одного сериала своей транзакцией.
 *
 * Обёртка над `writeOrigins` для дозагрузки (`npm run import:origins`): полный
 * `writeSeries` там не нужен и был бы дорог — он пересчитывает полноту,
 * состояние выхода и сезоны, а здесь нужно только доставить недостающие связи.
 *
 * @param {object} deps
 * @param {any} deps.pool
 * @param {number} deps.seriesId
 * @param {string[]} deps.countries
 * @param {any[]} deps.networks
 * @returns {Promise<{countries: number, networks: number}>}
 */
export async function writeOriginsForSeries({ pool, seriesId, countries, networks }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const counts = await writeOrigins({ client, seriesId, countries, networks });
    await client.query('COMMIT');
    return counts;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Какие картинки уже загружены.
 *
 * Фон для полноты требуется «без текста» (R-SEC-17), а у самой картинки нет
 * признака «чистая»: он хранится в `e_splash_frame` для заставок. Поэтому
 * здесь считаем, что фон есть, если строка вообще есть, а чистоту проверит
 * F-12-05 при загрузке.
 *
 * @param {any} client
 * @param {number|null} seriesId
 * @returns {Promise<{poster:boolean, backdrop:boolean}>}
 */
async function loadImages(client, seriesId) {
  if (!seriesId) return { poster: false, backdrop: false };
  const { rows } = await client.query(
    'SELECT DISTINCT role FROM e_image WHERE series_id = $1 AND role IN ($2, $3)',
    [seriesId, 'poster', 'backdrop'],
  );
  const roles = new Set(rows.map((row) => row.role));
  return { poster: roles.has('poster'), backdrop: roles.has('backdrop') };
}