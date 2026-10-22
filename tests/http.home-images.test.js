// Картинки на главной (S-01).
//
// Проверяется то, что было сломано и не выглядело сломанным: источник отдавал
// `posterUrl: естьКартинка ? null : null`, то есть всегда `null`, и главная
// годами показывала заглушку вместо постера, оставаясь зелёной во всех
// остальных проверках.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { pgData } from '../src/services/home/data.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — картинки главной не проверялись';

let pool;
let server;
let baseUrl;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  // `pool` нужен маршруту картинок: проверка идёт от ссылки на главной до
  // ответа сервера, а не до строки в разметке.
  const app = createApp({ data: pgData(pool), pool });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve(undefined);
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
});

const get = (path) => fetch(`${baseUrl}${path}`);

/** Адрес картинки каталога сериала, у которого постер точно есть. */
async function slugWithPoster() {
  const { rows } = await pool.query(`
    SELECT s.slug FROM e_series s
     WHERE s.publication_state = 'published' AND s.archived_at IS NULL
       AND EXISTS (SELECT 1 FROM e_image i JOIN e_image_variant iv ON iv.image_id = i.id
                    WHERE i.series_id = s.id AND i.role = 'poster')
     LIMIT 1`);
  return rows[0]?.slug;
}

test('у сериала с постером главная показывает картинку, а не заглушку', { skip }, async () => {
  const slug = await slugWithPoster();
  assert.ok(slug, 'в базе есть опубликованный сериал с постером');

  const home = await (await get('/ru/')).text();
  // Постеры главной берутся из блока «свежее» — сериалы с выходом за 14 дней.
  // Такой есть не всегда, поэтому проверяем сам факт: раз на главной есть
  // сериал с постером, ссылка на картинку обязана быть.
  const { rows } = await pool.query(`
    SELECT s.slug FROM e_series s
     WHERE s.publication_state = 'published' AND s.archived_at IS NULL
       AND s.exit_state IN ('airing','announced')
       AND EXISTS (SELECT 1 FROM e_season se JOIN e_release rel ON rel.season_id = se.id
                    WHERE se.series_id = s.id
                      AND rel.release_date <= CURRENT_DATE
                      AND rel.release_date >= CURRENT_DATE - INTERVAL '14 days')
       AND EXISTS (SELECT 1 FROM e_image i JOIN e_image_variant iv ON iv.image_id = i.id
                    WHERE i.series_id = s.id AND i.role = 'poster')
     LIMIT 1`);

  if (!rows.length) {
    assert.match(home, /class="posters"/, 'блок «свежее» на месте даже без картинок');
    return;
  }

  const posters = [...home.matchAll(/class="poster__img" src="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(posters.length > 0, `у ${rows[0].slug} есть постер, а главная его не показала`);
  assert.ok(posters.every((src) => /^\/ru\/images\/[^/]+\/poster-\d+\.webp$/.test(src)),
    `адрес картинки собран по правилам: ${posters.join(', ')}`);
});

test('картинка с главной открывается и отдаётся как webp', { skip }, async () => {
  const home = await (await get('/ru/')).text();
  const src = home.match(/class="poster__img" src="([^"]+)"/)?.[1];
  assert.ok(src, 'на главной есть постер');

  const response = await fetch(`${baseUrl}${src}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/webp');
});