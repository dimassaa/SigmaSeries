// Разбор тела multipart без сторонней библиотеки.
//
// `Request.formData()` из состава Node разбирает `multipart/form-data` сам:
// границы частей, заголовки частей и имя файла. Своя библиотека для этого
// не нужна, а лишняя зависимость в проекте была бы нарушением DEC-021
// («только реально нужное»).
//
// Тело приходит из `express.raw()` — это буфер, а не поток: разбор идёт по
// границе из заголовка `content-type`.

/**
 * Разобрать тело multipart.
 *
 * @param {object} req запрос Express с телом-буфером
 * @returns {Promise<FormData>} поля формы; файлы — значения с `arrayBuffer()`
 * @throws {Error} тело не multipart или не разобралось
 */
export async function readMultipart(req) {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('multipart/form-data')) {
    throw new Error('тело не multipart');
  }
  const request = new Request('http://localhost/upload', {
    method: 'POST',
    headers: { 'content-type': type },
    body: req.body,
  });
  return request.formData();
}
