// Внутренние ссылки живых страниц (S-01, S-06, S-02).
//
// Проверяется то, о чём страница обещает человеку: что по каждой ссылке можно
// дойти. Ссылка без ведущего слэша — относительная, и с адреса `/ru/` ведёт на
// `/ru/ru/series/…`; ссылка с завершающим слэшем на строгих маршрутах — 404.
// И то и другое не видно ни в коде вида, ни в тесте разметки: страница
// выглядит целой, а клик приводит в никуда.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { pgCatalogueList } from '../src/services/catalogue/list.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE или TEST_DATABASE_URL — ссылки не проверялись';

let pool;
let server;
let baseUrl;

function stubData() {
  return {
    banners: async () => [],
    fresh: async () => [],
    collections: async () => [],
    genres: async () => [],
  };
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
  const app = createApp({
    data: stubData(),
    series: pgSeries(pool),
    catalogue: pgCatalogueList(pool),
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
});

async function slugOfAnySeries() {
  const { rows } = await pool.query(
    "SELECT slug FROM e_series WHERE publication_state = 'published' AND archived_at IS NULL LIMIT 1",
  );
  return rows[0]?.slug;
}

/** Все внутренние ссылки страницы: относительные и с якорем отбрасываются. */
function internalHrefs(html) {
  return [...html.matchAll(/href="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((href) => href.startsWith('/') && !href.startsWith('//') && !href.includes('#'));
}

/**
 * Адреса, которые в этом приложении не смонтированы.
 *
 *  · `/login` — маршруты личности здесь не подключены (это проверка каталога,
 *    а не входа); в бою страница есть;
 *  · `/calendar` — экран M3 (F-03-05) ещё не написан, а пункт меню задан
 *    документацией. Пропадёт из проверки вместе с экраном.
 */
const NOT_MOUNTED = /^\/(ru|en)\/(login|register|settings|calendar|admin|notifications)/;

test('каждая ссылка главной ведёт на существующую страницу', { skip }, async () => {
  const page = await fetch(`${baseUrl}/ru/`);
  assert.equal(page.status, 200);

  const hrefs = internalHrefs(await page.text())
    .filter((href) => !NOT_MOUNTED.test(href));
  assert.ok(hrefs.length > 3, 'на главной есть ссылки, которые есть смысл проверять');

  const broken = [];
  for (const href of new Set(hrefs)) {
    const response = await fetch(`${baseUrl}${href}`, { redirect: 'manual' });
    if (response.status >= 400) broken.push(`${href} → ${response.status}`);
  }
  assert.deepEqual(broken, [], `ссылки главной ведут в никуда: ${broken.join(', ')}`);
});

test('ссылка из каталога ведёт на страницу сериала', { skip }, async () => {
  const catalogue = await fetch(`${baseUrl}/ru/series`);
  assert.equal(catalogue.status, 200);

  const links = [...(await catalogue.text()).matchAll(/href="(\/ru\/series\/[^"]+)"/g)]
    .map((match) => match[1]);
  assert.ok(links.length > 0, 'в каталоге есть карточки');

  const first = await fetch(`${baseUrl}${links[0]}`);
  assert.equal(first.status, 200, `карточка ${links[0]} должна открываться`);
});

test('страница сериала ведёт обратно в каталог и домой', { skip }, async () => {
  const slug = await slugOfAnySeries();
  const page = await fetch(`${baseUrl}/ru/series/${slug}`);
  assert.equal(page.status, 200);

  const hrefs = internalHrefs(await page.text()).filter((href) => !NOT_MOUNTED.test(href));
  assert.ok(hrefs.includes(`/ru/series`), 'в меню есть «Каталог», и он ведёт в каталог');

  for (const href of new Set(hrefs)) {
    const response = await fetch(`${baseUrl}${href}`, { redirect: 'manual' });
    assert.ok(response.status < 400, `${href} → ${response.status}`);
  }
});