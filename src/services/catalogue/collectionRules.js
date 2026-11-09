// Подборки по правилам (OP-18, F-02-05 §3).
//
// Правило — это условие отбора, а не добавка к ручному списку. Подборка с
// активными правилами пересобирается целиком: старые позиции удаляются, новые
// вставляются в одной транзакции. Иначе «правило» со временем превратилось бы
// в свалку из ручных правок и совпадений, и никто не сказал бы, что в ней
// осталось от правила.
//
// Несколько правил складываются по «И»: жанр и годы — это одно подмножество
// каталога, а не два списка, которые потом склеиваются.
//
// Неподдерживаемое или невалидное правило пропускает всю подборку, а не
// отбрасывается: подборка без условия «платформа» показала бы сериалы всех
// платформ, и это была бы тихая подмена, которую никто не заметит. Пустая
// подборка при этом не создаётся — старый состав остаётся до починки правила.

import pg from 'pg';

/** Больше ста позиций подборка не держит (F-02-05 «Валидация и лимиты»). */
export const RULE_LIMIT = 100;

/** Виды правил, которые минимальный OP-18 умеет применять. */
const FILTER_KINDS = new Set(['by_genre', 'by_year', 'by_rating']);

/** Ручной состав — не фильтр: подборка с ним остаётся ручной. */
const IGNORED_KINDS = new Set(['manual']);

/**
 * Разобрать правило в условие отбора.
 *
 * @param {{kind: string, params: any}} rule
 * @returns {{ignored?: true, invalid?: string, genre?: string, yearFrom?: number,
 *   yearTo?: number, ratingMin?: number}}
 */
function parseRule(rule) {
  const kind = String(rule?.kind ?? '');
  if (IGNORED_KINDS.has(kind)) return { ignored: true };
  if (!FILTER_KINDS.has(kind)) return { invalid: `unsupported:${kind || 'empty'}` };

  const params = rule?.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return { invalid: `${kind}:params` };
  }

  if (kind === 'by_genre') {
    const genre = typeof params.genre === 'string' ? params.genre.trim() : '';
    return genre ? { genre } : { invalid: 'by_genre:genre' };
  }

  if (kind === 'by_year') {
    const { from, to } = params;
    // Обе границы обязательны: «с 1801 года» без верхней — это не диапазон,
    // а весь каталог после 1801, и назвать его годами было бы враньём.
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
      return { invalid: 'by_year:range' };
    }
    return { yearFrom: from, yearTo: to };
  }

  const min = params.min;
  if (typeof min !== 'number' || !Number.isFinite(min) || min < 0 || min > 10) {
    return { invalid: 'by_rating:min' };
  }
  return { ratingMin: min };
}

/**
 * Сложить условия по «И», не позволяя одному правилу молча перетереть другое.
 *
 * @param {Array<{genre?: string, yearFrom?: number, yearTo?: number,
 *   ratingMin?: number}>} filters
 * @returns {{genre?: string, yearFrom?: number, yearTo?: number,
 *   ratingMin?: number, invalid?: string}}
 */
function mergeFilters(filters) {
  /** @type {any} */
  const merged = {};
  for (const filter of filters) {
    if (filter.genre !== undefined) {
      if (merged.genre !== undefined && merged.genre !== filter.genre) {
        return { invalid: 'by_genre:conflict' };
      }
      merged.genre = filter.genre;
    }
    // Пересечение диапазонов и порогов: два правила «годы» означают более
    // узкий диапазон, а не последнее из них.
    if (filter.yearFrom !== undefined) {
      merged.yearFrom = Math.max(merged.yearFrom ?? filter.yearFrom, filter.yearFrom);
    }
    if (filter.yearTo !== undefined) {
      merged.yearTo = Math.min(merged.yearTo ?? filter.yearTo, filter.yearTo);
    }
    if (filter.ratingMin !== undefined) {
      merged.ratingMin = Math.max(merged.ratingMin ?? filter.ratingMin, filter.ratingMin);
    }
  }
  if (merged.yearFrom !== undefined && merged.yearTo !== undefined
      && merged.yearFrom > merged.yearTo) {
    return { invalid: 'by_year:empty' };
  }
  return merged;
}

/**
 * Источник данных правил подборок.
 *
 * @param {pg.Pool} pool
 */
export function pgCollectionRules(pool) {
  /**
   * Подборки, у которых есть хотя бы одно активное правило.
   *
   * @returns {Promise<Array<{id: number, slug: string, rules: any[]}>>}
   */
  async function collectionsWithRules() {
    const { rows } = await pool.query(
      `SELECT c.id, c.slug,
              json_agg(json_build_object('kind', r.kind, 'params', r.params)
                       ORDER BY r.id) AS rules
         FROM e_collection c
         JOIN e_collection_rule r ON r.collection_id = c.id AND r.active
        GROUP BY c.id
        ORDER BY c.id`,
    );
    return rows;
  }

  /**
   * Отобрать сериалы под условие.
   *
   * @param {{genre?: string, yearFrom?: number, yearTo?: number,
   *   ratingMin?: number}} filter
   * @returns {Promise<number[]>}
   */
  async function selectSeries(filter) {
    const where = [
      `s.publication_state = 'published'`,
      's.archived_at IS NULL',
    ];
    const params = [];

    if (filter.genre) {
      params.push(filter.genre);
      where.push(`EXISTS (SELECT 1 FROM e_series_genre sg
                           WHERE sg.series_id = s.id AND sg.genre_code = $${params.length})`);
    }
    if (filter.yearFrom !== undefined) {
      params.push(filter.yearFrom);
      where.push(`s.year_start >= $${params.length}`);
    }
    if (filter.yearTo !== undefined) {
      params.push(filter.yearTo);
      where.push(`s.year_start <= $${params.length}`);
    }
    if (filter.ratingMin !== undefined) {
      params.push(filter.ratingMin);
      where.push(`r.value >= $${params.length}`);
    }

    params.push(RULE_LIMIT);
    const { rows } = await pool.query(
      `SELECT s.id
         FROM e_series s
         LEFT JOIN e_external_rating r
           ON r.series_id = s.id AND r.platform = 'imdb'
        WHERE ${where.join(' AND ')}
        ORDER BY r.value DESC NULLS LAST, r.votes DESC NULLS LAST,
                 coalesce(s.title_ru, s.title_en, s.title_original) ASC, s.id
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => row.id);
  }

  /**
   * Заменить состав подборки целиком.
   *
   * @param {number} collectionId
   * @param {number[]} seriesIds
   * @returns {Promise<number>}
   */
  async function replaceItems(collectionId, seriesIds) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM e_collection_item WHERE collection_id = $1', [collectionId]);
      if (seriesIds.length) {
        await client.query(
          `INSERT INTO e_collection_item (collection_id, series_id, ordinal)
           SELECT $1, t.series_id, t.ord::int
             FROM unnest($2::bigint[]) WITH ORDINALITY AS t(series_id, ord)`,
          [collectionId, seriesIds],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return seriesIds.length;
  }

  /**
   * Пересчитать все подборки с активными правилами.
   *
   * @returns {Promise<{collections: number, series: number,
   *   skipped: Array<{slug: string, reason: string}>}>}
   */
  async function apply() {
    const found = await collectionsWithRules();
    const summary = { collections: 0, series: 0, skipped: [] };

    for (const collection of found) {
      /** @type {any[]} */
      const filters = [];
      let invalid = null;

      for (const rule of collection.rules) {
        const parsed = parseRule(rule);
        if (parsed.ignored) continue;
        if (parsed.invalid) {
          invalid = parsed.invalid;
          break;
        }
        filters.push(parsed);
      }

      if (invalid) {
        summary.skipped.push({ slug: collection.slug, reason: invalid });
        continue;
      }
      // Остались только ручные правила: состав ведёт админ, не задача.
      if (!filters.length) continue;

      // Неизвестный жанр — не пустой результат, а опечатка в правиле. Молча
      // стереть подборку из-за неё нельзя.
      const filter = mergeFilters(filters);
      if (filter.invalid) {
        summary.skipped.push({ slug: collection.slug, reason: filter.invalid });
        continue;
      }
      if (filter.genre !== undefined) {
        const { rowCount } = await pool.query(
          'SELECT 1 FROM e_genre WHERE code = $1',
          [filter.genre],
        );
        if (!rowCount) {
          summary.skipped.push({ slug: collection.slug, reason: `unknown_genre:${filter.genre}` });
          continue;
        }
      }

      const seriesIds = await selectSeries(filter);
      const count = await replaceItems(collection.id, seriesIds);
      summary.collections += 1;
      summary.series += count;
    }

    return summary;
  }

  return { apply };
}
