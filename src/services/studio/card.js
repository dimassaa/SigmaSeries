// Карточка сериала в студии: чтение, правка, публикация, архив.
//
// Правка ручная всегда побеждает импорт: изменённое поле помечается
// блокировкой в `e_field_lock`, и импорт его больше не трогает (H-41). Рядом
// с полем видно, откуда значение — «вручную» или «из импорта», — и можно
// вернуть последнее импортированное значение.
//
// Версия карточки растёт при каждом сохранении и проверяется при записи:
// два админа, открывшие одну карточку, не затирают друг друга (EC-S2).

/** Поля, которые админ может править. Всё остальное — вwhite list. */
export const EDITABLE_FIELDS = [
  'title_ru',
  'title_en',
  'title_original',
  'year_start',
  'year_end',
  'description_ru',
  'description_en',
  'slug',
  'exit_state',
];

/** Состояния выхода: белый список. */
const EXIT_STATES = ['announced', 'airing', 'waiting', 'ended', 'cancelled'];

/** Названия полей для журнала и интерфейса. */
const FIELD_LABELS = {
  title_ru: 'Название ru',
  title_en: 'Название en',
  title_original: 'Оригинальное название',
  year_start: 'Год начала',
  year_end: 'Год окончания',
  description_ru: 'Описание ru',
  description_en: 'Описание en',
  slug: 'Адрес',
  exit_state: 'Состояние выхода',
};

/**
 * Студия карточки.
 *
 * @param {import('pg').Pool} pool
 */
export function pgStudioCard(pool) {
  /**
   * Карточка со всем, что о ней известно.
   *
   * @param {number} seriesId
   * @returns {Promise<object|null>}
   */
  async function read(seriesId) {
    const { rows } = await pool.query(
      `SELECT s.id, s.slug, s.title_ru, s.title_en, s.title_original,
              s.year_start, s.year_end, s.description_ru, s.description_en,
              s.exit_state, s.publication_state, s.level, s.reasons,
              s.imdb_key, s.tmdb_id, s.version, s.archived_at,
              r.value::float AS imdb, r.votes AS imdb_votes, r.measured_on,
              (SELECT array_agg(sg.genre_code ORDER BY sg.genre_code)
                 FROM e_series_genre sg WHERE sg.series_id = s.id) AS genres,
              (SELECT count(*)::int FROM e_image i
                WHERE i.series_id = s.id AND i.role = 'poster') AS posters,
              (SELECT count(*)::int FROM e_image i
                WHERE i.series_id = s.id AND i.role = 'backdrop') AS backdrops
         FROM e_series s
         LEFT JOIN e_external_rating r
                ON r.series_id = s.id AND r.platform = 'imdb'
        WHERE s.id = $1`,
      [seriesId],
    );
    const row = rows[0];
    if (!row) return null;

    const locks = await lockMap(pool, seriesId);
    const dependencies = await dependentCounts(seriesId);

    return {
      id: row.id,
      slug: row.slug,
      fields: {
        title_ru: row.title_ru ?? '',
        title_en: row.title_en ?? '',
        title_original: row.title_original ?? '',
        year_start: row.year_start ?? '',
        year_end: row.year_end ?? '',
        description_ru: row.description_ru ?? '',
        description_en: row.description_en ?? '',
        slug: row.slug,
        exit_state: row.exit_state,
      },
      // Происхождение каждого поля: «вручную» — поле заблокировано от
      // перезаписи импортом, «из импорта» — значения ещё не касались.
      origins: Object.fromEntries(
        EDITABLE_FIELDS.map((field) => [field, locks.has(field) ? 'manual' : 'import']),
      ),
      locks: Object.fromEntries([...locks].map(([field, lock]) => [field, lock])),
      genres: row.genres ?? [],
      publicationState: row.publication_state,
      level: row.level,
      reasons: row.reasons ?? [],
      imdb: row.imdb === null ? null : Number(row.imdb),
      imdbVotes: row.imdb_votes,
      measuredOn: row.measured_on,
      imdbKey: row.imdb_key,
      tmdbId: row.tmdb_id,
      version: row.version,
      archived: Boolean(row.archived_at),
      images: { posters: row.posters, backdrops: row.backdrops },
      dependencies,
      // Что мешает публикации: без минимума кнопка «Опубликовать» заблокирована.
      publishBlockers: publishBlockers(row),
    };
  }

  /**
   * Сохранить правку.
   *
   * @param {number} seriesId
   * @param {object} input
   * @param {object} input.fields значения полей
   * @param {string[]} input.genres жанры из справочника
   * @param {number} input.version ожидаемая версия
   * @param {number} input.byId кто сохраняет
   * @returns {Promise<{ok: boolean, reason?: string, version?: number}>}
   */
  async function save(seriesId, { fields = {}, genres = null, version = null, byId = null } = {}) {
    const current = await read(seriesId);
    if (!current) return { ok: false, reason: 'not_found' };
    if (version !== null && Number(version) !== Number(current.version)) {
      // Конфликт версий: показываем различия, решение принимает админ.
      return { ok: false, reason: 'conflict', current };
    }

    const clean = validate(fields);
    if (!clean.ok) return { ok: false, reason: 'invalid', errors: clean.errors };

    const changed = Object.keys(clean.values).filter(
      (field) => String(current.fields[field] ?? '') !== String(clean.values[field] ?? ''),
    );
    if (!changed.length && genres === null) {
      return { ok: true, version: current.version, changed: [] };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Версия растёт при каждом сохранении — даже если изменились только
      // жанры, поэтому список присваиваний всегда непустой.
      const sets = ['version = version + 1'];
      const params = [];
      for (const field of changed) {
        params.push(clean.values[field]);
        sets.push(`${field} = $${params.length}`);
      }
      params.push(seriesId);
      const { rowCount } = await client.query(
        `UPDATE e_series SET ${sets.join(', ')}
          WHERE id = $${params.length}`,
        params,
      );
      if (!rowCount) throw new Error('Сериал исчез при сохранении');

      // Ручная правка закрывает поле от перезаписи импортом.
      for (const field of changed) {
        await client.query(
          `INSERT INTO e_field_lock (series_id, field, set_by, imported_value)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (series_id, field)
           DO UPDATE SET set_by = EXCLUDED.set_by, set_at = now()`,
          [seriesId, field, byId, Buffer.from(String(current.fields[field] ?? ''), 'utf8')],
        );
      }

      if (genres !== null) {
        await client.query('DELETE FROM e_series_genre WHERE series_id = $1', [seriesId]);
        for (const code of genres) {
          await client.query(
            `INSERT INTO e_series_genre (series_id, genre_code) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [seriesId, code],
          );
        }
      }

      await recompute(seriesId, client);
      await client.query('COMMIT');
      return { ok: true, version: current.version + 1, changed };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Вернуть поле к последнему импортированному значению.
   *
   * @param {number} seriesId
   * @param {string} field
   * @param {number} byId
   * @returns {Promise<boolean>}
   */
  async function resetField(seriesId, field, byId = null) {
    if (!EDITABLE_FIELDS.includes(field)) return false;
    const { rows } = await pool.query(
      'SELECT imported_value FROM e_field_lock WHERE series_id = $1 AND field = $2',
      [seriesId, field],
    );
    const lock = rows[0];
    if (!lock) return false;
    const value = lock.imported_value ? lock.imported_value.toString('utf8') : '';
    const cast = ['year_start', 'year_end'].includes(field)
      ? (value === '' ? null : Number(value))
      : value;
    await pool.query(
      `UPDATE e_series SET ${field} = $2, version = version + 1 WHERE id = $1`,
      [seriesId, cast],
    );
    await pool.query(
      'DELETE FROM e_field_lock WHERE series_id = $1 AND field = $2',
      [seriesId, field],
    );
    await recompute(seriesId);
    return true;
  }

  /**
   * Опубликовать карточку.
   *
   * @param {number} seriesId
   * @param {{byId: number|null}} args
   * @returns {Promise<{ok: boolean, reason?: string, blockers?: string[]}>}
   */
  async function publish(seriesId, { byId = null } = {}) {
    const card = await read(seriesId);
    if (!card) return { ok: false, reason: 'not_found' };
    const blockers = card.publishBlockers;
    if (blockers.length) return { ok: false, reason: 'blocked', blockers };
    await pool.query(
      `UPDATE e_series SET publication_state = 'published', version = version + 1
        WHERE id = $1 AND publication_state <> 'published'`,
      [seriesId],
    );
    return { ok: true };
  }

  /**
   * Убрать карточку в архив.
   *
   * @param {number} seriesId
   * @param {{byId: number|null, reason?: string}} args
   * @returns {Promise<{ok: boolean, dependencies?: object}>}
   */
  async function archive(seriesId, { byId = null } = {}) {
    const dependencies = await dependentCounts(seriesId);
    await pool.query(
      `UPDATE e_series
          SET publication_state = 'archived', archived_at = now(), version = version + 1
        WHERE id = $1`,
      [seriesId],
    );
    // Баннеры архивного сериала снимаются: на главне он показываться не
    // должен (EC-H3 — вместо кадра остаётся заглушка с пометкой).
    await pool.query(
      `UPDATE e_banner SET active = FALSE
        WHERE series_id = $1 AND active`,
      [seriesId],
    );
    return { ok: true, dependencies };
  }

  /**
   * Вернуть карточку из архива.
   *
   * @param {number} seriesId
   * @param {{byId: number|null}} args
   * @returns {Promise<{ok: boolean}>}
   */
  async function restore(seriesId, { byId = null } = {}) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM e_series_genre WHERE series_id = $1`,
      [seriesId],
    );
    const state = rows[0].n > 0 ? 'published' : 'imported';
    await pool.query(
      `UPDATE e_series
          SET publication_state = $2, archived_at = NULL, version = version + 1
        WHERE id = $1`,
      [seriesId, state],
    );
    return { ok: true, state };
  }

  /**
   * Зависимые данные: что помешает удалить карточку.
   *
   * @param {number} seriesId
   * @returns {Promise<object>}
   */
  async function dependentCounts(seriesId) {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM e_banner WHERE series_id = $1 AND active) AS banners,
         (SELECT count(*)::int FROM e_collection_item WHERE series_id = $1) AS collections,
         (SELECT count(DISTINCT user_id)::int FROM e_watch_status WHERE series_id = $1) AS watchers,
         (SELECT count(*)::int FROM e_watch_mark m
            JOIN e_episode ep ON ep.id = m.episode_id
            JOIN e_season se ON se.id = ep.season_id
           WHERE se.series_id = $1) AS marks,
         (SELECT count(*)::int FROM e_material WHERE series_id = $1) AS reviews,
         (SELECT count(*)::int FROM e_rating WHERE series_id = $1) AS ratings,
         (SELECT count(*)::int FROM e_release rel
            JOIN e_season se ON se.id = rel.season_id WHERE se.series_id = $1) AS releases`,
      [seriesId],
    );
    return rows[0];
  }

  /**
   * История изменений карточки.
   *
   * Отдельной таблицы версий в схеме нет, поэтому история — это журнал
   * действий по объекту: он и так хранится не короче журнала аудита
   * (F-10-06 §8). Пометка в журнале «журнал, а не версии» стоит в интерфейсе.
   *
   * @param {number} seriesId
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async function history(seriesId, limit = 50) {
    const { rows } = await pool.query(
      `SELECT a.id, a.at, a.action, a.object_type, a.result, a.reason, a.after_data,
              u.nickname
         FROM e_audit_log a
         LEFT JOIN e_user u ON u.id = a.actor_id
        WHERE a.object_type = 'series' AND a.object_id = $1
        ORDER BY a.at DESC
        LIMIT $2`,
      [seriesId, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      action: row.action,
      result: row.result,
      reason: row.reason,
      actor: row.nickname,
      after: row.after_data,
    }));
  }

  /**
   * Пересчитать полноту и причины.
   *
   * Причины, которые считаются по карточке, — пересчитываются; те, что
   * знает только импорт (расхождение расписания), остаются как есть.
   *
   * @param {number} seriesId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<void>}
   */
  async function recompute(seriesId, client = pool) {
    const { rows } = await client.query(
      `SELECT s.title_ru, s.title_original, s.year_start, s.description_ru, s.description_en,
              (SELECT count(*)::int FROM e_series_genre sg WHERE sg.series_id = s.id) AS genres,
              (SELECT count(*)::int FROM e_image i
                WHERE i.series_id = s.id AND i.role = 'poster') AS posters,
              (SELECT count(*)::int FROM e_image i
                WHERE i.series_id = s.id AND i.role = 'backdrop') AS backdrops
         FROM e_series s WHERE s.id = $1`,
      [seriesId],
    );
    const row = rows[0];
    if (!row) return;

    const reasons = [];
    if (!row.genres) reasons.push('no_genre');
    if (!row.posters) reasons.push('no_poster');
    if (!row.backdrops) reasons.push('no_backdrop');
    if (!row.description_ru && !row.description_en) reasons.push('no_overview');
    else if (!row.description_ru) reasons.push('no_overview_ru');

    const minimum = Boolean(row.title_ru || row.title_original) && Boolean(row.year_start)
      && row.genres > 0;
    const displayable = minimum && row.posters > 0
      && Boolean(row.description_ru || row.description_en);
    const full = displayable && row.backdrops > 0 && Boolean(row.description_ru);

    await client.query(
      'UPDATE e_series SET reasons = $2, level = $3 WHERE id = $1',
      [seriesId, reasons, full ? 'full' : displayable ? 'displayable' : 'minimum'],
    );
  }

  /**
   * Справочник жанров для правки карточки.
   *
   * @returns {Promise<{code: string, title: string, active: boolean}[]>}
   */
  async function genres() {
    const { rows } = await pool.query(
      `SELECT code, name_ru, name_en, active FROM e_genre
        WHERE code NOT LIKE 'imdb:%' ORDER BY name_ru`,
    );
    return rows.map((row) => ({
      code: row.code,
      title: row.name_ru || row.name_en || row.code,
      active: row.active,
    }));
  }

  return {
    read, save, resetField, publish, archive, restore, dependencies: dependentCounts, history, recompute, genres,
  };
}

/**
 * Блокировки полей карточки.
 *
 * @param {import('pg').Pool} pool
 * @param {number} seriesId
 * @returns {Promise<Map<string, object>>}
 */
async function lockMap(pool, seriesId) {
  const { rows } = await pool.query(
    'SELECT field, set_by, set_at FROM e_field_lock WHERE series_id = $1',
    [seriesId],
  );
  return new Map(rows.map((row) => [row.field, row]));
}

/**
 * Что мешает публикации.
 *
 * @param {object} row
 * @returns {string[]}
 */
function publishBlockers(row) {
  const blockers = [];
  if (!row.title_ru && !row.title_original) blockers.push('no_title');
  if (!row.year_start) blockers.push('no_year');
  if (!(row.genres && row.genres.length)) blockers.push('no_genre');
  return blockers;
}

/**
 * Проверка и очистка полей.
 *
 * @param {object} fields
 * @returns {{ok: boolean, values: object, errors: object}}
 */
function validate(fields) {
  const values = {};
  const errors = {};
  for (const [field, raw] of Object.entries(fields ?? {})) {
    if (!EDITABLE_FIELDS.includes(field)) continue;
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (field === 'title_ru' || field === 'title_en' || field === 'title_original') {
      if (String(value).length > 300) errors[field] = 'too_long';
      else values[field] = value;
      continue;
    }
    if (field === 'description_ru' || field === 'description_en') {
      if (String(value).length > 5000) errors[field] = 'too_long';
      else values[field] = value;
      continue;
    }
    if (field === 'year_start' || field === 'year_end') {
      if (value === '' || value === null) values[field] = null;
      else {
        const year = Number(value);
        const max = new Date().getFullYear() + 5;
        if (!Number.isInteger(year) || year < 1900 || year > max) errors[field] = 'range';
        else values[field] = year;
      }
      continue;
    }
    if (field === 'slug') {
      const slug = String(value).toLowerCase();
      if (!/^[a-z0-9-]{1,120}$/.test(slug)) errors[field] = 'slug';
      else values[field] = slug;
      continue;
    }
    if (field === 'exit_state') {
      if (!EXIT_STATES.includes(value)) errors[field] = 'state';
      else values[field] = value;
      continue;
    }
  }
  return { ok: Object.keys(errors).length === 0, values, errors };
}

/** Названия полей для интерфейса и журнала. */
export { FIELD_LABELS };
