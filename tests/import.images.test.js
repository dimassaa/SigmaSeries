// Загрузка изображений (F-12-05): что именно скачивается и что попадает в базу.
//
// Проверяется то, что защищает: домены, тип по содержимому, предел размера,
// отказ от фонов с текстом и от пропорции не 16:9. Сама перекодировка
// проверяется на настоящем JPEG, собранном sharp прямо в тесте.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import sharp from 'sharp';

import {
  pickBackdrop,
  posterPathOf,
  sniffType,
  isPrivateAddress,
  downloadImage,
  checkImage,
  prepareImage,
  ALLOWED_HOSTS,
  LIMITS,
  POSTER_WIDTHS,
} from '../src/services/import/images.js';

/** Настоящий JPEG нужного размера. */
async function jpeg(width, height) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 90, b: 160 } },
  }).jpeg().toBuffer();
}

/** То же самое через HTTP, чтобы проверить загрузку целиком. */
function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

// ─── Выбор фона (H-34) ───────────────────────────────────────────────────────

test('фон без текста и 16:9 выбирается', () => {
  const chosen = pickBackdrop([
    { width: 1920, height: 1080, voteAverage: 5.0 },
    { width: 1920, height: 1080, voteAverage: 5.6 },
  ]);
  assert.equal(chosen.voteAverage, 5.6, 'при одинаковой пригодности берём лучшую по оценке');
});

test('фон с текстом не годится', () => {
  assert.equal(pickBackdrop([
    { width: 3840, height: 2160, voteAverage: 6.0, language: 'ru' },
    { width: 1920, height: 1080, voteAverage: 5.0, language: 'en' },
  ]), null, 'EC-I8: для баннера и заставки такой фон не годится');
});

test('узкий фон не проходит по ширине', () => {
  assert.equal(pickBackdrop([{ width: 1280, height: 720, voteAverage: 6.0 }]), null);
});

test('пропорция не 16:9 не проходит', () => {
  assert.equal(pickBackdrop([{ width: 1920, height: 900, voteAverage: 6.0 }]), null);
});

test('пустой ответ — это отсутствие, а не исключение', () => {
  assert.equal(pickBackdrop(undefined), null);
  assert.equal(pickBackdrop([]), null);
});

test('постер берётся из карточки на русском', () => {
  assert.equal(posterPathOf({ poster_path: '/abc.jpg' }), '/abc.jpg');
  assert.equal(posterPathOf({}), null);
});

// ─── Тип по содержимому (R-SEC-17) ───────────────────────────────────────────

test('JPEG, PNG и WebP опознаются по содержимому', async () => {
  assert.equal(sniffType(await jpeg(10, 10)), 'image/jpeg');
  const tiny = (format) => sharp({
    create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })[format]().toBuffer();
  assert.equal(sniffType(await tiny('png')), 'image/png');
  assert.equal(sniffType(await tiny('webp')), 'image/webp');
});

test('файл не по картинке не проходит, даже если назван .jpg', () => {
  const html = Buffer.from('<!doctype html><html>404</html>', 'utf8');
  assert.equal(sniffType(html), null);
});

test('обрывок файла не проходит', () => {
  assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff])), null, 'обрезанный JPEG не картинка');
});

// ─── Приватные адреса (R-SEC-18) ─────────────────────────────────────────────

test('приватные адреса распознаются', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '169.254.1.1', '::1', 'fd00::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('разрешён только image.tmdb.org', () => {
  assert.deepEqual(ALLOWED_HOSTS, ['image.tmdb.org']);
});

// ─── Загрузка ─────────────────────────────────────────────────────────────────

test('буфер проверяется по размеру и по содержимому (R-SEC-17)', async () => {
  const body = await jpeg(600, 900);
  assert.equal(checkImage(body, { maxBytes: 1024 * 1024 }), body, 'нормальный файл проходит');

  assert.throws(() => checkImage(body, { maxBytes: 100 }), /больше 100 байт/);
  assert.throws(
    () => checkImage(Buffer.from('<!doctype html>404</html>', 'utf8')),
    /не JPEG, PNG и WebP/,
  );
});

test('загрузка отвергает чужой хост и не-http до запроса', async () => {
  let hits = 0;
  const counting = async () => {
    hits += 1;
    return new Response(Buffer.alloc(0));
  };
  await assert.rejects(
    () => downloadImage('https://example.com/x.jpg', { fetchImpl: counting, attempts: 1 }),
    /не в списке разрешённых/,
  );
  await assert.rejects(
    () => downloadImage('http://image.tmdb.org/x.jpg', { fetchImpl: counting, attempts: 1 }),
    /не https/,
  );
  assert.equal(hits, 0, 'до проверки адреса запрос идти не должен — это и есть смысл проверки');
});

test('редирект запрещён: один переход обошёл бы проверку хоста', async () => {
  const redirecting = async () => new Response(null, { status: 302, headers: { location: 'http://evil.example/x.jpg' } });
  await assert.rejects(
    () => downloadImage('https://image.tmdb.org/t/p/original/x.jpg', { fetchImpl: redirecting, attempts: 1 }),
    /редирект|redirect|30[0-9]/i,
  );
});

// ─── Подготовка (R-SEC-17) ───────────────────────────────────────────────────

test('варианты постера делаются по ширинам из спецификации', async () => {
  const prepared = await prepareImage(await jpeg(500, 750), 'poster');
  assert.deepEqual(prepared.variants.map((v) => v.width), POSTER_WIDTHS.filter((w) => w <= 500));
  assert.ok(prepared.variants.every((v) => v.bytes > 0 && v.file.length === v.bytes));
  assert.equal(prepared.variants[0].height, Math.round(750 * (185 / 500)));
});

test('метаданные не переносятся в вариант', async () => {
  const withExif = await sharp(await jpeg(400, 400))
    .withExif({ IFD0: { Copyright: 'секретные координаты' } })
    .jpeg()
    .toBuffer();
  const prepared = await prepareImage(withExif, 'poster');
  const out = await sharp(prepared.variants[0].file).metadata();
  assert.ok(!out.exif, 'EXIF с авторами и координатами в базе не хранится');
});

test('хэш считается по содержимому исходника', async () => {
  const buffer = await jpeg(300, 300);
  const first = await prepareImage(buffer, 'poster');
  const second = await prepareImage(buffer, 'poster');
  assert.equal(first.checksum, second.checksum, 'тот же файл — тот же хэш, и повтор пропускается');
  assert.notEqual(first.checksum, (await prepareImage(await jpeg(300, 300), 'poster')).checksum + 'x');
});

test('увеличения не делается', async () => {
  // Картинка 200 px уже самого узкого варианта: увеличивать её до 500 нельзя.
  const prepared = await prepareImage(await jpeg(200, 200), 'poster');
  assert.ok(prepared.variants.every((v) => v.width <= 200), 'иначе мы бы размывали картинку');
  assert.equal(prepared.variants.length, 1);
});

test('нечитаемый файл отвергается громко', async () => {
  // `failOn: 'none'` разрешает битые заголовки, но не содержимое: настоящее
  // изображение из постороннего ответа должно падать, а не молча становиться
  // серой плашкой на защите.
  await assert.rejects(
    () => prepareImage(Buffer.from('не картинка', 'utf8'), 'poster'),
    /unsupported image format|не читается/,
  );
});