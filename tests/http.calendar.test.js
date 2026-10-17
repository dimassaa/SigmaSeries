// Календарь (F-03-05, S-16): адреса, виды, индекс, гость.
//
// Проверяется то, что видит человек и что видит поисковик: три вида, месяц
// вокруг текущего индексируется, дальше — `noindex` (R-SEO-02), гость на «Мои»
// получает приглашение, а не пустую сетку (EC-T21), и содержимое уже в
// начальном HTML (R-SEO-07, измерение 13).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { pgCalendar } from '../src/services/catalogue/calendar.js';
import { stubData } from '../src/services/home/data.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — страницы календаря не проверялись';

let pool;
let server;
let baseUrl;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  const app = createApp({ data: stubData(), calendar: pgCalendar(pool), pool });
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

const get = (path) => fetch(`${baseUrl}${path}`);

/** Месяц, в котором календарь что-то показывает: будущий, где есть выходы. */
async function monthWithReleases() {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', release_date), 'YYYY-MM') AS month
       FROM e_release WHERE release_date > CURRENT_DATE
      GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
  );
  assert.ok(rows.length, 'в базе есть будущие выходы');
  return rows[0].month;
}

test('перенесённый выход на странице календаря помечен словом (#124)', { skip }, async () => {
  // Путь до глаза: база → источник → вид. Своя фикстура, потому что импорт
  // пишет только `scheduled`, и проверять было бы нечего.
  const slug = `cal-http-moved-${crypto.randomUUID()}`;
  const { rows: [series] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Сериал с переносом', 'Moved', 970000002, 'published', 'airing', 2024) RETURNING id`,
    [slug],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [series.id],
  );
  const { rows: [episode] } = await pool.query(
    'INSERT INTO e_episode (season_id, number, title_ru, runtime_min) VALUES ($1, 1, $2, 45) RETURNING id',
    [season.id, 'Пилот'],
  );
  const date = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const { rows: [release] } = await pool.query(
    "INSERT INTO e_release (season_id, release_date, state) VALUES ($1, $2, 'delayed') RETURNING id",
    [season.id, date],
  );
  await pool.query('INSERT INTO e_release_episode (release_id, episode_id) VALUES ($1, $2)',
    [release.id, episode.id]);

  try {
    const month = date.slice(0, 7);
    const body = await (await get(`/ru/calendar?month=${month}&view=list`)).text();

    assert.match(body, /перенесён/,
      'человек видит, что дата перенесена, а не принимает её за обычную');
    assert.match(body, /Сериал с переносом/);
  } finally {
    await pool.query('DELETE FROM e_release WHERE id = $1', [release.id]);
    await pool.query('DELETE FROM e_season WHERE id = $1', [season.id]);
    await pool.query('DELETE FROM e_series WHERE id = $1', [series.id]);
  }
});

test('месяц открывается сеткой и подписью пояса', { skip }, async () => {
  const response = await get('/ru/calendar');
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /<table class="calendar__grid"/, 'месяц — таблица, а не набор div');
  assert.match(body, /Europe\/Minsk/, 'пояс гостя назван (H-72)');
  assert.ok(!/<script[^>]*>[\s\S]*дн<\/script>/.test(body),
    'дни месяца в начальном HTML, а не нарисованы скриптом');
});

test('в ячейке месяца не больше трёх записей, остальное — «+N» (EC-T15)', { skip }, async () => {
  const month = await monthWithReleases();
  const body = await (await get(`/ru/calendar?month=${month}`)).text();

  const cells = body.split('<td class="calendar__cell').slice(1);
  assert.ok(cells.length >= 28, 'в месяце 28–31 ячеек');

  let shown = 0;
  for (const cell of cells) {
    const entries = (cell.match(/class="calendar__entry"/g) ?? []).length;
    assert.ok(entries <= 3, `в ячейке ${entries} записей, а показывать можно три`);
    shown += entries;
  }
  assert.ok(shown > 0, 'в месяце есть выходы, и они показаны');

  // День, где выходов больше трёх, обязан быть виден как ссылка на его
  // список, иначе часть календаря просто пропала бы с экрана.
  // Самый полный день ищется в том же месяце, который открыт на странице:
  // месяц берётся как самый наполненный из будущих, и он не обязательно
  // текущий. Раньше день искался в текущем месяце, и проверка сравнивала
  // страницу одного месяца с днём другого — проходила, только когда они
  // совпадали.
  const { rows: [busy] } = await pool.query(
    `SELECT release_date::text AS date FROM e_release
      WHERE release_date >= $1::date
        AND release_date < ($1::date + interval '1 month')::date
      GROUP BY release_date HAVING count(*) > 3 ORDER BY count(*) DESC LIMIT 1`,
    [`${month}-01`],
  );

  if (!busy) return;
  // Ссылка ищется именно для самого заполненного дня: месяц идёт по датам, и
  // первая попавшаяся «+N» — это ранний день, а не самый полный. Раньше проверка
  // брала первую ссылку и сравнивала её с самым полным днём, что проходило
  // только пока такой день совпадал с первым.
  const links = [...body.matchAll(/class="calendar__more" href="([^"]+)"\s*>\+(\d+)</g)];
  assert.ok(links.length, 'в месяце есть дни с числом выходов больше трёх — они обязаны быть ссылками «+N»');

  const more = links.find(([, href]) => href.includes(`day=${busy.date}`));
  assert.ok(more, `у самого полного дня (${busy.date}) есть ссылка «+N»`);
  assert.ok(Number(more[2]) > 0, 'рядом с ячейкой написано, сколько записей спрятано');

  const dayPage = await (await get(more[1].replaceAll('&amp;', '&'))).text();
  const listed = (dayPage.match(/class="calendar__entry"/g) ?? []).length;
  assert.ok(listed > 3, `по ссылке «+N» открывается список дня: там ${listed} записей`);
  assert.ok(dayPage.includes(busy.date), 'открыт именно тот день, где записей больше трёх');
});

test('неделя и список открываются тем же адресом с другим видом', { skip }, async () => {
  const month = await monthWithReleases();

  const week = await get(`/ru/calendar?view=week&month=${month}`);
  const weekBody = await week.text();
  assert.equal(week.status, 200);
  assert.match(weekBody, /class="calendar__week"/, 'неделя — свой вид');

  const list = await get(`/ru/calendar?view=list&month=${month}`);
  const listBody = await list.text();
  assert.equal(list.status, 200);
  assert.match(listBody, /class="calendar__list"/, 'список — свой вид');
});

test('неизвестный вид показывает месяц, а не ошибку', { skip }, async () => {
  const response = await get('/ru/calendar?view=какая-то-ерунда');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<table class="calendar__grid"/);
});

test('текущий месяц индексируется, далёкий — нет (R-SEO-02)', { skip }, async () => {
  const { rows: [now] } = await pool.query(
    "SELECT to_char(CURRENT_DATE, 'YYYY-MM') AS month",
  );

  const current = await (await get(`/ru/calendar?month=${now.month}`)).text();
  assert.ok(!current.includes('noindex'), 'текущий месяц в индексе нужен');

  const { rows: [far] } = await pool.query(
    "SELECT to_char(CURRENT_DATE + interval '5 years', 'YYYY-MM') AS month",
  );
  const distant = await (await get(`/ru/calendar?month=${far.month}`)).text();
  assert.match(distant, /<meta name="robots" content="noindex, follow">/,
    'месяц через пять лет в индексе не нужен — это тысячи почти пустых адресов');
});

test('подпись состояния выхода видна в разметке', { skip }, async () => {
  // В базе таких строк нет — правило проверяется на своём выходе, иначе тест
  // был бы проверкой того, что колонка пуста.
  const { rows: [season] } = await pool.query(
    `SELECT se.id FROM e_season se
       JOIN e_series s ON s.id = se.series_id
      WHERE s.publication_state = 'published' AND s.archived_at IS NULL AND se.number > 0
      LIMIT 1`,
  );
  const { rows: [moved] } = await pool.query(
    `INSERT INTO e_release (season_id, covers_season, release_date, precision, state)
     VALUES ($1, true, CURRENT_DATE + 7, 'date', 'delayed')
     RETURNING id, release_date::text AS date`,
    [season.id],
  );

  try {
    const body = await (await get(`/ru/calendar?view=list&day=${moved.date}`)).text();
    assert.match(body, /calendar__entry-state[^>]*>перенесён/,
      'перенесённый выход обязан быть подписан: иначе человек придёт зря');
  } finally {
    await pool.query('DELETE FROM e_release WHERE id = $1', [moved.id]);
  }
});

test('гость на «Мои» получает приглашение, а не пустую сетку (EC-T21)', { skip }, async () => {
  const body = await (await get('/ru/calendar?filter=mine')).text();

  assert.match(body, /Войдите|войти/, 'гостю предлагают войти');
  assert.ok(!body.includes('class="calendar__grid"'),
    'сетка без данных только сбивает: кажется, что выходов нет');
});

test('«Все» работает и гостю', { skip }, async () => {
  const month = await monthWithReleases();
  const body = await (await get(`/ru/calendar?month=${month}`)).text();

  assert.match(body, /<table class="calendar__grid"/);
  assert.ok(!body.includes('Войдите, чтобы'), 'гость видит календарь всех сериалов');
});

test('английский календарь открывается', { skip }, async () => {
  const response = await get('/en/calendar');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<html lang="en"/);
});

test('переходы по месяцам и «сегодня» ведут по адресам, а не скриптом', { skip }, async () => {
  const month = await monthWithReleases();
  const body = await (await get(`/ru/calendar?month=${month}`)).text();

  assert.ok(body.includes('/ru/calendar?month='), 'есть ссылка на соседний месяц');
  assert.ok(body.includes('/ru/calendar'), 'есть ссылка «сегодня»');
  assert.match(body, /rel="prev"/);
  assert.match(body, /rel="next"/);
});

test('календарь отдаёт даты в разметке, а не только картинками (R-SEO-19)', { skip }, async () => {
  const month = await monthWithReleases();
  const body = await (await get(`/ru/calendar?view=list&month=${month}`)).text();

  assert.match(body, /datetime="/, 'у записей есть машинная дата');
  assert.match(body, /<time /, 'дата помечена элементом time');
});