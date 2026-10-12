// QR-код для настройки 2FA.
//
// Рисуется на сервере и отдаётся как SVG: картинка в `<img>` не нужна, файл
// не хранится, а размер не зависит от того, отдаётся ли он отдельным
// запросом. Штрихи нарисованы прямоугольниками по данным `qrcode-generator` —
// растрового раунда нет, поэтому картинка остаётся резкой на любом экране и
// весит килобайты, а не десятки (R-DES-19: чёткость на плотных экранах).
//
// Библиотека выбрана в `STACK` §3: `qrcode-generator` — ноль зависимостей.

import qrcode from 'qrcode-generator';

/** Сторона одного модуля в пикселях. */
const MODULE_PX = 4;

/** Отступ вокруг кода в модулях. */
const MARGIN = 4;

/**
 * SVG с QR-кодом.
 *
 * @param {string} text содержимое, обычно адрес `otpauth://`
 * @param {object} [opts]
 * @param {string} [opts.alt] описание для скринридера
 * @returns {string} готовый SVG; пустая строка, если содержимое не помещается
 */
export function qrSvg(text, { alt = '' } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text), 'Byte');
  qr.make();

  const count = qr.getModuleCount();
  // Слишком длинный адрес в QR не помещается: молчаливый обрезок дал бы
  // человеку код, который не сканируется, и объяснить было бы нечем.
  if (count <= 0) return '';

  const side = count + MARGIN * 2;
  const size = side * MODULE_PX;

  const rects = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      const x = (col + MARGIN) * MODULE_PX;
      const y = (row + MARGIN) * MODULE_PX;
      // Ряд модулей склеивается в один прямоугольник: и разметка меньше, и
      // браузеру меньше узлов.
      rects.push(`M${x} ${y}h${MODULE_PX}v${MODULE_PX}h-${MODULE_PX}z`);
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"`,
    ` viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"`,
    alt ? ` role="img" aria-label="${escapeAttr(alt)}"` : ' aria-hidden="true"',
    '>',
    `<rect width="${size}" height="${size}" fill="#fff"/>`,
    `<path d="${rects.join('')}" fill="#000"/>`,
    '</svg>',
  ].join('');
}

/** Экранирование в атрибут: содержимое приходит из сессии, а не из базы. */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}