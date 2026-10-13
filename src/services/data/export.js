// Сборка файла выгрузки (F-01-10 §4).
//
// Файл — это ровно те данные, которые названы в фиче: профиль, настройки,
// статусы, отметки, оценки, свои материалы, уведомления и устройства. Не
// больше: чужое и служебные заметки модерации в выгрузку не попадают (§8), а
// секреты — тем более.
//
// Собирается функция, а не хранилище: состав выгрузки — решение продукта, и
// проверять его дешевле без базы.

import crypto from 'node:crypto';

import { AUTH } from '../../config/settings.js';

/**
 * @param {object} mine данные пользователя, уже собранные хранилищем
 * @param {object} theirs то, что в выгрузку не попадает; передаётся, чтобы
 *   тест мог убедиться, что чужие данные отсеяны на входе, а не подмешались
 *   в файл на выходе
 * @returns {{json:string, sha256:Buffer, size:number}}
 */
export function buildExport(mine, theirs) {
  void theirs;

  const file = {
    // Версия и дата: файл может пережить сервис, и через год должен быть
    // понятно, в каком формате он выгружен.
    format: 'sigmaseries-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: pick(mine.profile, [
      'nickname', 'locale', 'theme', 'timezone',
      'emailConfirmed', 'registeredAt', 'lastActiveAt',
      'recsEnabled', 'profilePublic', 'statsPublic',
      'notificationsEnabled', 'quietHours',
    ]),
    watchStatus: mine.watchStatus ?? [],
    watchMarks: mine.watchMarks ?? [],
    ratings: mine.ratings ?? [],
    materials: (mine.materials ?? []).map((m) => pick(m, ['kind', 'body', 'state', 'createdAt'])),
    notifications: (mine.notifications ?? []).map((n) => pick(n, ['kind', 'category', 'params', 'createdAt'])),
    // Устройства без идентификатора сессии: он секрет, по нему входят.
    devices: (mine.devices ?? []).map((d) => pick(d, ['label', 'createdAt', 'lastSeenAt', 'revokedAt'])),
  };

  const json = JSON.stringify(file, null, 2);
  return {
    json,
    sha256: crypto.createHash('sha256').update(json, 'utf8').digest(),
    size: Buffer.byteLength(json, 'utf8'),
  };
}

/**
 * Превышает ли файл предел (F-01-10 §9).
 *
 * Считаются байты, а не символы: кириллица занимает два байта, и файл,
 * который «влез» в 50 МБ символов, на диске вдвое больше.
 *
 * @param {string} json
 * @param {number} limitBytes
 */
export function tooBigToExport(json, limitBytes = AUTH.exportMaxMb * 1024 * 1024) {
  return Buffer.byteLength(json, 'utf8') > limitBytes;
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source && key in source) out[key] = source[key];
  }
  return out;
}