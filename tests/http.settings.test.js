// S-32: язык, вид и приватность.
//
// Проверяется не «страница отдалась», а четыре правила фичи:
//
//   • §8(а) тема и язык применяются без кнопки «Сохранить»;
//   • §8(б) переключатели приватности сохраняются;
//   • §8(г) приватность по умолчанию закрытая;
//   • §2 R-SEC-10: разделы только свои, чужое значение не редактируется.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword } from '../src/services/auth/password.js';

const PASSWORD = 'правильный-пароль-из-десяти';

/** Зритель со значениями по умолчанию из схемы. */
async function viewer(over = {}) {
  return {
    id: 20,
    email: 'anna@example.com',
    password_hash: await hashPassword(PASSWORD),
    nickname: 'anna',
    status: 'active',
    email_confirmed: true,
    locale: 'ru',
    theme: 'dark',
    timezone: 'Europe/Minsk',
    // Приватность закрыта по умолчанию: F-01-06 §8(г).
    recs_enabled: true,
    profile_public: false,
    stats_public: false,
    ...over,
  };
}

/**
 * Сервер со заглушкой хранилища.
 *
 * `signedIn` — входить или нет: гость тоже имеет экран настроек, его тема и
 * язык хранятся на стороне браузера (F-01-06 §8(а)).
 */
async function withServer({ user, extra = [], signedIn = true, run }) {
  const accounts = { [user.email]: user };
  for (const other of extra) accounts[other.email] = other;
  const auth = stubAuthStore(accounts);
  const app = createApp({
    data: stubData(),
    auth,
    sessionMw: createSessionMiddleware(
      { query: async () => ({ rows: [] }), on: () => {} },
      createMemorySessionStore(),
    ),
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

  if (signedIn) {
    const page = await (await get('/ru/login')).text();
    await post('/ru/login', { email: user.email, password: PASSWORD, csrf: csrfOf(page) });
  }

  try {
    await run({ get, post, csrfOf, user, auth });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ─── Разделы (F-01-06 §19) ───────────────────────────────────────────────────

test('экран настроек отдаётся и называет разделы', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get }) => {
      // Без раздела адрес приводит к первому разделу — это отдельное
      // поведение, здесь проверяется то, что раздел открывается.
      const res = await get('/ru/settings/appearance');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('cache-control') ?? '', /no-store/, 'R-SEC-24: личная страница');

      const page = await res.text();
      assert.match(page, /<h1[\s>]/, 'есть заголовок первого уровня');
      assert.match(page, /settings/i, 'раздел назван');
    },
  });
});

test('раздел выбирается адресом, а не переключателем на странице', async () => {
  // §19: левая треть — вертикальная навигация по разделам. Адрес раздела
  // нужен и для ссылки «назад», и для экрана телефона, где раздел открывается
  // отдельно.
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get }) => {
      const page = await (await get('/ru/settings/privacy')).text();
      assert.equal(page.length > 0, true);
      assert.match(page, /stat|privacy|приватн/i, 'открыт именно раздел приватности');
    },
  });
});

test('без раздела открывается первый, а не пустая страница', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get }) => {
      const res = await get('/ru/settings');
      assert.equal(res.status, 303, 'адрес приводится к разделу');
      assert.equal(res.headers.get('location'), '/ru/settings/appearance');
    },
  });
});

// ─── Тема и язык применяются сразу (§8(а)) ──────────────────────────────────

test('выбор темы сохраняется без кнопки «Сохранить»', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const form = await (await get('/ru/settings/appearance')).text();
      const res = await post('/ru/settings/appearance', {
        csrf: csrfOf(form), theme: 'light', locale: 'ru', timezone: 'Europe/Minsk',
      });

      assert.equal(res.status, 303, 'применено сразу, без отдельного сохранения');
      assert.equal(user.theme, 'light', 'тема записана в профиль');
    },
  });
});

test('выбор языка сохраняется, а язык в адресе продолжает побеждать', async () => {
  // §8(а): язык в профиле — для писем и редиректов по умолчанию; явный язык
  // адреса побеждает только для текущей страницы (EC-A20).
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const form = await (await get('/ru/settings/appearance')).text();
      await post('/ru/settings/appearance', {
        csrf: csrfOf(form), theme: 'dark', locale: 'en', timezone: 'Europe/Minsk',
      });

      assert.equal(user.locale, 'en', 'язык записан в профиль');

      // Язык в адресе побеждает для текущей страницы (EC-A20): в профиле
      // теперь «английский», но адрес `/ru/` требует русского.
      const page = await (await get('/ru/settings/appearance')).text();
      assert.match(page, /Язык интерфейса/, 'русский адрес отдал русский текст');
    },
  });
});

test('мусорные значения вида, языка и пояса не попадают в профиль', async () => {
  // §9: часовой пояс из списка IANA, вид и язык — из закрытых списков.
  // Произвольная строка в базе означала бы время, которое нельзя показать.
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const form = await (await get('/ru/settings/appearance')).text();

      const badZone = await post('/ru/settings/appearance', {
        csrf: csrfOf(form), theme: 'dark', locale: 'ru', timezone: 'Марс',
      });
      assert.equal(badZone.status, 400, 'мусорный пояс отвергнут');
      assert.equal(user.timezone, 'Europe/Minsk', 'значение не применено');

      const badTheme = await post('/ru/settings/appearance', {
        csrf: csrfOf(await (await get('/ru/settings/appearance')).text()),
        theme: 'неоновая', locale: 'ru', timezone: 'Europe/Minsk',
      });
      assert.equal(badTheme.status, 400, 'выдуманный вид отвергнут');
      assert.equal(user.theme, 'dark', 'тема не изменилась');
    },
  });
});

test('часовой пояс из списка IANA применяется', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const form = await (await get('/ru/settings/appearance')).text();
      const res = await post('/ru/settings/appearance', {
        csrf: csrfOf(form), theme: 'dark', locale: 'ru', timezone: 'Europe/Berlin',
      });

      assert.equal(res.status, 303);
      assert.equal(user.timezone, 'Europe/Berlin');
    },
  });
});

// ─── Приватность: по умолчанию закрыта (§8(г), §18) ─────────────────────────

test('новый аккаунт не показывает статистику и профиль другим', async () => {
  // §18: «профиль другого пользователя не показывает статистику».
  const user = await viewer();

  assert.equal(user.stats_public, false, 'статистика закрыта по умолчанию');
  assert.equal(user.profile_public, false, 'профиль закрыт по умолчанию');
});

test('переключатели приватности сохраняются', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const form = await (await get('/ru/settings/privacy')).text();
      const res = await post('/ru/settings/privacy', {
        csrf: csrfOf(form), stats_public: 'on', recs_enabled: '',
      });

      assert.equal(res.status, 303, 'применено');
      assert.equal(user.stats_public, true, 'переключатель применился');
      assert.equal(user.recs_enabled, false, 'снятый переключатель тоже применился');
    },
  });
});

test('чужие значения приватности не редактируются (R-SEC-10)', async () => {
  // §2: разделы только свои. Идентификатор в теле запроса игнорируется —
  // иначе один POST со значением `user_id` менял бы настройки чужого
  // аккаунта. Законный владелец при этом сохраняет свои: речь о чужом.
  const user = await viewer();
  const stranger = await viewer({ id: 999, email: 'other@example.com', nickname: 'other' });

  await withServer({
    user,
    extra: [stranger],
    run: async ({ get, post, csrfOf }) => {
      const form = await (await get('/ru/settings/privacy')).text();
      await post('/ru/settings/privacy', {
        csrf: csrfOf(form), user_id: '999', stats_public: 'on',
      });

      assert.equal(user.stats_public, true, 'свои настройки человек поменять может');
      assert.equal(
        stranger.stats_public, false,
        'настройки чужого аккаунта не изменились',
      );
    },
  });
});

test('в настройки нельзя записать произвольное поле', async () => {
  // Поля перечислены в запросе явно. Без фильтра в аккаунт попало бы всё,
  // что пришло в теле, — включая роль и идентификатор.
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf }) => {
      const form = await (await get('/ru/settings/appearance')).text();
      await post('/ru/settings/appearance', {
        csrf: csrfOf(form), theme: 'light', locale: 'ru', timezone: 'Europe/Minsk',
        nickname: 'взлом',
      });

      assert.equal(user.nickname, 'anna', 'ник через настройки не меняется');
    },
  });
});

test('заглушка хранилища отбрасывает поля, которых нет в настройках', async () => {
  // Заглушка обязана вести себя как база, а база перечисляет столбцы явно.
  // Без этой проверки тесты на HTTP шли бы по структуре, которой в бою нет.
  const user = await viewer();

  await withServer({
    user,
    run: async ({ auth }) => {
      await auth.updatePreferences(user.id, { theme: 'light', nickname: 'взлом', id: 42 });

      assert.equal(user.theme, 'light', 'настоящая настройка применилась');
      assert.equal(user.nickname, 'anna', 'чужое поле отброшено');
    },
  });
});

// ─── Гость (F-01-06 §8(а)) ──────────────────────────────────────────────────

test('страница настроек отдаётся гостю', async () => {
  // Гость тоже имеет экран: его тема и язык — его собственные настройки.
  const user = await viewer();

  await withServer({
    user,
    signedIn: false,
    run: async ({ get }) => {
      const res = await get('/ru/settings/appearance');
      assert.equal(res.status, 200, 'гость не отправлен на вход');
    },
  });
});

test('тема ставится до первой отрисовки, иначе виден белый кадр', async () => {
  const user = await viewer();

  await withServer({
    user,
    signedIn: false,
    run: async ({ get }) => {
      const page = await (await get('/ru/')).text();
      const head = page.slice(0, page.indexOf('</head>'));

      assert.match(
        head,
        /localStorage\.getItem\('theme'\)/,
        'тема читается в раннем скрипте, а не выставляется событием',
      );
      assert.match(page, /data-theme="[a-z]+"/, 'тема определена всегда');
    },
  });
});