// F-12-01 §4–§5: скачивание датасетов, повторы и целостность (EC-I1).
//
// Тест поднимает настоящий HTTP-сервер на 127.0.0.1 и гоняет через него
// настоящий `fetch`. Подмена `fetch` заглушкой ничего бы не проверяла: весь
// смысл этих проверок в потоковой записи, обрыве на середине и коде ответа.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { ensureDataset, DATASETS, isFresh } from '../src/services/import/datasets.js';
import { IMPORT_SETTINGS } from '../src/config/settings.js';

/** Поднимает сервер и возвращает его адрес. */
function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

const gzip = (text) => zlib.gzipSync(Buffer.from(text, 'utf8'));

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'imdb-dl-'));

/**
 * Параметры по умолчанию урезаются, чтобы тест не ждал настоящих 15 минут.
 *
 * @param {any} [extra]
 * @returns {any}
 */
const quick = (extra = {}) => ({
  maxBytes: 10 * 1024 * 1024,
  timeoutMs: 2000,
  attempts: IMPORT_SETTINGS.downloadAttempts,
  freshDays: IMPORT_SETTINGS.downloadFreshDays,
  sleep: async () => {},
  ...extra,
});

// ─── Свежесть (§5) ─────────────────────────────────────────────────────────────

test('свежий файл не перекачивается', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'title.ratings.tsv.gz');
  fs.writeFileSync(file, gzip('данные'));

  const { server, baseUrl } = await serve(() => {
    assert.fail('свежий файл не должен качаться заново');
  });
  try {
    const result = await ensureDataset(quick({ key: 'ratings', dir, baseUrl }));
    assert.equal(result.reused, true);
    assert.equal(result.path, file);
  } finally {
    server.close();
  }
});

test('старый файл считается несвежим', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'x.gz');
  fs.writeFileSync(file, gzip('данные'));
  const old = Date.now() - (IMPORT_SETTINGS.downloadFreshDays + 1) * 86_400_000;
  fs.utimesSync(file, new Date(old), new Date(old));
  assert.equal(isFresh(file, IMPORT_SETTINGS.downloadFreshDays), false);
  assert.equal(isFresh(file, 30), true);
});

// ─── Успешное скачивание ───────────────────────────────────────────────────────

test('файл скачивается и оказывается на месте целиком', async () => {
  const body = gzip('tconst\taverageRating\tnumVotes\n');
  const { server, baseUrl } = await serve((req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  const dir = tmpDir();
  try {
    const result = await ensureDataset(quick({ key: 'basics', dir, baseUrl }));
    assert.equal(result.reused, false);
    assert.equal(result.bytes, body.length);
    assert.equal(fs.readFileSync(result.path).length, body.length);
    assert.equal(result.path, path.join(dir, DATASETS.basics.file));
  } finally {
    server.close();
  }
});

// ─── EC-I1. Целостность ───────────────────────────────────────────────────────

test('на диске не остаётся временного файла', async () => {
  const body = gzip('данные');
  const { server, baseUrl } = await serve((_req, res) => res.end(body));
  const dir = tmpDir();
  try {
    const result = await ensureDataset(quick({ key: 'basics', dir, baseUrl }));
    assert.deepEqual(fs.readdirSync(dir), [DATASETS.basics.file]);
    assert.ok(result.path.endsWith('.gz'));
  } finally {
    server.close();
  }
});

test('файл больше потолка не принимается', async () => {
  // Случайные байты, а не повторяющиеся: gzip одинаковых символов жмёт в
  // сотни байт, и потолок не сработал бы никогда.
  const body = zlib.gzipSync(crypto.randomBytes(50_000));
  const { server, baseUrl } = await serve((_req, res) => {
    res.writeHead(200);
    // Отдаём тело по кускам: потолок должен сработать на середине, а не на
    // заголовке — Content-Length сервер может и не прислать.
    res.write(body.subarray(0, 10_000));
    res.end(body.subarray(10_000));
  });
  const dir = tmpDir();
  try {
    await assert.rejects(
      () => ensureDataset(quick({ key: 'basics', dir, baseUrl, maxBytes: 1024, attempts: 1 })),
      /больше|превыш|потолок/i,
    );
    assert.deepEqual(fs.readdirSync(dir), [], 'временный файл убран, каталог не испорчен');
  } finally {
    server.close();
  }
});

test('не архив gzip отвергается', async () => {
  const { server, baseUrl } = await serve((_req, res) => res.end('это не gzip'));
  const dir = tmpDir();
  try {
    await assert.rejects(
      () => ensureDataset(quick({ key: 'basics', dir, baseUrl, attempts: 1 })),
      /gzip|архив/i,
    );
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    server.close();
  }
});

// ─── §5. Повторы ───────────────────────────────────────────────────────────────

test('после двух неудач третья попытка доводит файл до конца', async () => {
  const body = gzip('ок');
  let hits = 0;
  const { server, baseUrl } = await serve((_req, res) => {
    hits += 1;
    if (hits < 3) {
      res.writeHead(503).end('пока не готов');
      return;
    }
    res.end(body);
  });
  const dir = tmpDir();
  try {
    const result = await ensureDataset(quick({ key: 'basics', dir, baseUrl }));
    assert.equal(hits, 3, 'ровно три попытки');
    assert.equal(result.bytes, body.length);
  } finally {
    server.close();
  }
});

test('после исчерпания попыток прогон падает, а каталог остаётся прежним', async () => {
  const { server, baseUrl } = await serve((_req, res) => res.writeHead(500).end('упало'));
  const dir = tmpDir();
  try {
    await assert.rejects(() => ensureDataset(quick({ key: 'basics', dir, baseUrl, attempts: 2 })), /попыт|500|не удал/i);
    assert.deepEqual(fs.readdirSync(dir), [], 'данные из прошлого прогона не тронуты');
  } finally {
    server.close();
  }
});

test('обрыв связи на середине не оставляет обрезанный файл', async () => {
  const body = gzip('x'.repeat(40_000));
  const { server, baseUrl } = await serve((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) });
    res.write(body.subarray(0, 1000));
    res.destroy();              // рвём соединение, не дописав файл
  });
  const dir = tmpDir();
  try {
    await assert.rejects(() => ensureDataset(quick({ key: 'basics', dir, baseUrl, attempts: 1 })));
    assert.deepEqual(fs.readdirSync(dir), [], 'половинчатый файл не остаётся в каталоге');
  } finally {
    server.close();
  }
});

test('таймаут обрывает скачивание', async () => {
  const { server, baseUrl } = await serve(() => {
    // Не отвечаем и не закрываем соединение: клиент обязан сдаться сам.
  });
  const dir = tmpDir();
  try {
    await assert.rejects(
      () => ensureDataset(quick({ key: 'basics', dir, baseUrl, attempts: 1, timeoutMs: 150 })),
      /таймаут|время|прерван/i,
    );
  } finally {
    server.close();
  }
});

// ─── Адреса ───────────────────────────────────────────────────────────────────

test('адреса датасетов ведут на datasets.imdbws.com', () => {
  // Не только `title.*`: люди лежат в `title.crew`, `title.principals` и
  // `name.basics`, и проверка на `title.` однажды обернулась бы ложной
  // тревогой на каждом новом файле.
  for (const { file, url } of Object.values(DATASETS)) {
    assert.equal(url, `https://datasets.imdbws.com/${file}`);
    assert.match(url, /^https:\/\/datasets\.imdbws\.com\/[a-z]+\.[a-z]+\.tsv\.gz$/);
    assert.equal(file.endsWith('.tsv.gz'), true);
  }
});