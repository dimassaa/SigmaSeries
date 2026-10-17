// Раздел «Данные»: удаление аккаунта (F-01-10 §4, OP-16).
//
// Проверяется то, что отличает удаление от смены пароля:
//
//   • повторный пароль и перечень последствий — R-SEC-12, опасное действие;
//   • 14 дней на отмену, и отмена только явным выбором (EC-A11);
//   • по истечении срока обезличивание, а не физическое удаление записи:
//     внешние ключи на материалы и оценки остаются целы;
//   • «удалить и материалы» — по выбору человека, без отметки материалы
//     остаются обезличенными (H-61);
//   • служебная роль и последний админ удалить себя не могут (H-63, EC-A18).
//
// Служебная роль проверяется на сервере: скрытая кнопка обходится прямым
// запросом, поэтому тест шлёт запросы напрямую, минуя интерфейс.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { stubData } from '../src/services/home/data.js';
import { stubAuthStore } from '../src/services/auth/store.js';
import { createSessionMiddleware, createMemorySessionStore } from '../src/services/auth/session.js';
import { hashPassword } from '../src/services/auth/password.js';
import { generateSecret, totpAt } from '../src/services/auth/totp.js';
import { runDeletionSweep } from '../src/services/auth/deletion.js';

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
    quiet_hours: false,
    quiet_hours: false,
    ...over,
  };
}

/**
 * Сервер со входом, очередью писем и журналом, которые только запоминают.
 *
 * Время подменяется: срок 14 дней задаётся настройкой, а проверять его
 * проще сдвигом часов, чем ожиданием.
 *
 * Служебная роль при входе требует второго фактора (R-SEC-04), поэтому вход
 * доводится до конца — иначе проверка «служебная роль удалить себя не может»
 * проверяла бы сессию, которой у служебного человека не бывает.
 */
async function withServer({
  user, extra = [], roles: roleMap = {}, twoFactor = null, start = Date.now(), run,
}) {
  const accounts = { [user.email]: user };
  for (const other of extra) accounts[other.email] = other;

  const events = [];
  const queued = [];
  const auth = stubAuthStore(accounts, roleMap);
  if (twoFactor) auth.setTwoFactor(user.id, twoFactor);
  const memStore = createMemorySessionStore();
  let clock = start;
  const app = createApp({
    data: stubData(),
    auth,
    sessionMw: createSessionMiddleware({ query: async () => ({ rows: [] }), on: () => {} }, memStore),
    journal: { security: (entry) => events.push(entry) },
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

  /**
   * Вход со вторым фактором, если роль служебная.
   *
   * Служебная роль при входе требует кода (R-SEC-04), поэтому вход доводится
   * до конца: иначе проверка «служебная роль удалить себя не может» проверяла
   * бы несуществующую сессию.
   */
  const signIn = async () => {
    const login = await (await get('/ru/login')).text();
    const first = await post('/ru/login', {
      email: user.email, password: PASSWORD, csrf: csrfOf(login),
    });
    if (first.headers.get('location')?.endsWith('/2fa')) {
      const form = await (await get('/ru/2fa')).text();
      await post('/ru/2fa', { code: totpAt(twoFactor.secret, Math.floor(clock / 1000)), csrf: csrfOf(form) });
    }
    return first;
  };

  const entered = await signIn();

  try {
    // Возвращается то, что вернул `run`: часть тестов проверяет состояние
    // после сценария и без этого значения ничего бы не узнала.
    return await run({
      get, post, csrfOf, signIn, entered, user, auth, queued, events,
      /** Сдвинуть часы: срок 14 дней иначе пришлось бы ждать. */
      advance: (days) => { clock += days * 86_400_000; },
      /** Обезличивание по сроку — так же, как это делает задача в server.js. */
      sweep: () => runDeletionSweep({ auth, journal: { security: () => {} }, now: () => clock }),
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** Запрос удаления с формы раздела «Данные». */
async function requestDeletion(h, fields = {}) {
  const page = await (await h.get('/ru/settings/data')).text();
  return h.post('/ru/settings/data/delete', {
    password: PASSWORD, delete_materials: '', csrf: h.csrfOf(page), ...fields,
  });
}

// ─── Запрос удаления ─────────────────────────────────────────────────────────

test('удаление требует верного пароля', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, queued, auth }) => {
      const res = await requestDeletion({ get, post, csrfOf }, { password: 'не-верный-пароль-1' });

      assert.equal(res.status, 400, 'без верного пароля аккаунт не удаляется');
      assert.equal((await auth.byId(user.id)).status, 'active', 'состояние не изменилось');
      assert.equal(queued.length, 0, 'письмо не отправлялось');
    },
  });
});

test('удаление переводит в «Удаляется» и разлогинивает', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, auth, queued, events }) => {
      const res = await requestDeletion({ get, post, csrfOf });

      assert.equal(res.status, 303, 'запрос принят');
      const found = await auth.byId(user.id);
      assert.equal(found.status, 'deleting', 'состояние «Удаляется»');
      assert.ok(found.anonymize_after > found.delete_requested_at, 'назначен срок 14 дней');
      assert.equal(
        Math.round((found.anonymize_after - found.delete_requested_at) / 86_400_000), 14,
        'срок взят из настройки модуля',
      );

      const letter = queued.find((job) => job.kind === 'deletion_requested');
      assert.ok(letter, 'письмо с датой и способом отмены отправлено');
      assert.equal(letter.to, 'anna@example.com');

      assert.equal(
        events.some((e) => e.event === 'deletion_requested'), true,
        'опасное действие попало в журнал (R-SEC-12)',
      );

      // Разлогин после удаления проверяется там, где нужна сессия: экран
      // подтверждения без неё не открывается.
      const after = await get('/ru/settings/data/delete');
      assert.equal(after.status, 303, 'сессия разорвана: подтверждение больше не открыть');
      assert.equal(after.headers.get('location'), '/ru/login');
    },
  });
});

test('служебная роль удалить себя не может (H-63)', async () => {
  const user = await viewer();

  await withServer({
    user,
    roles: { 20: ['editor'] },
    twoFactor: { secret: generateSecret(), lastStep: null, backup: [] },
    run: async ({ get, post, csrfOf, auth }) => {
      const res = await requestDeletion({ get, post, csrfOf });

      assert.equal(res.status, 403, 'отказ сервером, а не скрытой кнопкой');
      assert.equal((await auth.byId(user.id)).status, 'active');
    },
  });
});

test('последний админ удалить себя не может (EC-A18)', async () => {
  const user = await viewer();

  await withServer({
    user,
    roles: { 20: ['admin'] },
    twoFactor: { secret: generateSecret(), lastStep: null, backup: [] },
    run: async ({ get, post, csrfOf, auth }) => {
      const res = await requestDeletion({ get, post, csrfOf });

      assert.equal(res.status, 403, 'последний админ защищён');
      assert.equal((await auth.byId(user.id)).status, 'active');
    },
  });
});

test('админ удалить себя не может, даже когда он не последний', async () => {
  // H-63 запрещает удаление любой служебной ролью, а не только последнему
  // админу. EC-A18 в удалении перекрывается этим же правилом; отдельно оно
  // имеет смысл при снятии роли (S-72, M9), которого пока нет.
  const user = await viewer();
  const colleague = await viewer({ id: 21, email: 'boss@example.com', nickname: 'boss' });

  await withServer({
    user,
    extra: [colleague],
    roles: { 20: ['admin'], 21: ['admin'] },
    twoFactor: { secret: generateSecret(), lastStep: null, backup: [] },
    run: async ({ get, post, csrfOf, auth }) => {
      const res = await requestDeletion({ get, post, csrfOf });

      assert.equal(res.status, 403, 'наличие второго админа не разрешает удаление');
      assert.equal((await auth.byId(user.id)).status, 'active');
    },
  });
});

test('забаненный до раздела удаления не доходит', async () => {
  // Иначе бан обходился бы удалением и новой регистрацией. Закрыт не раздел,
  // а вход: сессии у забаненного нет, и отправлять форму неоткуда.
  const user = await viewer({ status: 'banned' });

  await withServer({
    user,
    run: async ({ get, auth }) => {
      const res = await get('/ru/settings/data/delete');

      assert.equal(res.status, 303, 'на экране подтверждения нет места гостю');
      assert.equal(res.headers.get('location'), '/ru/login');
      assert.equal((await auth.byId(user.id)).status, 'banned');
    },
  });
});

test('отметка «удалить материалы» сохраняется вместе с запросом', async () => {
  const user = await viewer();

  await withServer({
    user,
    run: async ({ get, post, csrfOf, auth }) => {
      await requestDeletion({ get, post, csrfOf }, { delete_materials: 'on' });

      assert.equal((await auth.byId(user.id)).delete_materials, true, 'выбор человека учтён');
    },
  });
});

// ─── Четырнадцать дней (EC-A11) ──────────────────────────────────────────────

test('вход в период удаления показывает выбор, а не настройки (EC-A11)', async () => {
  const user = await viewer({ status: 'deleting' });

  await withServer({
    user,
    run: async ({ entered, get }) => {
      assert.equal(
        entered.headers.get('location'), '/ru/delete-pending',
        'вход приводит на экран выбора, а не в сервис',
      );

      const page = await (await get('/ru/delete-pending')).text();
      assert.match(page, /запросили удаление/i, 'человеку сказано, что аккаунт удаляется');
      assert.match(page, /value="cancel"/, 'предложена отмена');
      assert.match(page, /value="continue"/, 'и вариант оставить удаление в силе');
      assert.match(page, /name="csrf"/, 'форма выбора есть');
    },
  });
});

test('в период удаления настройки не открываются', async () => {
  const user = await viewer({ status: 'deleting' });

  await withServer({
    user,
    run: async ({ get }) => {
      // Сессия после входа — только флаг «ждёт выбора», без прав зрителя.
      const confirm = await get('/ru/settings/data/delete');
      assert.equal(confirm.status, 303, 'подтверждения удаления без входа не достать');
      assert.equal(confirm.headers.get('location'), '/ru/login');
    },
  });
});

test('отмена удаления возвращает аккаунт в работу', async () => {
  const user = await viewer({ status: 'deleting' });

  await withServer({
    user,
    run: async ({ get, post, csrfOf, auth, events }) => {
      const page = await (await get('/ru/delete-pending')).text();
      const res = await post('/ru/delete-pending', { action: 'cancel', csrf: csrfOf(page) });

      assert.equal(res.status, 303);
      const found = await auth.byId(user.id);
      assert.equal(found.status, 'active', 'состояние «Активен»');
      assert.equal(found.anonymize_after, null, 'срок снят');
      assert.equal(
        events.some((e) => e.event === 'deletion_cancelled'), true,
        'отмена тоже попадает в журнал',
      );
    },
  });
});

test('«продолжить удаление» оставляет срок и разлогинивает', async () => {
  const user = await viewer({ status: 'deleting' });

  await withServer({
    user,
    run: async ({ get, post, csrfOf, auth }) => {
      const page = await (await get('/ru/delete-pending')).text();
      const res = await post('/ru/delete-pending', { action: 'continue', csrf: csrfOf(page) });

      assert.equal(res.status, 303);
      assert.equal((await auth.byId(user.id)).status, 'deleting', 'срок не сдвинут');
      const after = await get('/ru/settings');
      assert.equal(after.status, 303, 'сессия закрыта: вернуться нельзя');
    },
  });
});

// ─── Обезличивание (OP-16) ───────────────────────────────────────────────────

/**
 * Обезличивание после истечения срока.
 *
 * Сценарий сквозной: удаление запрашивается через HTTP, срок наступает
 * сдвигом часов, обезличивание выполняет та же задача, что и в `server.js`.
 * Собранное вручную состояние проверяло бы не сценарий, а совпадение полей.
 *
 * Аккаунты создаются фабрикой, а не передаются готовыми: обезличивание
 * меняет объект на месте, и второй запуск на том же самом аккаунте проверял
 * бы уже обезличенное.
 */
async function afterDeadline({ make, days = 15, fields = {}, before = null }) {
  const { user, extra = [] } = await make();

  return withServer({
    user,
    extra,
    run: async (h) => {
      const requested = await requestDeletion(h, fields);
      assert.equal(requested.status, 303, 'запрос удаления принят');
      if (before) await before(h.auth, { user, extra });

      h.advance(days);
      const swept = await h.sweep();

      return { auth: h.auth, swept, found: await h.auth.byId(user.id) };
    },
  });
}

test('по истечении срока личные данные обезличиваются, запись остаётся', async () => {
  const user = await viewer({ locale: 'en', theme: 'light', timezone: 'Asia/Tokyo' });
  const { found, swept } = await afterDeadline({ make: async () => ({ user }) });

  assert.equal(swept.done, 1, 'задача обезличила одного');
  assert.ok(found, 'запись пользователя осталась: внешние ключи не рвутся');
  assert.equal(found.status, 'deleted');
  assert.equal(found.email, null, 'адрес удалён');
  assert.equal(found.password_hash, '', 'хеш пароля удалён, и войти им нельзя');
  assert.equal(found.nickname, `удалённый-${user.id}`, 'ник освобождён под новый');
  assert.equal(found.locale, 'ru', 'язык сброшен к стартовому');
  assert.equal(found.theme, 'system', 'тема сброшена к стартовой');
  assert.equal(found.timezone, 'UTC');
  assert.equal(found.quiet_hours, false, 'тихие часы сняты вместе с аккаунтом');
  assert.equal(found.profile_public, false, 'приватность сброшена');
  assert.equal(found.anonymized_at !== null, true);
  assert.equal(found.anonymize_after, null, 'срок снят: обезличивание состоялось');
});

test('старый адрес после обезличивания не работает, а ник свободен', async () => {
  const { auth } = await afterDeadline({ make: async () => ({ user: await viewer() }) });

  assert.equal(await auth.byEmail('anna@example.com'), null, 'вход по старому адресу невозможен');
  assert.equal(await auth.nicknameFree('anna'), true, 'ник освобождён под другого человека');
});

test('материалы без отметки остаются, с отметкой удаляются (H-61)', async () => {
  // Каждый запуск — свои аккаунты: обезличивание меняет их на месте.
  const make = async () => ({
    user: await viewer(),
    extra: [await viewer({ id: 21, email: 'other@example.com', nickname: 'other' })],
  });
  const seed = async (auth, { user, extra }) => {
    auth.addMaterials(user.id, [{ id: 1, body: 'мой отзыв', replies: 0 }]);
    auth.addMaterials(extra[0].id, [{ id: 2, body: 'чужой отзыв', replies: 0 }]);
  };

  const kept = await afterDeadline({ make, before: seed });
  assert.equal(kept.auth.materials(20).length, 1, 'без отметки материал остаётся');
  assert.equal(kept.auth.materials(20)[0].body, 'мой отзыв', 'текст не тронут');
  assert.equal(kept.auth.materials(21).length, 1, 'чужие материалы не тронуты');

  const dropped = await afterDeadline({ make, fields: { delete_materials: 'on' }, before: seed });
  assert.equal(dropped.auth.materials(20).length, 0, 'с отметкой материал удалён');
  assert.equal(dropped.auth.materials(21).length, 1, 'чужие материалы целы');
});

test('материал, на который отвечали другие, остаётся пустой оболочкой', async () => {
  // Физическое удаление родителя оставило бы чужие ответы без темы.
  const { auth } = await afterDeadline({
    make: async () => ({
      user: await viewer(),
      extra: [await viewer({ id: 21, email: 'other@example.com', nickname: 'other' })],
    }),
    fields: { delete_materials: 'on' },
    before: async (store) => {
      store.addMaterials(20, [{ id: 1, body: 'моя тема', replies: 1 }]);
      store.addMaterials(21, [{ id: 3, body: 'мой ответ в чужой теме', replies: 0 }]);
    },
  });

  const left = auth.materials(20);
  assert.equal(left.length, 1, 'оболочка осталась');
  assert.equal(left[0].body, '', 'текст очищен');
  assert.equal(left[0].state, 'deleted');
  assert.equal(auth.materials(21).length, 1, 'чужие ответы не тронуты');
});

test('до истечения срока обезличивания не происходит (EC-A17)', async () => {
  const { swept, found, auth } = await afterDeadline({ make: async () => ({ user: await viewer() }), days: 13 });

  assert.equal(swept.done, 0, 'на 13-й день задача ничего не трогает');
  assert.equal(found.status, 'deleting', 'аккаунт ещё цел');
  assert.ok(await auth.byEmail('anna@example.com'), 'адрес работает');
});

test('оценки остаются после обезличивания', async () => {
  // §17: пересчёт рейтингов не требуется — оценки живут и после удаления.
  const user = await viewer({ status: 'deleting' });

  await withServer({
    user,
    run: async ({ auth }) => {
      auth.addRating(user.id, 9);

      await auth.anonymizeUser(user.id);

      assert.deepEqual(auth.ratings(user.id), [9], 'оценка осталась, пересчёт не нужен');
    },
  });
});