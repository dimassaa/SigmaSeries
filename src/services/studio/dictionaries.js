// Справочники студии: жанры, платформы рейтингов, страны (F-10-10, S-80).
//
// Жанры и платформы — редактируемые: у платформы нельзя менять шкалу, если
// по ней уже есть значения, иначе значения станут неверными (F-10-10 §8).
// Страны — просто коды ISO 3166-1: своей таблицы у них нет, а названия
// даёт `Intl.DisplayNames` (H-49).

/** Страны: коды ISO 3166-1, которые встречаются в каталоге. */
const COUNTRY_CODES = [
  'AR', 'AU', 'BE', 'BR', 'CA', 'CN', 'CZ', 'DE', 'DK', 'ES', 'FI', 'FR', 'GB',
  'HK', 'HU', 'IE', 'IL', 'IN', 'IT', 'JP', 'KR', 'MX', 'NL', 'NO', 'NZ', 'PL',
  'PT', 'RU', 'SE', 'TR', 'UA', 'US',
];

/**
 * Справочники студии.
 *
 * @param {import('pg').Pool} pool
 */
export function pgStudioDictionaries(pool) {
  /**
   * Жанры.
   *
   * @returns {Promise<object[]>}
   */
  async function genres() {
    const { rows } = await pool.query(
      `SELECT g.code, g.name_ru, g.name_en, g.active, g.is_raw,
              (SELECT count(*)::int FROM e_series_genre sg WHERE sg.genre_code = g.code) AS series_count
         FROM e_genre g
        ORDER BY g.name_ru`,
    );
    return rows.map((row) => ({
      code: row.code,
      nameRu: row.name_ru,
      nameEn: row.name_en,
      active: Boolean(row.active),
      seriesCount: Number(row.series_count),
      // Сырые жанры импорта правке не подлежат: у них нет названия, и они не
      // из справочника.
      raw: Boolean(row.is_raw),
    }));
  }

  /**
   * Сохранить жанр.
   *
   * @param {object} input
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function saveGenre({ code, nameRu, nameEn, active = true }) {
    if (!/^[a-z0-9-]{1,60}$/.test(String(code ?? ''))) return { ok: false, reason: 'code' };
    const ru = String(nameRu ?? '').trim();
    const en = String(nameEn ?? '').trim();
    if (!ru || ru.length > 100) return { ok: false, reason: 'name' };
    const { rowCount } = await pool.query(
      `INSERT INTO e_genre (code, name_ru, name_en, active)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE
         SET name_ru = EXCLUDED.name_ru, name_en = EXCLUDED.name_en, active = EXCLUDED.active`,
      [code, ru, en || ru, active],
    );
    return { ok: rowCount > 0 };
  }

  /**
   * Платформы рейтингов.
   *
   * @returns {Promise<object[]>}
   */
  async function platforms() {
    const { rows } = await pool.query(
      `SELECT p.code, p.name, p.scale_max, p.priority, p.active,
              (SELECT count(*)::int FROM e_external_rating r WHERE r.platform = p.code) AS ratings
         FROM e_rating_platform p
        ORDER BY p.priority, p.name`,
    );
    return rows.map((row) => ({
      code: row.code,
      name: row.name,
      scaleMax: Number(row.scale_max),
      priority: Number(row.priority),
      active: Boolean(row.active),
      ratings: Number(row.ratings),
    }));
  }

  /**
   * Сохранить платформу.
   *
   * @param {object} input
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function savePlatform({ code, name, scaleMax, priority = 100, active = true }) {
    const cleanName = String(name ?? '').trim();
    if (!cleanName || cleanName.length > 100) return { ok: false, reason: 'name' };
    const scale = Number(scaleMax);
    if (!Number.isFinite(scale) || scale <= 0) return { ok: false, reason: 'scale' };

    // Шкалу платформы с данными менять нельзя: значения станут неверными.
    const { rows: [current] } = await pool.query(
      'SELECT scale_max FROM e_rating_platform WHERE code = $1', [code],
    );
    if (current && Number(current.scale_max) !== scale) {
      const { rows: [used] } = await pool.query(
        'SELECT count(*)::int AS n FROM e_external_rating WHERE platform = $1', [code],
      );
      if (used.n > 0) return { ok: false, reason: 'scale_in_use' };
    }

    const { rowCount } = await pool.query(
      `INSERT INTO e_rating_platform (code, name, scale_max, priority, active)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name, scale_max = EXCLUDED.scale_max,
             priority = EXCLUDED.priority, active = EXCLUDED.active`,
      [code, cleanName, scale, Number(priority) || 100, active],
    );
    return { ok: rowCount > 0 };
  }

  /**
   * Страны: код и название по `Intl.DisplayNames`.
   *
   * @param {string} locale
   * @returns {Promise<object[]>}
   */
  async function countries(locale = 'ru') {
    const names = new Intl.DisplayNames([locale], { type: 'region' });
    return COUNTRY_CODES.map((code) => ({
      code,
      title: names.of(code) ?? code,
    }));
  }

  return { genres, saveGenre, platforms, savePlatform, countries };
}
