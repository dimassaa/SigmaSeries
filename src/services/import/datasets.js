// Скачивание датасетов IMDb (F-12-01 §4, §5, §9; EC-I1).
//
// Правила, которые здесь закреплены, взяты не из соображений удобства:
//
//   • файл качается во временное имя и переезжает на место только после
//     проверки целостности (EC-I1). Датасеты IMDb обновляются прямо во время
//     скачивания, и переименованный на месте обрыв приводит к тому, что
//     следующий прогон читает недописанный файл и падает «схема изменилась»;
//   • три попытки, потом ошибка (§5): предыдущие данные при этом остаются;
//   • потолок на размер и таймаут — защита диска и сети, а не формальность.
//
// Ключ TMDB здесь ни при чём: он нужен сопоставлению (F-12-02), а не отбору.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Официальные адреса датасетов. */
export const DATASETS = {
  basics: { file: 'title.basics.tsv.gz', url: 'https://datasets.imdbws.com/title.basics.tsv.gz' },
  ratings: { file: 'title.ratings.tsv.gz', url: 'https://datasets.imdbws.com/title.ratings.tsv.gz' },
  // Люди (F-12-03 §4(3)). `title.principals` — самый крупный файл проекта:
  // 750 МБ, и он читается потоком: целиком в память он не влезает.
  crew: { file: 'title.crew.tsv.gz', url: 'https://datasets.imdbws.com/title.crew.tsv.gz' },
  principals: { file: 'title.principals.tsv.gz', url: 'https://datasets.imdbws.com/title.principals.tsv.gz' },
  names: { file: 'name.basics.tsv.gz', url: 'https://datasets.imdbws.com/name.basics.tsv.gz' },
};

const DAY_MS = 86_400_000;

/** Пауза между попытками: 1 с, 2 с, 4 с — как в почтовой очереди. */
const RETRY_WAIT_MS = [1000, 2000, 4000];

/**
 * Свежий ли файл.
 *
 * @param {string} file путь
 * @param {number} freshDays сколько дней файл считается пригодным
 * @returns {boolean} `false`, если файла нет — тогда качать обязательно
 */
export function isFresh(file, freshDays) {
  try {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    return age <= freshDays * DAY_MS;
  } catch {
    return false;
  }
}

/** Первые два байта: сигнатура gzip (RFC 1952). */
async function looksLikeGzip(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(2), 0, 2, 0);
    return bytesRead === 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  } finally {
    await handle.close();
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Одна попытка: скачать в `dest + '.part'` и переименовать на месте.
 *
 * Имя `dest` файл получает только после проверки целостности (EC-I1): если
 * переименовать сразу, битый архив или страница ошибки остался бы под
 * боевым именем, и следующий прогон счёл бы его свежим, а потом споткнулся бы
 * на заголовке.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {string} options.dest
 * @param {number} options.maxBytes потолок на размер файла
 * @param {number} options.timeoutMs
 * @returns {Promise<{bytes:number}>}
 */
async function downloadOnce({ url, dest, maxBytes, timeoutMs }) {
  const part = `${dest}.part`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response;
    try {
      response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`таймаут ${timeoutMs} мс: сервер не отдал файл за это время`);
      }
      throw error;
    }
    if (!response.ok) throw new Error(`сервер ответил ${response.status}`);
    if (!response.body) throw new Error('ответ без тела');

    let bytes = 0;
    const counter = new TransformStream({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          // Останавливаемся сами: дочитывать файл ради того, чтобы выбросить
          // его, — это ровно та нагрузка на диск, от которой мы защищаемся.
          controller.error(new Error(`файл больше потолка ${maxBytes} байт`));
          return;
        }
        controller.enqueue(chunk);
      },
    });

    const source = Readable.fromWeb(response.body.pipeThrough(counter));
    await pipeline(source, fs.createWriteStream(part));

    if (!(await looksLikeGzip(part))) {
      throw new Error('скачанное не gzip, а что-то другое: повреждённый архив или страница вместо файла');
    }

    await fsp.rename(part, dest);
    return { bytes };
  } finally {
    clearTimeout(timer);
    await fsp.rm(part, { force: true });
  }
}

/**
 * Готовит датасет на диске: свежий — берём как есть, иначе качаем.
 *
 * @param {object} options
 * @param {'basics'|'ratings'|'crew'|'principals'|'names'} options.key
 *   Ключ из `DATASETS`; перечисление написано словами, потому что `keyof` по
 *   значению не даёт ключа, пригодного для поиска по объекту.
 * @param {string} options.dir каталог для датасетов
 * @param {string} [options.baseUrl] адрес источника; по умолчанию официальный
 * @param {number} options.maxBytes
 * @param {number} options.timeoutMs
 * @param {number} options.attempts
 * @param {number} options.freshDays
 * @param {(ms:number) => Promise<void>} [options.sleep] пауза между попытками
 * @returns {Promise<{path:string, reused:boolean, bytes:number}>}
 */
export async function ensureDataset({
  key,
  dir,
  baseUrl = 'https://datasets.imdbws.com',
  maxBytes,
  timeoutMs,
  attempts,
  freshDays,
  sleep = wait,
}) {
  const dataset = DATASETS[key];
  if (!dataset) throw new Error(`неизвестный датасет «${key}»`);

  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, dataset.file);

  if (isFresh(dest, freshDays)) {
    return { path: dest, reused: true, bytes: fs.statSync(dest).size };
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { bytes } = await downloadOnce({
        url: `${baseUrl}/${dataset.file}`,
        dest,
        maxBytes,
        timeoutMs,
      });
      return { path: dest, reused: false, bytes };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(RETRY_WAIT_MS[Math.min(attempt - 1, RETRY_WAIT_MS.length - 1)]);
      }
    }
  }

  throw new Error(
    `датасет ${dataset.file} не скачался за ${attempts} попыток: ${lastError?.message ?? 'причина неизвестна'}`,
    { cause: lastError },
  );
}