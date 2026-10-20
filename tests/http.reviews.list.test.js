// Список отзывов сериала по HTTP (F-04-05, S-09).
//
// Проверяется то, что видно снаружи: код ответа, куда ведёт страница за
// концом списка, что индексируется, какие ссылки получает человек и что
// оказывается в карточках. Выборка проверяется отдельно, в
// `reviews.list.test.js`; здесь — маршрут, разметка и число запросов.
//
// Сводка и блок «Лучшие» берут числа из настоящей базы, поэтому фикстуры
// создаются настоящими сервисами: заглушка отвечала бы «да» на всё и скрыла
// бы расхождение прав и показа (EC-V1).

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore, pgAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, makeToken } from '../src/services/auth/password.js';
import { pgSeries } from '../src/services/catalogue/series.js';
import { pgRatings } from '../src/services/rating/store.js';
import { pgReviews } from '../src/services/reviews/store.js';
import { pgReviewList } from '../src/services/reviews/list.js';
import { pgReviewVotes } from '../src/services/reviews/votes.js';

process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';
process.env.SESSION_SECRET ??= 'test-session-secret';

const PASSWORD = 'правильный-пароль-из-десяти';
const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — список отзывов по HTTP не проверялся';
const PREFIX = 'review-list-http-%';

let pool;
let reviews;
let ratings;
let auth;

/** Человек: взрослый подтверждённый аккаунт — оценка сразу входит в рейтинг (EC-V4). */
async function viewer() {
  const { hash } = makeToken();
  const email = `review-list-http-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const nickname = `review-list-http-${crypto.randomUUID().slice(0, 8)}`;
  const passwordHash = await hashPassword(PASSWORD);
  const created = await pgAuthStore(pool).createUser({
    email,
    nickname,
    passwordHash,
    tokenHash: hash,
    timezone: 'Europe/Minsk',
    locale: 'ru',
    theme: 'dark',
    confirmed: true,
  });
  await pool.query(
    `UPDATE e_user SET email_confirmed = TRUE, registered_at = now() - interval '30 days' WHERE id = $1`,
    [created.id],
  );
  return {
    id: created.id,
    email,
    nickname,
    email_enc: null,
    password_hash: passwordHash,
    status: 'active',
    email_confirmed: true,
    locale: 'ru',
    theme: 'dark',
    timezone: 'Europe/Minsk',
  };
}

async function mark(userId, seriesId) {
  const { rows: [episode] } = await pool.query(
    `SELECT e.id FROM e_episode e JOIN e_season s ON s.id = e.season_id
      WHERE s.series_id = $1 ORDER BY e.id LIMIT 1`,
    [seriesId],
  );
  await pool.query(
    `INSERT INTO e_watch_mark (user_id, episode_id, precision) VALUES ($1, $2, 'exact')
     ON CONFLICT DO NOTHING`,
    [userId, episode.id],
  );
}

/** Оценка автора настоящим сервисом: она же пополняет агрегат (F-04-03). */
async function rate(user, series, value) {
  const res = await ratings.setSeriesRating({ userId: user.id, seriesId: series.id, value });
  assert.equal(res.ok, true, `оценка должна записаться: ${res.reason ?? ''}`);
}

const CLEAN = { block: [], allow: [], available: true };

/** Отзыв от имени человека: отметка, оценка и текст одним действием. */
async function write({ user, series, text, spoiler = false, lang = 'ru', rating = 8 }) {
  await mark(user.id, series.id);
  await rate(user, series, rating);
  const res = await reviews.submit({
    userId: user.id, seriesId: series.id, body: text, spoiler, lang, dictionary: CLEAN,
  });
  assert.equal(res.ok, true, `отзыв должен записаться: ${res.reason ?? ''}`);
}

async function seriesWith(number) {
  const { rows: [seriesRow] } = await pool.query(
    `INSERT INTO e_series (slug, title_ru, title_original, tmdb_id, publication_state, exit_state, year_start)
     VALUES ($1, 'Отзыв HTTP', 'Review HTTP', $2, 'published', 'airing', 2024) RETURNING id, slug`,
    [`review-list-http-${number}-${crypto.randomUUID().slice(0, 6)}`, 972_000_000 + number],
  );
  const { rows: [season] } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [seriesRow.id],
  );
  await pool.query(
    `INSERT INTO e_episode (season_id, number, title_ru, runtime_min)
     VALUES ($1, 1, 'Серия', 45)`, [season.id],
  );
  return seriesRow;
}

/**
 * Двадцать один отзыв прямой вставкой: страницам нужно много строк, а
 * форма и проверка текста уже проверены в `http.reviews.test.js`.
 */
async function bulkReviews(series, count) {
  const passwordHash = await hashPassword(PASSWORD);
  for (let i = 1; i <= count; i += 1) {
    const nickname = `review-list-http-${crypto.randomUUID().slice(0, 8)}`;
    const created = await pgAuthStore(pool).createUser({
      email: `${nickname}@example.com`,
      nickname,
      passwordHash,
      tokenHash: makeToken().hash,
      timezone: 'Europe/Minsk',
      locale: 'ru',
      theme: 'dark',
      confirmed: true,
    });
    await pool.query(
      `INSERT INTO e_material (author_id, kind, series_id, body, lang, state)
       VALUES ($1, 'review', $2, $3, 'ru', 'published')`,
      [created.id, series.id, `Отзыв номер ${i}: сериал стоит просмотра`],
    );
    await pool.query(
      `INSERT INTO e_rating (user_id, object_type, series_id, value) VALUES ($1, 'series', $2, 8)`,
      [created.id, series.id],
    );
  }
}

/** Идентификатор отзыва пары — для сверки порядка в блоке «Лучшие». */
async function materialId(user, series) {
  const { rows } = await pool.query(
    `SELECT id FROM e_material WHERE author_id = $1 AND series_id = $2 AND kind = 'review'`,
    [user.id, series.id],
  );
  return Number(rows[0].id);
}

/** Карточки страницы: фрагмент от `<li` до `</li>` по маркеру отзыва. */
function cardsOf(html) {
  return [...html.matchAll(/data-review-id="(\d+)"/g)].map((match) => ({
    id: Number(match[1]),
    html: html.slice(html.lastIndexOf('<li', match.index), html.indexOf('</li>', match.index)),
  }));
}

const cardIdsOf = (html) => cardsOf(html).map((card) => card.id);

/** Куски раздела: от открывающего `<section` до его закрытия. */
function sectionOf(html, marker) {
  const at = html.indexOf(marker);
  if (at === -1) return '';
  return html.slice(html.lastIndexOf('<section', at), html.indexOf('</section>', at));
}

/**
 * Сервер с настоящей базой; службы страницы считают запросы — так проверяется
 * бюджет страницы (F-04-05 §14), как и у каталога. Сессии считаются отдельно:
 * они не контент страницы.
 */
async function withServer({ user = null, run }) {
  const counted = { value: 0 };
  const counting = {
    query: (...args) => {
      counted.value += 1;
      return pool.query(...args);
    },
  };
  const app = createApp({
    data: stubData(),
    auth: stubAuthStore(user ? { [user.email]: user } : {}),
    series: pgSeries(counting),
    ratings: pgRatings(counting),
    reviews: pgReviews(counting),
    reviewList: pgReviewList(counting),
    votes: pgReviewVotes(counting),
    dictionary: { load: async () => CLEAN },
    sessionMw: createSessionMiddleware(pool, createMemorySessionStore(), {
      account: async (u) => ({ nickname: u.nickname, unread: 0, pollSeconds: 0 }),
    }),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let jar = '';

  const get = async (path, init = {}) => {
    const res = await fetch(base + path, {
      redirect: 'manual',
      ...init,
      headers: { cookie: jar, ...(init.headers ?? {}) },
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) jar = set.map((c) => c.split(';')[0]).join('; ');
    return res;
  };
  const post = (path, fields, init = {}) => get(path, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(init.headers ?? {}) },
    body: new URLSearchParams(fields),
  });
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];
  const htmlGet = async (path) => {
    const res = await get(path);
    assert.equal(res.status, 200, `страница ${path} должна открываться`);
    return res.text();
  };

  if (user) {
    const form = await (await get('/ru/login')).text();
    await post('/ru/login', { email: user.email, password: PASSWORD, csrf: csrfOf(form) });
  }

  try {
    await run({ get, post, csrfOf, htmlGet, queries: () => counted.value });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
  reviews = pgReviews(pool);
  ratings = pgRatings(pool);
  auth = pgAuthStore(pool);
});

test.after(async () => {
  if (!pool) return;
  const ids = `SELECT id FROM e_series WHERE slug LIKE $1`;
  await pool.query(`DELETE FROM e_material WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_rating WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_watch_mark WHERE episode_id IN (
    SELECT e.id FROM e_episode e JOIN e_season s ON s.id = e.season_id WHERE s.series_id IN (${ids}))`, [PREFIX]);
  await pool.query(`DELETE FROM e_season WHERE series_id IN (${ids})`, [PREFIX]);
  await pool.query(`DELETE FROM e_series WHERE slug LIKE $1`, [PREFIX]);
  await pool.end();
});

test('страница открывается: сводка, вкладки с числами и карточки', { skip }, async () => {
  const series = await seriesWith(31);
  const anna = await viewer();
  const boris = await viewer();
  const vera = await viewer();
  await write({ user: anna, series, text: 'Спокойный отзыв без спойлеров и без ссылок', rating: 8 });
  await write({ user: boris, series, text: 'Сериал средний: есть удачные серии, есть провальные', rating: 5 });
  await write({ user: vera, series, text: 'Разочарование полное, бросил на втором сезоне', rating: 2 });

  await withServer({
    run: async ({ htmlGet }) => {
      const html = await htmlGet(`/ru/series/${series.slug}/reviews`);

      // Заголовок по шаблону (`SEO` §2) и состав страницы.
      assert.match(html, /Отзывы на «Отзыв HTTP»/);
      assert.match(html, /<title>Отзывы на «Отзыв HTTP» · SigmaSeries<\/title>/,
        'заголовок — по шаблону SEO §2, с брендом');
      assert.ok(!html.includes('noindex'), 'первая страница с умолчаниями индексируется');

      // Сводка (F-04-03) на месте: гистограмма по трём голосам.
      assert.match(html, /Гистограмма \(оценок: 3\)/);

      // Вкладки: числа групп, сумма равна «Все» (M4 §8а).
      assert.match(html, /Все <span class="reviews__chip-count">3<\/span>/);
      assert.match(html, /Положительные <span class="reviews__chip-count">1<\/span>/);
      assert.match(html, /Смешанные <span class="reviews__chip-count">1<\/span>/);
      assert.match(html, /Отрицательные <span class="reviews__chip-count">1<\/span>/);

      // Число отзывов — множественной формой (M4 §11).
      assert.match(html, /3 отзыва/);

      // Ссылки фильтров и сортировок — настоящие адреса (R-SEO-09).
      assert.ok(html.includes(`href="/ru/series/${series.slug}/reviews?group=positive"`));
      assert.ok(html.includes(`href="/ru/series/${series.slug}/reviews?length=short"`));
      assert.ok(html.includes(`href="/ru/series/${series.slug}/reviews?lang=en"`));
      assert.ok(html.includes(`href="/ru/series/${series.slug}/reviews?sort=new"`));
      assert.ok(html.includes(`href="/ru/series/${series.slug}/reviews?sort=long"`));

      // Карточка: ник, оценка автора, дата, язык и текст (M4 §4).
      const cards = cardsOf(html);
      assert.equal(cards.length, 3);
      const card = cards.find((one) => one.html.includes(anna.nickname));
      assert.match(card.html, /class="reviews__card-rating" aria-hidden="true">8</);
      assert.match(card.html, /<time[^>]*datetime="\d{4}-\d{2}-\d{2}"/);
      assert.match(card.html, />RU</);
      assert.ok(card.html.includes('Спокойный отзыв без спойлеров и без ссылок'));
    },
  });
});

test('фильтры комбинируются, ссылки не теряют соседей', { skip }, async () => {
  const series = await seriesWith(32);
  const anna = await viewer();
  const boris = await viewer();
  const vera = await viewer();
  const gary = await viewer();
  await write({ user: anna, series, text: 'Короткий отзыв с высокой оценкой', rating: 9 });
  await write({ user: boris, series, text: 'Короткий отзыв с низкой оценкой', rating: 2 });
  await write({ user: vera, series, text: 'д'.repeat(1100), rating: 8 });
  await write({
    user: gary, series, rating: 7, lang: null,
    text: 'A calm English review without any spoilers at all',
  });

  await withServer({
    run: async ({ htmlGet }) => {
      // «Положительные» + «Длинные»: остаётся только длинный отзыв (M4 §18).
      const html = await htmlGet(`/ru/series/${series.slug}/reviews?group=positive&length=long`);
      const cards = cardsOf(html);
      assert.equal(cards.length, 1);
      assert.ok(cards[0].html.includes(vera.nickname));

      // Активная вкладка отмечена, соседние ссылки сохраняют остальные фильтры.
      // В разметке «&» внутри адреса экранируется: ожидания пишут то, что
      // реально увидит браузер.
      assert.match(html, /href="[^"]*group=positive&amp;length=long"[^>]*aria-current="true"/);
      assert.ok(html.includes(`href="/ru/series/${series.slug}/reviews?group=positive&amp;length=short"`),
        'метка длины сохраняет группу');
      assert.ok(html.includes(`href="/ru/series/${series.slug}/reviews?group=positive&amp;length=long&amp;sort=new"`),
        'сортировка сохраняет фильтры');
      assert.match(html, /Все <span class="reviews__chip-count">1<\/span>/,
        'счётчики — в области длины и языка (M4 §8б)');

      // Язык: английский отзыв отмечен на карточке и находится по фильтру.
      const en = await htmlGet(`/ru/series/${series.slug}/reviews?lang=en`);
      const enCards = cardsOf(en);
      assert.equal(enCards.length, 1);
      assert.ok(enCards[0].html.includes(gary.nickname));
      assert.match(enCards[0].html, />EN</);
      assert.match(cards[0].html, />RU</, 'русский текст помечен RU');
    },
  });
});

test('мусор в параметрах не ломает страницу: показывается базовый список', { skip }, async () => {
  const series = await seriesWith(33);
  const anna = await viewer();
  const boris = await viewer();
  await write({ user: anna, series, text: 'Первый отзыв базового списка' });
  await write({ user: boris, series, text: 'Второй отзыв базового списка' });

  await withServer({
    run: async ({ htmlGet }) => {
      // Неизвестные значения отбрасываются, а не дают 400 (F-04-05 §9).
      const html = await htmlGet(
        `/ru/series/${series.slug}/reviews?group=zzz&length=medium&lang=de&sort=zzz&page=abc`,
      );
      assert.equal(cardsOf(html).length, 2);
    },
  });
});

test('страницы: настоящие ссылки, за концом — 301, кроме первой — noindex', { skip }, async () => {
  const series = await seriesWith(34);
  await bulkReviews(series, 21);

  await withServer({
    run: async ({ get, htmlGet }) => {
      const first = await htmlGet(`/ru/series/${series.slug}/reviews`);
      assert.equal(cardsOf(first).length, 20, 'на странице не больше review.page_size');
      assert.match(first, /21 отзыв/, 'число отзывов — множественной формой');
      assert.ok(first.includes(`href="/ru/series/${series.slug}/reviews?page=2"`),
        'постраничность — настоящая ссылка (R-SEO-09)');

      const second = await get(`/ru/series/${series.slug}/reviews?page=2`);
      assert.equal(second.status, 200);
      const secondHtml = await second.text();
      assert.equal(cardsOf(secondHtml).length, 1);
      assert.match(secondHtml, /noindex/, 'вторая страница не индексируется (M4 §8г)');

      const sorted = await get(`/ru/series/${series.slug}/reviews?sort=new`);
      assert.match(await sorted.text(), /noindex/, 'неумолчательная сортировка не индексируется');

      const beyond = await get(`/ru/series/${series.slug}/reviews?page=99`);
      assert.equal(beyond.status, 301);
      assert.equal(beyond.headers.get('location'), `/ru/series/${series.slug}/reviews?page=2`);

      const beyondFiltered = await get(`/ru/series/${series.slug}/reviews?group=positive&page=99`);
      assert.equal(beyondFiltered.status, 301);
      assert.equal(beyondFiltered.headers.get('location'),
        `/ru/series/${series.slug}/reviews?group=positive&page=2`, 'возврат сохраняет фильтры');
    },
  });
});

test('пустые состояния: нет отзывов, пустая группа и путь к оценке', { skip }, async () => {
  const series = await seriesWith(35);

  // Гость: сообщение есть, пути нет — писать ему нечего.
  await withServer({
    run: async ({ htmlGet }) => {
      const html = await htmlGet(`/ru/series/${series.slug}/reviews`);
      assert.match(html, /Пока нет отзывов/);
      assert.ok(!html.includes('Отметьте серию и оцените'), 'гостю путь не предлагается');
    },
  });

  // Вошедший с отметкой: путь ведёт на страницу сериала (F-04-05 §6).
  const writer = await viewer();
  await mark(writer.id, series.id);
  await withServer({
    user: writer,
    run: async ({ htmlGet }) => {
      const html = await htmlGet(`/ru/series/${series.slug}/reviews`);
      assert.match(html, /Пока нет отзывов/);
      assert.ok(html.includes(`href="/ru/series/${series.slug}"`),
        'путь «Отметьте серию и оцените» ведёт на S-06');
    },
  });

  // Непустой список: пустая группа отвечает сообщением и «Сбросить».
  const anna = await viewer();
  await write({ user: anna, series, text: 'Отзыв, который попал в положительные', rating: 9 });
  await withServer({
    run: async ({ htmlGet }) => {
      const html = await htmlGet(`/ru/series/${series.slug}/reviews?group=negative`);
      assert.match(html, /В этой группе пока ничего/);
      assert.ok(html.includes(`href="/ru/series/${series.slug}/reviews"`),
        '«Сбросить» ведёт к списку без фильтров');
    },
  });
});

test('спойлер свёрнут и не попадает в сниппеты, длинный текст — под «Читать далее»', { skip }, async () => {
  const series = await seriesWith(36);
  const anna = await viewer();
  const boris = await viewer();
  await write({
    user: anna, series, rating: 7, spoiler: true,
    text: 'Тайна раскрыта: герой оказывается братом главного злодея',
  });
  const long = `Начало отзыва. ${'Слово '.repeat(150)}КОНЕЦ-ХВОСТА`;
  await write({ user: boris, series, text: long, rating: 9 });

  await withServer({
    run: async ({ htmlGet }) => {
      const html = await htmlGet(`/ru/series/${series.slug}/reviews`);

      // Спойлер: текст в разметке, но свёрнут и помечен (M4 §8д, R-SEO-14).
      const spoilerCard = cardsOf(html).find((one) => one.html.includes(anna.nickname));
      assert.match(spoilerCard.html, /<details/);
      assert.match(spoilerCard.html, /Спойлеры скрыты\. Показать/);
      assert.match(spoilerCard.html, /data-nosnippet/);
      assert.ok(spoilerCard.html.indexOf('Тайна раскрыта')
        > spoilerCard.html.indexOf('Спойлеры скрыты'), 'текст идёт под свёрткой');

      // Длинный текст: видимая часть и хвост под раскрытием — без скрипта.
      const longCard = cardsOf(html).find((one) => one.html.includes(boris.nickname));
      assert.match(longCard.html, /Читать далее/);
      assert.ok(longCard.html.includes('КОНЕЦ-ХВОСТА'));
      assert.ok(longCard.html.indexOf('КОНЕЦ-ХВОСТА') > longCard.html.indexOf('Читать далее'));
    },
  });
});

test('удалённый автор: «Пользователь удалён» вместо ника (EC-V6)', { skip }, async () => {
  const series = await seriesWith(37);
  const anna = await viewer();
  await write({ user: anna, series, text: 'Отзыв человека, удалившего аккаунт' });

  await auth.anonymizeUser(anna.id);

  await withServer({
    run: async ({ htmlGet }) => {
      const html = await htmlGet(`/ru/series/${series.slug}/reviews`);
      const cards = cardsOf(html);
      assert.equal(cards.length, 1, 'текст остаётся, аккаунт обезличен');
      assert.match(cards[0].html, /Пользователь удалён/);
      assert.ok(!cards[0].html.includes(anna.nickname), 'старый ник не подставляется');
    },
  });
});

test('кнопка у сводки: «Написать отзыв» и «Изменить» ведут к форме на S-06', { skip }, async () => {
  const series = await seriesWith(38);
  const writer = await viewer();
  await mark(writer.id, series.id);

  await withServer({
    user: writer,
    run: async ({ htmlGet }) => {
      const html = await htmlGet(`/ru/series/${series.slug}/reviews`);
      assert.ok(html.includes(`href="/ru/series/${series.slug}#review-dialog"`), 'ссылка на форму');
      assert.match(html, /Написать отзыв/);
    },
  });

  await write({ user: writer, series, text: 'Свой отзыв, который можно поправить', rating: 8 });

  await withServer({
    user: writer,
    run: async ({ htmlGet }) => {
      const html = await htmlGet(`/ru/series/${series.slug}/reviews`);
      assert.ok(html.includes(`href="/ru/series/${series.slug}#review-dialog"`));
      assert.match(html, /Изменить/);
    },
  });

  await withServer({
    run: async ({ htmlGet }) => {
      const html = await htmlGet(`/ru/series/${series.slug}/reviews`);
      assert.ok(!html.includes('#review-dialog'), 'гостю формы не предлагается');
    },
  });
});

test('S-06: блок «Лучшие отзывы» с тремя карточками и ссылкой на список', { skip }, async () => {
  const series = await seriesWith(39);
  const authors = [await viewer(), await viewer(), await viewer(), await viewer(), await viewer()];
  const voters = [await viewer(), await viewer(), await viewer(), await viewer()];
  const ids = [];
  for (let i = 0; i < authors.length; i += 1) {
    await write({ user: authors[i], series, text: `Отзыв для «Лучших», номер ${i + 1}`, rating: 6 + i });
    ids.push(await materialId(authors[i], series));
  }
  // Голоса: у 4-го — четыре, у 2-го — три, у 1-го — один, у остальных нет.
  const votes = { 0: 1, 1: 3, 3: 4 };
  for (const [index, count] of Object.entries(votes)) {
    for (let v = 0; v < count; v += 1) {
      await pool.query(
        'INSERT INTO e_helpful_vote (user_id, material_id) VALUES ($1, $2)',
        [voters[v].id, ids[Number(index)]],
      );
    }
  }

  await withServer({
    run: async ({ htmlGet }) => {
      const html = await htmlGet(`/ru/series/${series.slug}`);
      const top = sectionOf(html, 'reviews-top');
      assert.match(top, /Лучшие отзывы/);
      assert.deepEqual(cardIdsOf(top), [ids[3], ids[1], ids[0]],
        'три карточки порядком «Полезные» (review.top_on_series_page)');
      assert.ok(top.includes(`href="/ru/series/${series.slug}/reviews"`), 'ссылка на весь список');
    },
  });

  const empty = await seriesWith(40);
  await withServer({
    run: async ({ htmlGet }) => {
      const html = await htmlGet(`/ru/series/${empty.slug}`);
      assert.ok(!html.includes('Лучшие отзывы'), 'пустой блок не рисуется');
      assert.ok(!html.includes(`href="/ru/series/${empty.slug}/reviews"`), 'ссылки на пустой список нет');
    },
  });
});

test('страница списка укладывается в бюджет запросов', { skip }, async () => {
  const series = await seriesWith(41);
  const anna = await viewer();
  await write({ user: anna, series, text: 'Отзыв для проверки числа запросов' });

  await withServer({
    user: anna,
    run: async ({ get, queries }) => {
      const before = queries();
      const res = await get(`/ru/series/${series.slug}/reviews`);
      assert.equal(res.status, 200);
      const used = queries() - before;
      assert.ok(used <= 15, `страница списка сделала ${used} запросов (бюджет 15)`);
    },
  });
});

test('голос «Полезно» гостю: счётчик и «Войдите», формы нет (F-04-06 §5)', { skip }, async () => {
  const series = await seriesWith(42);
  const author = await viewer();
  await write({ user: author, series, text: 'Отзыв, под которым гость видит счётчик' });

  await withServer({
    run: async ({ htmlGet }) => {
      const html = await htmlGet(`/ru/series/${series.slug}/reviews`);
      const card = cardsOf(html).find((c) => true);
      assert.ok(card, 'карточка есть');
      assert.match(card.html, /<span class="reviews__vote-count">Полезно · 0<\/span>/,
        'счётчик виден и без права голосовать');
      assert.match(card.html, /href="\/ru\/login\?next=%2Fru%2Fseries%2F[^"]*"/, 'вход с возвратом');
      assert.ok(!card.html.includes('data-review-vote'), 'формы у гостя нет');
    },
  });
});

test('голос «Полезно» вошедшему: форма с состоянием; голос меняет разметку', { skip }, async () => {
  const series = await seriesWith(43);
  const author = await viewer();
  const reader = await viewer();
  await write({ user: author, series, text: 'Отзыв, который читатель оценит как полезный' });

  await withServer({
    user: reader,
    run: async ({ htmlGet, post, csrfOf }) => {
      const url = `/ru/series/${series.slug}/reviews`;
      const html = await htmlGet(url);
      const card = cardsOf(html).find((c) => true);
      assert.match(card.html, /<form class="reviews__vote" method="post" action="\/ru\/series\/[^"]+\/reviews\/\d+\/helpful" data-review-vote>/);
      assert.match(card.html, /aria-pressed="false"/);
      assert.match(card.html, /name="to" value="set"/);
      assert.match(card.html, /Полезно <span class="reviews__vote-num">· 0<\/span>/);
      assert.match(card.html, /name="back" value="\/ru\/series\/[^"]*\/reviews[^"]*"/,
        'адрес возврата собран видом, с фильтрами');

      // Круг через маршрут: голос поставлен — страница показывает нажатой.
      const csrf = csrfOf(html);
      const id = card.id;
      const res = await post(`/ru/series/${series.slug}/reviews/${id}/helpful`, {
        csrf, to: 'set', back: `/ru/series/${series.slug}/reviews`,
      });
      assert.equal(res.status, 303);

      const again = await htmlGet(url);
      const voted = cardsOf(again).find((c) => c.id === id);
      assert.match(voted.html, /aria-pressed="true"/, 'состояние читается с сервера');
      assert.match(voted.html, /name="to" value="unset"/, 'повторный клик снимает');
      assert.match(voted.html, /reviews__vote-button--on/, 'подложка нажатой кнопки');
      assert.match(voted.html, /· 1<\/span>/);
    },
  });
});

test('свой отзыв: кнопка неактивна с пояснением (EC-V15)', { skip }, async () => {
  const series = await seriesWith(44);
  const author = await viewer();
  await write({ user: author, series, text: 'Свой отзыв не оценивают, кнопка неактивна' });

  await withServer({
    user: author,
    run: async ({ htmlGet }) => {
      const html = await htmlGet(`/ru/series/${series.slug}/reviews`);
      const card = cardsOf(html).find((c) => true);
      assert.match(card.html, /<button class="reviews__vote-button" type="button" disabled/);
      assert.match(card.html, /Свой отзыв не оценивают\./);
      assert.ok(!card.html.includes('data-review-vote'), 'формы отправки нет');
    },
  });
});

test('неподтверждённому кнопки голоса нет (не «Зритель»)', { skip }, async () => {
  const series = await seriesWith(45);
  const author = await viewer();
  await write({ user: author, series, text: 'Отзыв, который неподтверждённый не оценит кнопкой' });

  // Адрес не подтверждён: вход проходит, но сессия знает `confirmed: false`,
  // и интерфейс не рисует кнопку зрителя. Право всё равно проверит сервис.
  const newcomer = await viewer();
  await pool.query('UPDATE e_user SET email_confirmed = FALSE WHERE id = $1', [newcomer.id]);
  newcomer.email_confirmed = false;

  await withServer({
    user: newcomer,
    run: async ({ htmlGet }) => {
      const html = await htmlGet(`/ru/series/${series.slug}/reviews`);
      const card = cardsOf(html).find((c) => true);
      assert.ok(!card.html.includes('reviews__foot'), 'футера голоса нет');
    },
  });
});

test('S-06: у «Лучших» гостю тоже счётчик с «Войдите», возврат на страницу сериала', { skip }, async () => {
  const series = await seriesWith(46);
  const author = await viewer();
  await write({ user: author, series, text: 'Лучший отзыв с голосом в блоке сериала' });

  await withServer({
    run: async ({ htmlGet }) => {
      const html = await htmlGet(`/ru/series/${series.slug}`);
      const top = sectionOf(html, 'reviews-top');
      assert.match(top, /reviews__vote-count/);
      assert.match(top, /href="\/ru\/login\?next=%2Fru%2Fseries%2F[^"]*"/,
        'возврат — на страницу сериала, не на список');
      assert.ok(!top.includes('data-review-vote'), 'формы у гостя нет');
    },
  });
});
