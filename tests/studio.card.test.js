// Карточка сериала в студии (F-10-03) и жизненный цикл (F-10-06).
//
// Проверяется то, что легко сломать: ручная правка должна закрыть поле от
// импорта, версия должна расти, а два админа не должны затереть друг друга.

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { pgStudioCard } from '../src/services/studio/card.js';

const CONN = process.env.PGHOST && process.env.PGDATABASE
  ? {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER,
      database: process.env.PGDATABASE,
    }
  : process.env.TEST_DATABASE_URL
    ? { connectionString: process.env.TEST_DATABASE_URL }
    : null;

const skip = CONN ? false : 'нет подключения к базе — карточка не проверялась';

let pool;
let card;
let seriesId;

test.before(async () => {
  if (!CONN) return;
  pool = new pg.Pool(CONN);
  await pool.query('select 1');
  card = pgStudioCard(pool);

  // Свой сериал: тесты не должны трогать каталог.
  const { rows } = await pool.query(
    `INSERT INTO e_series (slug, imdb_key, title_ru, title_original, year_start, exit_state, publication_state, reasons, level)
     VALUES ($1, $2, 'Сериал для проверки', 'Check series', 2020, 'ended', 'imported', '{}', 'minimum')
     RETURNING id`,
    [`check-series-${crypto.randomUUID().slice(0, 8)}`, `tt${crypto.randomUUID().slice(0, 8)}`],
  );
  seriesId = rows[0].id;
});

test.after(async () => {
  if (pool && seriesId) {
    await pool.query('DELETE FROM e_series WHERE id = $1', [seriesId]);
  }
  if (pool) await pool.end();
});

test('карточка читается с происхождением полей (F-10-03 §7)', { skip }, async () => {
  const data = await card.read(seriesId);
  assert.equal(data.id, seriesId);
  assert.equal(data.origins.title_ru, 'import', 'до правки поле из импорта');
  assert.equal(data.fields.title_ru, 'Сериал для проверки');
  assert.ok(data.publishBlockers.includes('no_genre'), 'без жанра публикация закрыта');
});

test('ручная правка ставит блокировку поля и растит версию (F-10-03 §8а)', { skip }, async () => {
  const before = await card.read(seriesId);
  const result = await card.save(seriesId, {
    fields: { title_ru: 'Изменённое название' },
    version: before.version,
  });
  assert.equal(result.ok, true);
  assert.equal(result.version, before.version + 1, 'версия выросла');

  const after = await card.read(seriesId);
  assert.equal(after.fields.title_ru, 'Изменённое название');
  assert.equal(after.origins.title_ru, 'manual', 'поле помечено как ручное');

  const { rows } = await pool.query(
    'SELECT set_by FROM e_field_lock WHERE series_id = $1 AND field = $2',
    [seriesId, 'title_ru'],
  );
  assert.equal(rows.length, 1, 'блокировка поля записана');
});

test('чужая версия не затирает правку (EC-S2)', { skip }, async () => {
  const before = await card.read(seriesId);
  const stale = await card.save(seriesId, {
    fields: { title_en: 'Правка по старой версии' },
    version: before.version - 1,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'conflict', 'конфликт версий распознан');

  const after = await card.read(seriesId);
  assert.equal(after.fields.title_en, '', 'чужая правка не записана');
});

test('поле возвращается к импортированному значению (F-10-03 §8а)', { skip }, async () => {
  const reset = await card.resetField(seriesId, 'title_ru', null);
  assert.equal(reset, true, 'значение возвращено');
  const after = await card.read(seriesId);
  assert.equal(after.fields.title_ru, 'Сериал для проверки', 'вернулось импортированное');
  assert.equal(after.origins.title_ru, 'import', 'блокировка снята');
});

test('сброс поля попадает в историю карточки (F-10-06 §4)', { skip }, async () => {
  // Сброс — правка человека: по истории должно быть видно, что поле
  // возвращали к импорту. Раньше сброс поднимал версию, но записи в истории
  // не оставлял, и вернуть версию после него было нечем.
  await card.save(seriesId, { fields: { title_ru: 'Своё название' }, byId: null });
  const before = await card.history(seriesId);

  const reset = await card.resetField(seriesId, 'title_ru', null);
  assert.equal(reset, true, 'значение возвращено');

  const after = await card.history(seriesId);
  assert.equal(after.length, before.length + 1, 'в истории появилась запись');
  const last = after[0];
  assert.equal(last.source, 'manual', 'запись помечена как правка человека');
  assert.deepEqual(Object.keys(last.diff ?? {}), ['title_ru'], 'в записи — сброшенное поле');
  assert.equal(last.diff.title_ru.to, 'Сериал для проверки', 'вернулось импортированное значение');
});

test('без жанра опубликовать нельзя, с жанром — можно (F-10-06 §4)', { skip }, async () => {
  const blocked = await card.publish(seriesId, { byId: null });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'blocked');
  assert.ok(blocked.blockers.includes('no_genre'));

  const { rows } = await pool.query(
    `SELECT code FROM e_genre WHERE code NOT LIKE 'imdb:%' LIMIT 1`,
  );
  await card.save(seriesId, { genres: [rows[0].code] });

  const published = await card.publish(seriesId, { byId: null });
  assert.equal(published.ok, true, 'с жанром карточка публикуется');
  const after = await card.read(seriesId);
  assert.equal(after.publicationState, 'published');
});

test('архив и возврат меняют состояние (F-10-06 §4)', { skip }, async () => {
  await card.archive(seriesId, { byId: null, reason: 'проверка' });
  const archived = await card.read(seriesId);
  assert.equal(archived.publicationState, 'archived');
  assert.equal(archived.archived, true);

  const restored = await card.restore(seriesId, { byId: null });
  assert.equal(restored.ok, true);
  const after = await card.read(seriesId);
  assert.equal(after.publicationState, 'published');
  assert.equal(after.archived, false);
});

test('откат к прежней версии возвращает значения и закрывает поля (F-10-06 §4)', { skip }, async () => {
  const first = await card.save(seriesId, {
    fields: { title_ru: 'Название для отката' }, byId: null,
  });
  assert.equal(first.ok, true, 'первая правка сохранена');

  const second = await card.save(seriesId, {
    fields: { title_ru: 'Другое название' }, byId: null,
  });
  assert.equal(second.ok, true, 'вторая правка сохранена');

  const after = await card.read(seriesId);
  assert.equal(after.fields.title_ru, 'Другое название');

  const restored = await card.restoreVersion({ seriesId, version: first.version, byId: null });
  assert.equal(restored.ok, true, 'откат выполнен');
  assert.deepEqual(restored.restored, ['title_ru'], 'вернулось нужное поле');

  const back = await card.read(seriesId);
  assert.equal(back.fields.title_ru, 'Название для отката', 'значение прежнее');
  assert.equal(back.origins.title_ru, 'manual', 'поле закрыто от импорта');
  assert.equal(back.version, first.version + 2, 'откат — это новая версия');

  const history = await card.history(seriesId);
  assert.ok(history.length >= 3, 'в истории три версии');
  assert.equal(history[0].version, first.version + 2, 'последняя версия — откат');
});

test('фокальная точка ставится и сбрасывается (F-10-04, H-33)', { skip }, async () => {
  const { rows: [image] } = await pool.query(
    `INSERT INTO e_image (role, source, mime, width, height, focal_x, focal_y)
     VALUES ('poster', 'manual', 'image/webp', 185, 278, 0.667, 0.333) RETURNING id`,
  );
  await pool.query(
    `INSERT INTO e_image_variant (image_id, width, height, mime, file, bytes, checksum)
     VALUES ($1, 185, 278, 'image/webp', decode('00', 'hex'), 1, 'check-focal')`,
    [image.id],
  );
  await pool.query('UPDATE e_image SET series_id = $2 WHERE id = $1', [image.id, seriesId]);

  const set = await card.setFocal({ seriesId, role: 'poster', focalX: 40, focalY: 70 });
  assert.equal(set.ok, true, 'точка поставлена');
  const { rows: [after] } = await pool.query(
    'SELECT focal_x, focal_y FROM e_image WHERE id = $1', [image.id],
  );
  assert.equal(Number(after.focal_x), 0.4, 'точка сохранена в долях');
  assert.equal(Number(after.focal_y), 0.7);

  const out = await card.setFocal({ seriesId, role: 'poster', focalX: 150, focalY: 10 });
  assert.equal(out.ok, false, 'точка вне 0–100 не принимается');
  assert.equal(out.reason, 'range');

  const images = await card.images(seriesId);
  const poster = images.find((item) => item.role === 'poster');
  assert.ok(poster, 'изображение в списке');
  assert.equal(poster.focalX, 40, 'в процентах для интерфейса');

  await pool.query('DELETE FROM e_image WHERE id = $1', [image.id]);
});

test('причины и уровень пересчитываются после правки (F-10-03 §17)', { skip }, async () => {
  await card.save(seriesId, { fields: { description_ru: 'Описание для проверки' } });
  const after = await card.read(seriesId);
  assert.ok(!after.reasons.includes('no_overview_ru'), 'описание ru появилось');
});
