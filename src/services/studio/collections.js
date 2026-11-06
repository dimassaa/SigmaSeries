// Подборки вручную (F-10-07, S-77).
//
// Без подборок бегущая строка главной пуста: админ собирает наборы сам.
// Правила набора: не больше ста сериалов, дубликатов нет, порядок задаётся
// и перетаскиванием, и кнопками — одно и то же должно получаться обоими
// способами (F-10-07 §18).
//
// Публикация подборки требует шести видимых сериалов: меньше — полоса
// выглядит пустой, и подборка скрывается сама (EC-C6).

/** Сколько сериалов нужно подборке, чтобы её можно было опубликовать. */
export const MIN_VISIBLE_SERIES = 6;

/** Больше ста сериалов в подборке не полагается (F-10-07 §9). */
export const MAX_SERIES = 100;

/**
 * Подборки студии.
 *
 * @param {import('pg').Pool} pool
 */
export function pgStudioCollections(pool) {
  /**
   * Все подборки с числом видимых сериалов.
   *
   * @returns {Promise<any[]>}
   */
  async function list() {
    const { rows } = await pool.query(
      `SELECT c.id, c.slug, c.title_ru, c.title_en, c.description_ru, c.description_en,
              c.weight, c.active, c.is_demo,
              (SELECT count(*)::int FROM e_collection_item ci
                JOIN e_series s ON s.id = ci.series_id
               WHERE ci.collection_id = c.id
                 AND s.publication_state = 'published' AND s.archived_at IS NULL)
                AS visible_series,
              (SELECT count(*)::int FROM e_collection_item ci
                WHERE ci.collection_id = c.id) AS total_series
         FROM e_collection c
        ORDER BY c.weight DESC, c.title_ru`,
    );
    return rows.map((row) => ({
      id: Number(row.id),
      slug: row.slug,
      title: row.title_ru,
      titleEn: row.title_en,
      description: row.description_ru,
      descriptionEn: row.description_en,
      weight: Number(row.weight),
      active: Boolean(row.active),
      isDemo: Boolean(row.is_demo),
      visibleSeries: Number(row.visible_series),
      totalSeries: Number(row.total_series),
      // Состояние строки — готовое имя из §6 фичи: вид решает по нему вместо
      // того, чтобы строить свой второй статус, расползшийся с выдачей.
      state: collectionState(Boolean(row.active), Number(row.visible_series)),
    }));
  }

  /**
   * Подборка с её сериалами.
   *
   * @param {string} slug
   * @returns {Promise<any|null>}
   */
  async function one(slug) {
    const { rows } = await pool.query(
      `SELECT id, slug, title_ru, title_en, description_ru, description_en,
              weight, active, is_demo, banner_image_id
         FROM e_collection WHERE slug = $1`,
      [slug],
    );
    const row = rows[0];
    if (!row) return null;

    const { rows: items } = await pool.query(
      `SELECT ci.series_id, ci.ordinal, s.slug, s.title_ru, s.title_original, s.year_start,
              s.publication_state, s.archived_at,
              (SELECT iv.width FROM e_image_variant iv
                 JOIN e_image i ON i.id = iv.image_id
                WHERE i.series_id = s.id AND i.role = 'poster'
                ORDER BY iv.width LIMIT 1) AS poster_width
         FROM e_collection_item ci
         JOIN e_series s ON s.id = ci.series_id
        WHERE ci.collection_id = $1
        ORDER BY ci.ordinal, ci.series_id`,
      [row.id],
    );

    const visible = items.filter((item) => item.publication_state === 'published'
      && !item.archived_at).length;

    const backdrop = row.banner_image_id == null
      ? await hasBackdrop(pool, Number(row.id))
      : false;

    return {
      id: Number(row.id),
      slug: row.slug,
      title: row.title_ru,
      titleEn: row.title_en,
      description: row.description_ru,
      descriptionEn: row.description_en,
      weight: Number(row.weight),
      active: Boolean(row.active),
      isDemo: Boolean(row.is_demo),
      hasBanner: row.banner_image_id !== null,
      visibleSeries: visible,
      publishBlockers: publishBlockers(row, visible, backdrop),
      state: collectionState(Boolean(row.active), visible),
      items: items.map((item) => ({
        seriesId: Number(item.series_id),
        ordinal: Number(item.ordinal),
        slug: item.slug,
        title: item.title_ru || item.title_original,
        year: item.year_start,
        posterWidth: item.poster_width,
        // Сериал, снятый с публикации, в публичной подборке не виден (EC-C6).
        visible: item.publication_state === 'published' && !item.archived_at,
      })),
    };
  }

  /**
   * Создать или изменить подборку.
   *
   * @param {object} input
 * @param {any} [input.active]
 * @param {any} [input.description]
 * @param {any} [input.descriptionEn]
 * @param {any} [input.seriesIds]
 * @param {any} [input.slug]
 * @param {any} [input.title]
 * @param {any} [input.titleEn]
 * @param {any} [input.weight]
   * @returns {Promise<{ok: boolean, reason?: string, slug?: string, blockers?: string[]}>}
   *   blockers — перечень причин §5 при reason 'blocked'
   */
  async function save({
    slug = null, title, titleEn = null, description = '', descriptionEn = null,
    weight = 0, active = true, seriesIds = null,
  }) {
    const cleanTitle = String(title ?? '').trim();
    if (!cleanTitle || cleanTitle.length > 100) return { ok: false, reason: 'title' };
    const cleanTitleEn = titleEn ? String(titleEn).trim() : null;
    if (cleanTitleEn && cleanTitleEn.length > 100) return { ok: false, reason: 'title' };
    const cleanDescription = String(description ?? '').trim();
    if (cleanDescription.length > 500) return { ok: false, reason: 'description' };
    const cleanDescriptionEn = descriptionEn ? String(descriptionEn).trim() : null;
    if (cleanDescriptionEn && cleanDescriptionEn.length > 500) return { ok: false, reason: 'description' };
    const cleanWeight = Number(weight);
    if (!Number.isInteger(cleanWeight) || cleanWeight < 0 || cleanWeight > 999) {
      return { ok: false, reason: 'weight' };
    }
    const cleanSlug = String(slug ?? '').trim().toLowerCase();
    if (cleanSlug && !/^[a-z0-9-]{1,120}$/.test(cleanSlug)) return { ok: false, reason: 'slug' };

    // §5: публикация закрывается перечнем причин, и отказ происходит до
    // транзакции — иначе «нельзя опубликовать» оставило бы после себя
    // половину записей. Блокируется только перевод в «публичную» видимость:
    // уже активная строка (даже опустевшая по EC-C6) правится как прежде,
    // а создание черновика ничего о ней не проверяет.
    let original = null;
    if (cleanSlug) {
      const { rows } = await pool.query(
        'SELECT id, active, banner_image_id FROM e_collection WHERE slug = $1',
        [cleanSlug],
      );
      original = rows[0] ?? null;
    }
    if (active && (!original || !original.active)) {
      // Состав и описание с шага придут из формы, баннер в ней не меняется:
      // судить надо по будущему состоянию строки, иначе публикация
      // «включить с шестью добавленными сериалами» отвергалась бы по
      // прошлому (пустому) составу, и порог доезжал бы только за два шага.
      const keepCurrent = original !== null && seriesIds === null;
      const [visible, backdrop] = keepCurrent
        ? await Promise.all([
            visibleCountOf(pool, Number(original.id)),
            hasBackdrop(pool, Number(original.id)),
          ])
        : await Promise.all([
            visibleAmongIds(pool, cleanSeriesIds(seriesIds)),
            backdropAmongIds(pool, cleanSeriesIds(seriesIds)),
          ]);
      const blockers = publishBlockers(
        { banner_image_id: original ? original.banner_image_id : null, description_ru: cleanDescription },
        visible,
        backdrop,
      );
      if (blockers.length) return { ok: false, reason: 'blocked', blockers };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let id;
      if (cleanSlug) {
        const { rows } = await client.query(
          `UPDATE e_collection
              SET title_ru = $2, title_en = $3, description_ru = $4, description_en = $5,
                  weight = $6, active = $7
            WHERE slug = $1 RETURNING id`,
          [cleanSlug, cleanTitle, cleanTitleEn, cleanDescription, cleanDescriptionEn, cleanWeight, active],
        );
        if (!rows.length) {
          const { rows: created } = await client.query(
            `INSERT INTO e_collection
               (slug, title_ru, title_en, description_ru, description_en, weight, active, is_demo)
             VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE) RETURNING id`,
            [cleanSlug, cleanTitle, cleanTitleEn, cleanDescription, cleanDescriptionEn, cleanWeight, active],
          );
          id = created[0].id;
        } else {
          id = rows[0].id;
        }
      } else {
        const generated = `${slugify(cleanTitle)}-${crypto.randomUUID().slice(0, 6)}`;
        const { rows: created } = await client.query(
          `INSERT INTO e_collection
             (slug, title_ru, title_en, description_ru, description_en, weight, active, is_demo)
           VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE) RETURNING id`,
          [generated, cleanTitle, cleanTitleEn, cleanDescription, cleanDescriptionEn, cleanWeight, active],
        );
        id = created[0].id;
      }

      if (seriesIds !== null) {
        const ids = cleanSeriesIds(seriesIds);
        if (ids.length > MAX_SERIES) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'too_many' };
        }
        await client.query('DELETE FROM e_collection_item WHERE collection_id = $1', [id]);
        for (let i = 0; i < ids.length; i += 1) {
          await client.query(
            `INSERT INTO e_collection_item (collection_id, series_id, ordinal)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [id, ids[i], i],
          );
        }
      }

      await client.query('COMMIT');
      const { rows: [saved] } = await client.query('SELECT slug FROM e_collection WHERE id = $1', [id]);
      return { ok: true, slug: saved.slug };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') return { ok: false, reason: 'slug' };
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Переставить сериал в подборке.
   *
   * @param {{collectionId: number, seriesId: number, where: string}} input
   * @returns {Promise<boolean>}
   */
  async function reorder({ collectionId, seriesId, where = 'up' }) {
    const { rows } = await pool.query(
      'SELECT series_id, ordinal FROM e_collection_item WHERE collection_id = $1 ORDER BY ordinal',
      [collectionId],
    );
    const items = rows.map((row) => ({
      seriesId: Number(row.series_id),
      ordinal: Number(row.ordinal),
    }));
    const index = items.findIndex((item) => item.seriesId === Number(seriesId));
    if (index < 0) return false;

    let target = index;
    if (where === 'up') target = index - 1;
    else if (where === 'down') target = index + 1;
    else if (where === 'first') target = 0;
    else if (where === 'last') target = items.length - 1;
    if (target < 0 || target >= items.length || target === index) return false;

    const moved = items.splice(index, 1)[0];
    items.splice(target, 0, moved);
    for (let i = 0; i < items.length; i += 1) {
      await pool.query(
        'UPDATE e_collection_item SET ordinal = $3 WHERE collection_id = $1 AND series_id = $2',
        [collectionId, items[i].seriesId, i],
      );
    }
    return true;
  }

  return { list, one, save, reorder };
}

/**
 * Причина закрытой публикации.
 *
 * §5 перечисляет три причины в одном порядке — сериалы, описание, баннер;
 * этот порядок не поменяется: его читают тесты и админ.
 *
 * @param {object} row строка e_collection
 * @param {number} row.banner_image_id идентификатор своего баннера или null
 * @param {string|null} row.description_ru
 * @param {number} visible видимых сериaлов сегодня
 * @param {boolean} backdrop найдётся ли фон у видимых сериaлов (то же правило,
 *   по которому `bannerOf` берёт fallback)
 * @returns {string[]}
 */
function publishBlockers({ banner_image_id, description_ru }, visible, backdrop) {
  const blockers = [];
  if (visible < MIN_VISIBLE_SERIES) blockers.push('few_series');
  if (!String(description_ru ?? '').trim()) blockers.push('no_description_ru');
  if (banner_image_id == null && !backdrop) blockers.push('no_banner');
  return blockers;
}

/**
 * Есть ли у подборки фон на первом видимом сериале.
 *
 * Это тот же выбор, что у `bannerOf` (catalogue/banner.js): «первый» — по
 * порядку админа среди видимых, и любой такой фон годится. Правило одно
 * в обоих местах, иначе админ заблокирует публикацию по причине, которой
 * на странице не будет.
 *
 * @param {import('pg').Pool} pool
 * @param {number} collectionId
 * @returns {Promise<boolean>}
 */
async function hasBackdrop(pool, collectionId) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1
         FROM e_collection_item ci
         JOIN e_series s ON s.id = ci.series_id
         JOIN e_image i ON i.series_id = s.id AND i.role = 'backdrop'
        WHERE ci.collection_id = $1
          AND s.publication_state = 'published' AND s.archived_at IS NULL
     ) AS found`,
    [collectionId],
  );
  return Boolean(rows[0].found);
}

/**
 * Сколько из названных сериалов видно.
 *
 * Оценка будущего состава: транзакция запишет ровно эти сериалы, так что
 * решение о публикации принимается по ним, а не по составу прошлой строки.
 *
 * @param {import('pg').Pool} pool
 * @param {number[]} ids
 * @returns {Promise<number>}
 */
async function visibleAmongIds(pool, ids) {
  if (!ids.length) return 0;
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n
       FROM e_series
      WHERE id = ANY($1::int[])
        AND publication_state = 'published' AND archived_at IS NULL`,
    [ids],
  );
  return rows[0].n;
}

/**
 * Есть ли у названных сериалов фон.
 *
 * То же правило fallback-баннера, что у `bannerOf`: любого сериала с фоном
 * хватит, порядок не важен для существования.
 *
 * @param {import('pg').Pool} pool
 * @param {number[]} ids
 * @returns {Promise<boolean>}
 */
async function backdropAmongIds(pool, ids) {
  if (!ids.length) return false;
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM e_image
        WHERE series_id = ANY($1::int[]) AND role = 'backdrop'
     ) AS found`,
    [ids],
  );
  return Boolean(rows[0].found);
}

/**
 * Список сериалов формы — очистка в точности как в транзакции записи,
 * иначе прекCheck и запись разъехались бы на «1, 1, a» и «1».
 *
 * @param {any[]} list значения формы
 * @returns {number[]}
 */
function cleanSeriesIds(list) {
  return [...new Set((list ?? []).map(Number).filter(Number.isInteger))];
}

/**
 * Сколько видимых сериалов в подборке.
 *
 * @param {import('pg').Pool} pool
 * @param {number} collectionId
 * @returns {Promise<number>}
 */
async function visibleCountOf(pool, collectionId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n
       FROM e_collection_item ci
       JOIN e_series s ON s.id = ci.series_id
      WHERE ci.collection_id = $1
        AND s.publication_state = 'published' AND s.archived_at IS NULL`,
    [collectionId],
  );
  return rows[0].n;
}

/**
 * Состояние подборки из §6 фичи.
 *
 * Здесь не «флаг видимости», а то, чем живёт публичная выдача: правила
 * один с бегущей строкой главной — активна и не ниже порога видимых
 * сериалов (EC-C6). Опустевшая подборка остаётся у админа с пометкой,
 * а не исчезает из списка.
 *
 * @param {boolean} active
 * @param {number} visible видимых сериалов сегодня
 * @returns {'published'|'auto_hidden'|'draft'}
 */
export function collectionState(active, visible) {
  if (!active) return 'draft';
  return visible >= MIN_VISIBLE_SERIES ? 'published' : 'auto_hidden';
}

/**
 * Адрес подборки из названия.
 *
 * @param {string} title
 * @returns {string}
 */
function slugify(title) {
  const translit = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
    й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
    ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  const base = String(title ?? '').toLowerCase()
    .split('').map((letter) => translit[letter] ?? letter).join('');
  return base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
