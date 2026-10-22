// Загрузка и подготовка изображений (F-12-05).
//
// Правила не украшают картинки, а защищают от двух вещей: чужой файл из
// интернета (R-SEC-18 — только домены TMDB, без переходов наружу и без
// приватных адресов) и чужой формат (R-SEC-17 — тип по содержимому, без
// метаданных, имена генерируются).
//
// Свой JPEG-декодер здесь означал бы сотни строк спецификации и ошибку,
// которую заметил бы человек на защите, — `sharp` разрешён `STACK` §3.

import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

import sharp from 'sharp';

/** Домены, с которых разрешено брать картинки (R-SEC-18). */
export const ALLOWED_HOSTS = ['image.tmdb.org'];

/** Исходник: 15 МБ, 10 секунд (§9). */
export const LIMITS = {
  maxBytes: 15 * 1024 * 1024,
  timeoutMs: 10_000,
  maxPixels: 40_000_000,
};

/** Ширины вариантов (§7, помечено [ГИПОТЕЗА], подтверждено `/configuration`). */
export const POSTER_WIDTHS = [185, 342, 500];
export const BACKDROP_WIDTHS = [780, 1280, 1920];

/** Формат хранения: WebP с меньшим весом, JPEG остаётся запасным (Фаза 7). */
const VARIANT_MIME = 'image/webp';

/**
 * Фон для баннера: без текста, шириной ≥ 1920 и пропорцией около 16:9 (H-34).
 *
 * @param {Array<{width: number, height: number, voteAverage: number,
 *   language?: string|null, filePath?: string}>} backdrops
 * @returns {any|null}
 */
export function pickBackdrop(backdrops) {
  if (!Array.isArray(backdrops)) return null;
  const ratio = (row) => (row.height ? row.width / row.height : 0);
  const candidates = backdrops
    .filter((row) => row.width >= 1920)
    .filter((row) => !row.language)
    .filter((row) => Math.abs(ratio(row) - 16 / 9) <= 0.05);
  if (!candidates.length) return null;
  // При одинаковой пригодности берём тот, у которого выше оценка: это
  // единственный сигнал качества, который TMDB отдаёт.
  const best = candidates.sort((a, b) => b.voteAverage - a.voteAverage)[0];
  return { ...best, file_path: best.filePath };
}

/**
 * Постер: путь из карточки на `ru-RU` (§4).
 *
 * @param {any} details
 * @returns {string|null}
 */
export function posterPathOf(details) {
  return details?.poster_path ?? null;
}

/**
 * Тип файла по содержимому, а не по заголовку (R-SEC-17).
 *
 * @param {Buffer} buffer
 * @returns {string|null} `image/jpeg`, `image/png`, `image/webp` либо null
 */
export function sniffType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * Приватный ли адрес.
 *
 * Защита от «ссылка на 127.0.0.1» внутри разрешённого домена нужна даже при
 * фиксированном списке хостов: DNS отвечает, а ответ может вести внутрь.
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

/**
 * Проверяет адрес перед запросом (R-SEC-18).
 *
 * @param {string} url
 * @returns {Promise<void>}
 * @throws {Error} если хост не TMDB или резолвится внутрь сети
 */
export async function assertAllowedUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`не https: ${parsed.protocol}`);
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new Error(`хост ${parsed.hostname} не в списке разрешённых`);
  }
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  if (!addresses.length) throw new Error('хост не разрешается');
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new Error(`хост указывает на внутренний адрес ${address}`);
  }
}

/**
 * Проверяет скачанный файл: размер и тип по содержимому (R-SEC-17).
 *
 * Отдельная функция, а не строчка внутри загрузки, потому что проверку надо
 * тестировать на настоящем файле: подменить адрес хоста ради теста означало бы
 * ослабить ровно ту проверку, ради которой всё и затевалось.
 *
 * @param {Buffer} buffer
 * @param {{maxBytes?: number}} [options]
 * @returns {Buffer} тот же буфер
 * @throws {Error}
 */
export function checkImage(buffer, { maxBytes = LIMITS.maxBytes } = {}) {
  if (buffer.length > maxBytes) throw new Error(`файл больше ${maxBytes} байт`);
  if (!sniffType(buffer)) throw new Error('файл не JPEG, PNG и WebP по содержимому');
  return buffer;
}

/**
 * Скачивает картинку с проверками (§9).
 *
 * Переходы за пределы разрешённых доменов запрещены: по умолчанию fetch идёт
 * за редиректом, и один переход на чужой хост обошёл бы всю проверку.
 *
 * @param {string} url путь вида `/abc.jpg` на `image.tmdb.org`
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.maxBytes]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.attempts]
 * @returns {Promise<Buffer>}
 */
export async function downloadImage(url, {
  fetchImpl = fetch,
  maxBytes = LIMITS.maxBytes,
  timeoutMs = LIMITS.timeoutMs,
  attempts = 3,
} = {}) {
  // TMDB отдаёт путь (`/abc.jpg`), а не адрес. Без префикса `/t/p/original`
  // сервер отвечает 404, и это выглядело бы как «у сериала нет картинки».
  const full = url.startsWith('http') ? url : `https://image.tmdb.org/t/p/original${url}`;
  await assertAllowedUrl(full);

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(full, { signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error(`TMDB отвечает ${response.status}`);

      return checkImage(Buffer.from(await response.arrayBuffer()), { maxBytes });
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`не удалось загрузить изображение за ${attempts} попыток: ${lastError?.message ?? '—'}`);
}

/**
 * Перекодирует картинку и делает варианты (R-SEC-17).
 *
 * Метаданные не переносятся: в JPEG и WebP лежат EXIF с координатами съёмки,
 * моделью камеры и иногда — геолокация. В нашей базе им не место.
 *
 * @param {Buffer} buffer исходник
 * @param {'poster'|'backdrop'|'banner'|'splash'} role
 * @returns {Promise<{width:number, height:number, mime:string, checksum:string,
 *   cleanBackdrop:boolean, variants:{width:number, height:number, bytes:number, file:Buffer}[]}>}
 */
export async function prepareImage(buffer, role) {
  const image = sharp(buffer, { failOn: 'none' });
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error('изображение не читается');
  if (meta.width * meta.height > LIMITS.maxPixels) {
    throw new Error(`изображение слишком большое: ${meta.width}×${meta.height}`);
  }

  const widths = role === 'poster' ? POSTER_WIDTHS : BACKDROP_WIDTHS;
  const variants = [];
  for (const width of widths) {
    // Увеличения не делаем: размытая картинка хуже отсутствующей, а бюджет
    // базы ограничен (§7).
    if (width > meta.width) continue;
    const { data, info } = await image
      .clone()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    variants.push({
      width: info.width,
      height: info.height,
      bytes: info.size,
      file: data,
      checksum: sha256(data),
    });
  }

  if (!variants.length) {
    // Картинка меньше самого узкого варианта: сохраняем как есть, иначе она
    // потерялась бы совсем.
    const { data, info } = await image.clone().webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
    variants.push({
      width: info.width,
      height: info.height,
      bytes: info.size,
      file: data,
      checksum: sha256(data),
    });
  }

  const full = variants[variants.length - 1];
  return {
    width: full.width,
    height: full.height,
    mime: VARIANT_MIME,
    checksum: sha256(buffer),
    cleanBackdrop: role === 'backdrop',
    variants,
  };
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Пишет картинку и её варианты в базу.
 *
 * Повторная загрузка того же файла не создаёт новых строк: хэш совпал —
 * картинка та же (§5).
 *
 * @param {object} deps
 * @param {any} deps.client подключение внутри транзакции
 * @param {number} deps.seriesId
 * @param {'poster'|'backdrop'|'banner'|'splash'} deps.role
 * @param {'tmdb'|'manual'} deps.source
 * @param {string} deps.sourcePath путь в источнике
 * @param {any} deps.prepared результат `prepareImage`
 * @returns {Promise<{imageId:number, changed:boolean}>}
 */
export async function saveImage({ client, seriesId, role, source, sourcePath, prepared }) {
  const { rows: known } = await client.query(
    `SELECT id, checksum FROM e_image WHERE series_id = $1 AND role = $2 AND source = $3`,
    [seriesId, role, source],
  );
  if (known[0]?.checksum === prepared.checksum) return { imageId: known[0].id, changed: false };

  const { rows } = await client.query(
    `INSERT INTO e_image (role, series_id, source, source_path, checksum, width, height, mime, alt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      role,
      seriesId,
      source,
      sourcePath,
      prepared.checksum,
      prepared.width,
      prepared.height,
      prepared.mime,
      null,
    ],
  );

  let imageId = rows[0]?.id;
  if (!imageId) {
    const existing = await client.query(
      'SELECT id FROM e_image WHERE series_id = $1 AND role = $2 AND source = $3',
      [seriesId, role, source],
    );
    imageId = existing.rows[0].id;
    await client.query('UPDATE e_image SET checksum = $2, width = $3, height = $4 WHERE id = $1', [
      imageId, prepared.checksum, prepared.width, prepared.height,
    ]);
  }

  await client.query('DELETE FROM e_image_variant WHERE image_id = $1', [imageId]);
  for (const variant of prepared.variants) {
    await client.query(
      `INSERT INTO e_image_variant (image_id, width, height, file, mime, bytes, checksum)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (image_id, width) DO UPDATE SET
         height = EXCLUDED.height, file = EXCLUDED.file, mime = EXCLUDED.mime,
         bytes = EXCLUDED.bytes, checksum = EXCLUDED.checksum`,
      [imageId, variant.width, variant.height, variant.file, VARIANT_MIME, variant.bytes, variant.checksum],
    );
  }

  return { imageId, changed: true };
}