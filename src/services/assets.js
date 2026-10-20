// Сжатие статики.
//
// Таблица стилей и клиентский скрипт весят больше сотни килобайт, а
// страница тянет их на каждом переходе. По локальной сети это незаметно, по
// обычной — заметно: без сжатия браузер получает полтора мегабайта за
// десяток переходов.
//
// Сжатие делает zlib из состава Node: зависимость не добавляется, а тело
// ответа один раз сжимается и лежит в памяти — на каждый запрос не
// считается заново.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/** Сжатое тело лежит здесь: путь → { raw, gz, mtimeMs }. */
const cache = new Map();

/**
 * Тело файла, пригодное для ответа: сырое или сжатое.
 *
 * @param {string} file путь к файлу
 * @param {boolean} wantGzip прислать сжатое
 * @returns {Promise<{body: Buffer, type: string}>}
 */
async function bodyOf(file, wantGzip) {
  const info = await stat(file);
  let entry = cache.get(file);
  if (!entry || entry.mtimeMs !== info.mtimeMs) {
    const raw = await readFile(file);
    entry = { raw, gz: await gzipAsync(raw), mtimeMs: info.mtimeMs };
    cache.set(file, entry);
  }
  return {
    body: wantGzip ? entry.gz : entry.raw,
    type: TYPES[path.extname(file)] ?? 'application/octet-stream',
  };
}

/**
 * Middleware сжатия для таблиц стилей и скриптов.
 *
 * Отвечает только за те файлы, что лежат в каталоге `public` и кончаются на
 * `.css` или `.js`; всё остальное уходит дальше, к обычной отдаче статики.
 *
 * @param {string} publicDir каталог со статикой
 * @returns {import('express').RequestHandler}
 */
export function compressedStatic(publicDir) {
  return async function compressStatic(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const type = TYPES[path.extname(req.path)];
    if (!type) return next();

    // Путь не должен выйти за пределы каталога: `..` в адресе не должен
    // приводить к файлу рядом с ним.
    const file = path.join(publicDir, path.normalize(req.path));
    if (!file.startsWith(publicDir + path.sep)) return next();

    const accept = String(req.headers['accept-encoding'] ?? '');
    const wantGzip = /\bgzip\b/.test(accept);

    try {
      const { body } = await bodyOf(file, wantGzip);
      res.set('Content-Type', type);
      res.set('Cache-Control', 'public, max-age=3600');
      res.set('Vary', 'Accept-Encoding');
      if (wantGzip) res.set('Content-Encoding', 'gzip');
      res.set('Content-Length', String(body.length));
      res.end(req.method === 'HEAD' ? undefined : body);
      return undefined;
    } catch (error) {
      if (error?.code === 'ENOENT') return next();
      return next(error);
    }
  };
}
