// Экспорт данных (F-01-10 §4, EC-A21).
//
// Проверяется то, что отличает выгрузку от дампа таблицы:
//
//   • в файле только данные человека и ничего чужого — ни материалов других,
//     ни служебных заметок модерации (§8);
//   • повторный заказ раньше суток отклоняется со временем следующей попытки
//     (EC-A21), а не молча пересобирает файл;
//   • файл лежит в базе, а ссылка живёт сутки и после этого не работает.
//
// Сборка файла происходит в тесте тем же вызовом, что и в задаче: иначе
// проверялась бы не выгрузка, а только то, что заявка принята.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword, hashToken } from '../src/services/auth/password.js';
import { buildExport, tooBigToExport } from '../src/services/data/export.js';
import { runExportSweep } from '../src/services/data/export-job.js';

const PASSWORD = 'правильный-пароль-из-десяти';

/**
 * Хеш считается один раз на файл.
 *
 * Argon2 намеренно медленный, и двадцать восемь одинаковых хешей — это
 * лишние секунды процессора всего прогона: под нагрузкой из-за этого
 * «падал» соседний тест регистрации (см. находку №63).
 */
let cachedHash = null;
const passwordHash = () => (cachedHash ??= hashPassword(PASSWORD));

async function viewer(over = {}) {
  return {
    id: 20,
    email: 'anna@example.com',
    password_hash: await passwordHash(),
    nickname: 'anna',
    status: 'active',
    email_confirmed: true,
    locale: 'ru',
    theme: 'dark',
    timezone: 'Europe/Minsk',
    recs_enabled: true,
    profile_public: false,
    stats_public: false,
    notifications_enabled: true,
    quiet_hours: false,
    ...over,
  };
}

async function withServer({ user, extra = [], roles: roleMap = {}, start = Date.now(), run }) {
  const accounts = { [user.email]: user };
  for (const other of extra) accounts[other.email] = other;

  const queued = [];
  const auth = stubAuthStore(accounts, roleMap);
  const memStore = createMemorySessionStore();
  let clock = start;
  const app = createApp({
    data: stubData(),
    auth,
    sessionMw: createSessionMiddleware({ query: async () => ({ rows: [] }), on: () => {} }, memStore),
    journal: { security: () => {} },
    mailQueue: { async enqueue(job) { queued.push(job); return queued.length; } },
    now: () => clock,
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
  const post = (path, fields) => get(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

  const login = await (await get('/ru/login')).text();
  await post('/ru/login', { email: user.email, password: PASSWORD, csrf: csrfOf(login) });

  try {
    return await run({
      get, post, csrfOf, user, auth, queued,
      advance: (days) => { clock += days * 86_400_000; },
      /** Сборка файла — так же, как её делает задача в server.js. */
      sweep: () => runExportSweep({
        auth,
        mailQueue: { async enqueue(job) { queued.push(job); return queued.length; } },
        journal: { security: () => {} },
        baseUrl: '',
        now: () => clock,
      }),
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** Заказ выгрузки из раздела «Данные». */
async function orderExport(h, password = PASSWORD) {
  const page = await (await h.get('/ru/settings/data')).text();
  return h.post('/ru/settings/data', { action: 'export', password, csrf: h.csrfOf(page) });
}

// ─── Заказ ───────────────────────────────────────────────────────────────────

test('экспорт требует повторный пароль', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ post, csrfOf, get, auth }) => {
      const page = await (await get('/ru/settings/data')).text();
      const res = await post('/ru/settings/data', {
        action: 'export', password: 'не-верный-пароль-1', csrf: csrfOf(page),
      });

      assert.equal(res.status, 400, 'без верного пароля выгрузка не заказывается');
      assert.equal((await auth.dueExports(new Date())).length, 0, 'заявки не осталось');
    },
  });
});

test('заказ создаёт заявку, а человек видит, что файл готовится', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const res = await orderExport({ get, post, csrfOf });
      assert.equal(res.status, 303, 'заказ принят');

      const page = await (await get('/ru/settings/data')).text();
      assert.match(page, /готовится|готовим/i, 'человеку сказано, что файл ещё собирается');
    },
  });
});

test('повторный экспорт раньше суток отклоняется со временем (EC-A21)', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, auth, advance }) => {
      const first = await orderExport({ get, post, csrfOf });
      assert.equal(first.status, 303, 'первый заказ принят');

      advance(0.5);
      const second = await orderExport({ get, post, csrfOf });

      assert.equal(second.status, 429, 'повторный заказ отклонён');
      const body = await second.text();
      assert.match(body, /24|сут|час/i, 'человеку сказано, когда можно снова');
      assert.equal(
        (await auth.dueExports(new Date())).length, 1,
        'первая заявка на месте и не переписана',
      );
    },
  });
});

test('через сутки повторный заказ проходит', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, advance }) => {
      await orderExport({ get, post, csrfOf });
      advance(1.1);
      const again = await orderExport({ get, post, csrfOf });

      assert.equal(again.status, 303);
    },
  });
});

// ─── Содержимое файла ────────────────────────────────────────────────────────

test('в файле только свои данные', async () => {
  const mine = {
    profile: { nickname: 'anna', locale: 'ru', timezone: 'Europe/Minsk' },
    watchStatus: [{ series: 'Страшилки', status: 'watching' }],
    watchMarks: [{ episode: '1x01', markedAt: '2026-01-01T00:00:00.000Z' }],
    ratings: [{ object: 'series', title: 'Страшилки', value: 9 }],
    materials: [{ kind: 'review', body: 'мой отзыв', state: 'published' }],
    notifications: [{ kind: 'release', params: { series: 'Страшилки' } }],
    devices: [{ label: 'браузер', createdAt: '2026-01-01T00:00:00.000Z' }],
  };
  const theirs = {
    materials: [{ kind: 'review', body: 'чужой отзыв' }],
    moderationNotes: [{ note: 'служебная заметка' }],
  };

  const file = buildExport(mine, theirs);

  assert.ok(file.json.includes('мой отзыв'), 'свои материалы в файле есть');
  assert.equal(file.json.includes('чужой отзыв'), false, 'чужие материалы не попали');
  assert.equal(file.json.includes('служебная заметка'), false, 'заметки модерации не попали');
  assert.equal(file.json.includes('password'), false, 'пароля в файле нет');
  assert.equal(file.json.includes('anna@example.com'), false, 'адрес в файле не нужен и не кладётся');
  assert.ok(file.sha256, 'хеш файла посчитан');
  assert.equal(file.size, Buffer.byteLength(file.json, 'utf8'));
});

test('устройства попадают в файл без идентификатора сессии', async () => {
  // Идентификатор сессии — секрет: по нему можно войти.
  const file = buildExport(
    {
      profile: { nickname: 'anna' },
      devices: [{ id: 's%3Aabcdef', label: 'браузер', ip: '10.0.0.1', createdAt: 'x' }],
    },
    {},
  );

  assert.equal(file.json.includes('abcdef'), false, 'идентификатор сессии не отдан');
  assert.match(file.json, /браузер/, 'описание устройства осталось');
});

test('слишком большой файл отклоняется целиком', async () => {
  // Половина выгрузки хуже, чем ничего: человек не отличит одно от другого.
  assert.equal(tooBigToExport('a'.repeat(10), 20), false);
  assert.equal(tooBigToExport('a'.repeat(21), 20), true, 'байты считаются, а не символы');
  assert.equal(tooBigToExport('ы'.repeat(11), 20), true, 'кириллица — два байта');
});

// ─── Ссылка ──────────────────────────────────────────────────────────────────

test('готовый файл отдаётся по ссылке и живёт сутки', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, advance, sweep, queued }) => {
      const h = { get, post, csrfOf };
      assert.equal((await orderExport(h)).status, 303);

      await sweep();
      const link = queued.find((job) => job.kind === 'data_export_ready').link;

      const first = await get(link);
      assert.equal(first.status, 200, 'файл отдаётся');
      assert.match(first.headers.get('content-type') ?? '', /application\/json/);
      assert.match(
        first.headers.get('content-disposition') ?? '', /attachment/,
        'браузер предложит сохранить, а не показать',
      );
      assert.equal(first.headers.get('cache-control'), 'no-store', 'выгрузка не кэшируется');

      advance(1.1);
      const expired = await get(link);
      assert.notEqual(expired.status, 200, 'после суток ссылка не работает');
    },
  });
});

test('чужой или выдуманный токен файла не отдаёт', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, sweep, queued }) => {
      const h = { get, post, csrfOf };
      await orderExport(h);
      await sweep();
      const mine = queued.find((job) => job.kind === 'data_export_ready').link;

      assert.equal((await get(mine)).status, 200, 'своя ссылка работает');

      const stranger = await get('/ru/settings/data/export?token=выдуманный');
      assert.notEqual(stranger.status, 200, 'выдуманный токен файла не открывает');
    },
  });
});

test('после сборки приходит письмо со ссылкой', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, sweep, queued }) => {
      const h = { get, post, csrfOf };
      assert.equal((await orderExport(h)).status, 303);
      assert.equal(queued.length, 0, 'до сборки письма нет: файла ещё не существует');

      await sweep();
      const letter = queued.find((job) => job.kind === 'data_export_ready');

      assert.ok(letter, 'письмо со ссылкой отправлено');
      assert.equal(letter.to, 'anna@example.com');
      assert.match(letter.link, /token=/, 'в письме ссылка с токеном');
    },
  });
});

test('сборка кладёт в файл данные человека, а не дамп базы', async () => {
  const user = await viewer();
  const other = await viewer({ id: 21, email: 'other@example.com', nickname: 'other' });

  await withServer({
    user,
    extra: [other],
    run: async ({ get, post, csrfOf, auth, sweep, queued }) => {
      auth.addMaterials(user.id, [{ id: 1, kind: 'review', body: 'мой отзыв', state: 'published' }]);
      auth.addMaterials(other.id, [{ id: 2, kind: 'review', body: 'чужой отзыв', state: 'published' }]);

      await orderExport({ get, post, csrfOf });
      await sweep();

      const link = queued.find((job) => job.kind === 'data_export_ready').link;
      const file = JSON.parse(await (await get(link)).text());

      assert.equal(file.profile.nickname, 'anna', 'свои данные в файле');
      assert.ok(file.materials.some((m) => m.body === 'мой отзыв'), 'свои материалы в файле');
      assert.equal(file.materials.some((m) => m.body === 'чужой отзыв'), false, 'чужих нет');
      assert.equal('moderationNotes' in file, false, 'служебных заметок нет');
    },
  });
});
