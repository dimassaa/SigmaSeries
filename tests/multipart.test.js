// Разбор тела multipart (F-10-04): из запроса в форма.
//
// Проверяется то, на чём держится загрузка изображения в студии: разбор не
// должен терять ни поля, ни байты файла. Ошибка здесь выглядит как «файл
// загрузился, но пустой», и заметить её можно только по содержимому.

import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { readMultipart } from '../src/services/http/multipart.js';

/** Тело multipart с полем и файлом. */
function multipartBody({ field, value, filename, content, type = 'image/png' }) {
  // Граница — только ASCII: она попадает в заголовок, а заголовок — это
  // ByteString, и кириллица в нём недопустима.
  const boundary = '----proverka-multipart-42';
  const head = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="${field}"\r\n\r\n`
    + `${value}\r\n`
    + `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + `Content-Type: ${type}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    boundary,
    body: Buffer.concat([head, content, tail]),
  };
}

/** Запрос в виде, в котором его видит Express. */
function request(body, boundary) {
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  };
}

test('поле и файл доезжают из тела в форму', async () => {
  const png = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).png().toBuffer();

  const { boundary, body } = multipartBody({
    field: 'role',
    value: 'poster',
    filename: 'обложка.png',
    content: png,
  });

  const form = await readMultipart(request(body, boundary));
  assert.equal(form.get('role'), 'poster');

  const file = form.get('file');
  assert.ok(file && typeof file.arrayBuffer === 'function', 'файл пришёл файлом, а не строкой');
  assert.equal(file.name, 'обложка.png');
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(bytes.length, png.length, 'байты файла не потерялись');
  assert.ok(bytes.equals(png), 'содержимое файла совпадает с исходным');
});

test('тело не multipart отвергается', async () => {
  await assert.rejects(
    () => readMultipart({ headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') }),
    /multipart/,
    'не multipart не должен молча разбираться в пустую форму',
  );
});
