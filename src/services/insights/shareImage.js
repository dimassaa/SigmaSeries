// Картинка для шеринга (M7, F-07-03).
//
// PNG собирается на сервере: браузеру не нужно тянуть шрифты и собирать
// вёрстку (F-07-03 §8г). Ника, email, аватара и идентификатора на картинке
// нет ни при каких настройках — это свойство формата, а не настройка
// (F-07-03 §8а).
//
// `sharp` уже стоит в проекте (STACK.md §3, DEC-021): он перекодирует
// изображения, и собственный кодер PNG без шрифтов всё равно не дал бы
// читаемой картинки.

import sharp from 'sharp';

/** Размер картинки (F-07-03 §4). */
export const SHARE_WIDTH = 1080;
export const SHARE_HEIGHT = 1350;

/** Потолок размера (F-07-03 §9). */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Экранирование для XML.
 *
 * @param {unknown} value
 * @returns {string}
 */
function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Собирает картинку итогов.
 *
 * @param {object} args
 * @param {string} args.periodLabel период («Итоги за 2026»)
 * @param {Array<{value: string, label: string}>} [args.numbers] четыре числа
 * @param {{title: string}|null} [args.favourite] любимый сериал
 * @param {Buffer|null} [args.poster] постер любимого сериала
 * @returns {Promise<Buffer>} PNG
 */
export async function buildShareImage({ periodLabel, numbers = [], favourite = null, poster = null }) {
  const blocks = numbers.slice(0, 4).map((item, index) => `
    <text x="80" y="${560 + index * 150}" font-family="sans-serif" font-size="96" font-weight="700" fill="#ffffff">${xml(item.value)}</text>
    <text x="80" y="${610 + index * 150}" font-family="sans-serif" font-size="38" fill="#9aa4b2">${xml(item.label)}</text>`).join('');

  const favouriteBlock = favourite ? `
    <text x="80" y="1220" font-family="sans-serif" font-size="44" fill="#ffb703">${xml(favourite.title)}</text>` : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_WIDTH}" height="${SHARE_HEIGHT}">
  <rect width="${SHARE_WIDTH}" height="${SHARE_HEIGHT}" fill="#101014"/>
  <text x="80" y="150" font-family="sans-serif" font-size="72" font-weight="700" fill="#ffffff">${xml(periodLabel)}</text>
  <rect x="80" y="220" width="920" height="4" fill="#ffb703"/>
  ${blocks}
  ${favouriteBlock}
</svg>`;

  let image = sharp(Buffer.from(svg));

  if (poster) {
    // Постер подставляется поверх основы: иначе пришлось бы встраивать его
    // в разметку, а это base64 внутри SVG — картинка тяжелее вчетверо.
    const fitted = await sharp(poster)
      .resize(360, 520, { fit: 'cover', position: 'attention' })
      .png()
      .toBuffer();
    image = sharp(await image.png().toBuffer())
      .composite([{ input: fitted, left: 640, top: 640 }]);
  }

  let buffer = await image.png({ compressionLevel: 9 }).toBuffer();
  if (buffer.length > MAX_BYTES) {
    // Больше двух мегабайт картинка не должна занимать: такие файлы не
    // отправляются в мессенджерах, и человек решает, что делиться нечем.
    buffer = await sharp(buffer).png({ compressionLevel: 9, palette: true, quality: 80 }).toBuffer();
  }
  return buffer;
}
