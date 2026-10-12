// Хранилище учётных записей против настоящей базы.
//
// Тест существует по конкретной причине: заглушка `stubAuthStore` умеет всё
// то же, что и `pgAuthStore`, поэтому 226 зелёных тестов закрывали глаза на
// ошибку, которую видно только при выполнении SQL. createUser передавал семь
// параметров при восьми плейсхолдерах — HTTP-тесты были зелёные, а первый же
// curl к живой базе давал 500. Это тот же класс ошибок, что и
// tests/home.queries.test.js, только со стороны записи.
//
// Тест пропускается, если базы нет: без неё проверять нечего, и падать
// из-за отсутствующего PGHOST незачем.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { makeToken, hashToken, hashPassword } from '../src/services/auth/password.js';
import { decryptValue, blindIndex } from '../src/services/auth/crypto.js';

// Слепой индекс и шифротекст считаются секретами приложения, а не базы: без
// них поиск и запись работать не должны вообще, а не «как-то».
process.env.BLIND_INDEX_SECRET ??= 'test-blind-index-secret';
process.env.ADDRESS_SECRET ??= 'test-address-secret';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE или TEST_DATABASE_URL — хранилище не проверялось';

let pool;
let store;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  store = pgAuthStore(pool);
});

test.after(async () => {
  if (pool) await pool.end();
});

/**
 * Идентификаторы уникальны на каждый вызов.
 *
 * Счётчик не годится: тесты одного файла идут не в том порядке, в котором
 * написаны, и два из них успевают прочитать одно и то же значение. База
 * общая, поэтому столкновение выглядит как «аккаунт уже существует».
 */
let counter = 0;
const uniq = () => crypto.randomBytes(6).toString('hex') + (counter++);

const newUser = (over = {}) => {
  const { token, hash } = makeToken();
  const id = uniq();
  return {
    fields: {
      email: `store-${id}@example.com`,
      nickname: `nick-${id}`,
      passwordHash: '$argon2id$заглушка',
      tokenHash: hash,
      timezone: 'Europe/Minsk',
      locale: 'ru',
      theme: 'dark',
      ...over,
    },
    token,
  };
};

// ─── Создание ────────────────────────────────────────────────────────────────

test('аккаунт создаётся неподтверждённым', { skip }, async () => {
  const { fields } = newUser();
  const { rows } = await pool.query(
    'SELECT status, email_confirmed, email_enc FROM e_user WHERE nickname = $1',
    [fields.nickname],
  );
  assert.equal(rows.length, 0, 'до аккаунта ничего нет');

  const user = await store.createUser(fields);
  assert.ok(user.id);

  const after = await store.byEmail(fields.email);
  assert.ok(after, 'аккаунт находится по адресу');
  assert.equal(after.email_confirmed, false, 'сразу не подтверждён');
  assert.equal(after.status, 'active');

  // В базе лежит шифротекст, а не открытый адрес: иначе дамп базы печатает
  // адреса всех пользователей.
  assert.ok(Buffer.isBuffer(after.email_enc), 'email_enc — шифротекст в BYTEA');
  assert.equal(
    after.email_enc.toString('utf8').includes(fields.email),
    false,
    'открытого адреса в колонке нет',
  );
  assert.equal(decryptValue(after.email_enc, 'email'), fields.email, 'адрес восстанавливается ключом');
});

test('email ищется без учёта регистра', { skip }, async () => {
  const { fields } = newUser();
  await store.createUser(fields);
  assert.ok(await store.byEmail(fields.email.toUpperCase()), 'регистр не должен мешать');
  assert.equal(await store.byEmail(' ' + fields.email + ' '), null, 'пробелы — другой адрес');
});

test('занятость адреса и ника определяется без учёта регистра', { skip }, async () => {
  const id = uniq();
  const { fields } = newUser({ nickname: `Anna-${id}` });
  assert.equal(await store.emailFree(fields.email), true);
  assert.equal(await store.nicknameFree(fields.nickname), true);

  await store.createUser(fields);

  assert.equal(await store.emailFree(fields.email), false);
  assert.equal(await store.emailFree(fields.email.toUpperCase()), false);
  // Именно на этот ник человек и пойдёт: форма спрашивает «свободен?» про
  // то, что он набрал, а уникальный индекс в базе чувствителен к регистру.
  // Если бы проверка была чувствительна, форма сказала бы «свободен», а
  // база отвергла бы запись.
  assert.equal(await store.nicknameFree(`anna-${id}`), false);
  assert.equal(await store.nicknameFree(`ANNA-${id}`), false);
  assert.equal(await store.nicknameFree(fields.nickname), false);
});

test('аккаунт без токена не создаётся', { skip }, async () => {
  // Транзакция одна: аккаунт, который нечем подтвердить, — мусор.
  const { fields } = newUser({ tokenHash: null });
  await assert.rejects(() => store.createUser(fields));
  assert.equal(await store.byEmail(fields.email), null, 'запись откатилась целиком');
});

test('ошибка на втором INSERT откатывает первый', { skip }, async () => {
  // Проверяется именно откат, а не отказ: если бы транзакция тянулась
  // только до первого INSERT, в базе остался бы аккаунт без токена.
  //
  // Отказ задаётся столкновением хешей (`uq_auth_token UNIQUE (token_hash)`),
  // а не пустым bytea: пустой bytea ограничение `token_hash NOT NULL`
  // пропускает, INSERT проходит, и отката не происходит вовсе. Такая версия
  // теста была зелёной только потому, что в базе от прошлых прогонов
  // сохранялся такой же пустой хеш; на чистой базе тест падал.
  const first = newUser();
  await store.createUser(first.fields);

  const second = newUser({ tokenHash: first.fields.tokenHash });
  await assert.rejects(() => store.createUser(second.fields));
  assert.equal(await store.byEmail(second.fields.email), null, 'запись откатилась целиком');
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM e_user WHERE nickname = $1',
    [second.fields.nickname],
  );
  assert.equal(rows[0].n, 0, 'строка пользователя не осталась');
});

test('согласие пишется вместе с аккаунтом', { skip }, async () => {
  const { fields } = newUser();
  await store.createUser(fields);
  const { rows } = await pool.query(
    `SELECT category, granted FROM e_consent
      WHERE user_id = (SELECT id FROM e_user WHERE nickname = $1)`,
    [fields.nickname],
  );
  assert.deepEqual(rows, [{ category: 'necessary', granted: true }]);
});

// ─── Гонки ───────────────────────────────────────────────────────────────────

test('второй аккаунт с тем же адресом не проходит (EC-A1)', { skip }, async () => {
  const { fields } = newUser();
  await store.createUser(fields);
  const second = { ...fields, nickname: fields.nickname + 'b' };
  await assert.rejects(() => store.createUser(second), (e) => e.code === '23505');
});

test('второй аккаунт с тем же ником не проходит (EC-A5)', { skip }, async () => {
  const { fields } = newUser();
  await store.createUser(fields);
  const second = { ...fields, email: `store-${uniq()}@example.com` };
  await assert.rejects(() => store.createUser(second), (e) => e.code === '23505');
});

// ─── Токены ──────────────────────────────────────────────────────────────────

test('токен находится по хешу и приходит с хешем', { skip }, async () => {
  const { fields, token } = newUser();
  await store.createUser(fields);

  const row = await store.tokenByHash(hashToken(token));
  assert.ok(row, 'токен найден');
  assert.ok(row.token_hash, 'хеш возвращается: verifyToken сверяет его ещё раз');
  assert.equal(row.kind, 'email_verify');
  assert.equal(row.used_at, null);
  assert.ok(row.expires_at > new Date(), 'срок задан из настроек модуля');
});

test('токен приходит вместе с владельцем', { skip }, async () => {
  // Маршрут открывает по токену сессию и берёт ник, язык и тему владельца.
  // Раньше он искал пользователя по адресу, которого в строке токена нет,
  // и сессия получалась с пустым ником — а на живой базе это не видно,
  // пока шапка не начнёт показывать вошедшего.
  const { fields, token } = newUser();
  await store.createUser(fields);

  const row = await store.tokenByHash(hashToken(token));
  assert.equal(row.nickname, fields.nickname);
  assert.equal(row.locale, fields.locale);
  assert.equal(row.theme, fields.theme);
});

test('чужой токен не находится', { skip }, async () => {
  assert.equal(await store.tokenByHash(hashToken('чужой')), null);
  assert.equal(await store.tokenByHash(null), null);
});

test('повторное письмо гасит прежний токен', { skip }, async () => {
  const { fields, token } = newUser();
  await store.createUser(fields);

  const fresh = await store.newVerificationToken(fields.email);
  assert.ok(fresh.token, 'выдан новый токен');

  const old = await store.tokenByHash(hashToken(token));
  assert.ok(old.used_at, 'старый погашен: по ссылке из первого письма войти нельзя');
  const now = await store.tokenByHash(hashToken(fresh.token));
  assert.equal(now.used_at, null);
});

test('подтверждённому аккаунту письмо не выдаётся', { skip }, async () => {
  const { fields } = newUser();
  const user = await store.createUser(fields);
  await store.confirmEmail(user.id);
  assert.equal(await store.newVerificationToken(fields.email), null);
});

// ─── Подтверждение ───────────────────────────────────────────────────────────

test('подтверждение переводит аккаунт в активный и гасит все токены', { skip }, async () => {
  const { fields } = newUser();
  const user = await store.createUser(fields);
  await store.newVerificationToken(fields.email);

  await store.confirmEmail(user.id);

  const after = await store.byEmail(fields.email);
  assert.equal(after.email_confirmed, true);
  assert.equal(after.status, 'active');

  const { rows } = await pool.query(
    `SELECT count(*)::int AS open_tokens FROM e_auth_token
      WHERE user_id = $1 AND kind = 'email_verify' AND used_at IS NULL`,
    [user.id],
  );
  assert.equal(rows[0].open_tokens, 0, 'второй действующий токен лишний');
});

test('подтверждение не создаёт роли зрителя в e_role_assignment', { skip }, async () => {
  // Зритель — это отсутствие служебных ролей, а не запись в их таблице.
  // Запись «viewer» была бы вторым источником правды о том же факте.
  const { fields } = newUser();
  const user = await store.createUser(fields);
  await store.confirmEmail(user.id);
  assert.deepEqual(await store.roles(user.id), []);
});

test('роли читаются без просроченных', { skip }, async () => {
  const { fields } = newUser();
  const user = await store.createUser(fields);
  await pool.query(
    `INSERT INTO e_role_assignment (user_id, role, expires_at)
     VALUES ($1, 'analyst', now() + interval '1 day')`,
    [user.id],
  );
  assert.deepEqual(await store.roles(user.id), ['analyst']);

  await pool.query(
    `UPDATE e_role_assignment SET expires_at = now() - interval '1 day' WHERE user_id = $1`,
    [user.id],
  );
  assert.deepEqual(await store.roles(user.id), [], 'просроченная роль не действует');
});

// ─── Сброс пароля ────────────────────────────────────────────────────────────
//
// Этот раздел существует ровно потому, что заглушка умеет то же самое:
// зелёные HTTP-тесты ничего не говорят о SQL сброса. Проверяются три места,
// где ошибка стоит дорого: выдача токена неподтверждённому адресу, откат
// гашения и удаление чужих сессий.

/** Создаёт подтверждённый аккаунт: сброс выдаётся только таким. */
async function confirmedUser(over = {}) {
  const { fields } = newUser(over);
  const user = await store.createUser(fields);
  await store.confirmEmail(user.id);
  return { fields, user };
}

test('токен сброса выдаётся подтверждённому аккаунту', { skip }, async () => {
  const { fields, user } = await confirmedUser();

  const issued = await store.newResetToken(fields.email);
  assert.ok(issued?.token, 'подтверждённому аккаунту токен выдан');
  assert.equal(issued.userId, user.id);

  const row = await store.tokenByHash(hashToken(issued.token));
  assert.equal(row.kind, 'password_reset', 'вид токена отличает сброс от подтверждения адреса');
  assert.equal(row.used_at, null);
  const minutes = (new Date(row.expires_at) - Date.now()) / 60000;
  assert.ok(minutes > 25 && minutes < 31, `срок из настроек модуля, а не «на глаз»: ${minutes.toFixed(1)} мин`);
});

test('токен сброса не выдаётся чужому и неподтверждённому адресу', { skip }, async () => {
  // Разница ответов выдавала бы существование аккаунта (R-SEC-06), поэтому
  // хранилище обязано отвечать null, а не «ошибкой».
  assert.equal(await store.newResetToken(`нет-${uniq()}@example.com`), null);

  const { fields } = newUser();
  await store.createUser(fields);
  assert.equal(await store.newResetToken(fields.email), null, 'адрес не подтверждён');
});

test('новая заявка не гасит прежние токены сброса (F-01-04 §8)', { skip }, async () => {
  // Токен гасится только успешной сменой: ссылку открывает и почтовый
  // сканер, поэтому заявка не должна обесценивать уже отправленное письмо.
  const { fields } = await confirmedUser();
  const first = await store.newResetToken(fields.email);
  await store.newResetToken(fields.email);

  const row = await store.tokenByHash(hashToken(first.token));
  assert.equal(row.used_at, null, 'первое письмо остаётся действующим');
});

test('смена пароля пишет новый хеш и гасит все токены сброса', { skip }, async () => {
  const { fields, user } = await confirmedUser();
  const first = await store.newResetToken(fields.email);
  const second = await store.newResetToken(fields.email);

  await store.resetPassword(user.id, '$argon2id$новый-хеш');

  const after = await store.byEmail(fields.email);
  assert.equal(after.password_hash, '$argon2id$новый-хеш');
  for (const token of [first.token, second.token]) {
    const row = await store.tokenByHash(hashToken(token));
    assert.ok(row.used_at, 'ни одна ссылка сброса не остаётся открытой');
  }
});

test('смена пароля не трогает токены подтверждения адреса', { skip }, async () => {
  // Гашение ограничено видом token = 'password_reset': UPDATE без условия погасил бы
  // и ссылку подтверждения, если она почему-то ещё открыта.
  const { user } = await confirmedUser();
  const { hash } = makeToken();
  await pool.query(
    `INSERT INTO e_auth_token (user_id, kind, token_hash, expires_at)
     VALUES ($1, 'email_verify', $2, now() + interval '30 minutes')`,
    [user.id, hash],
  );

  await store.resetPassword(user.id, '$argon2id$новый-хеш');

  const row = await store.tokenByHash(hash);
  assert.equal(row.used_at, null, 'токен другого назначения сброс не гасит');
  await pool.query('DELETE FROM e_auth_token WHERE token_hash = $1', [hash]);
});

test('отзыв сессий удаляет сессии только одного пользователя (EC-A9)', { skip }, async () => {
  const mine = await confirmedUser();
  const other = await confirmedUser();
  const sid = (name) => `test-${uniq()}-${name}`;
  const put = (sessionId, ownerId) => pool.query(
    `INSERT INTO session (sid, sess, expire)
     VALUES ($1, json_build_object('cookie', json_build_object('path','/'),
                                   'user', json_build_object('id', $2::text))::json, now() + interval '1 day')
     ON CONFLICT (sid) DO NOTHING`,
    [sessionId, ownerId],
  );

  const mineId = sid('mine');
  const mineAnon = sid('anon');
  const otherId = sid('other');
  await put(mineId, mine.user.id);
  await put(mineAnon, '999999');
  await put(otherId, other.user.id);

  const removed = await store.revokeSessions(mine.user.id);

  assert.equal(removed, 1, 'удалена ровно одна сессия пользователя');
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM session WHERE sid = ANY($1::text[])`,
    [[mineId, mineAnon, otherId]],
  );
  assert.equal(rows[0].n, 2, 'гостевая и чужая сессии остались');
  await pool.query(`DELETE FROM session WHERE sid = ANY($1::text[])`, [[mineAnon, otherId]]);
});

// ─── Раздел «Настройки» (F-01-06 §4) ───────────────────────────────────────
//
// Шесть методов этого раздела жили только в заглушке: HTTP-тесты были зелёные,
// а против базы раздел отдавал 500. Тесты ниже повторяют те же проверки на
// настоящем хранилище.

test('текущий пароль проверяется по хешу из базы', { skip }, async () => {
  const password = 'правильный-пароль-из-десяти';
  const { fields, user } = await confirmedUser({
    passwordHash: await hashPassword(password),
  });

  assert.equal(await store.verifyCurrent(user.id, password), true, 'верный пароль');
  assert.equal(await store.verifyCurrent(user.id, 'не-верный-пароль-1'), false, 'неверный');
  assert.equal(await store.verifyCurrent(user.id, ''), false, 'пустой пароль не проходит');
  assert.equal(
    await store.verifyCurrent(0, password), false,
    'несуществующий аккаунт — не ошибка, а «нет»',
  );
  assert.ok(fields.email, 'аккаунт создан настоящим хешем, а не строкой-заглушкой');
});

test('свой ник не занят, чужой занят', { skip }, async () => {
  const mine = await confirmedUser();
  const stranger = await confirmedUser();

  assert.equal(await store.nicknameFree(mine.fields.nickname), false, 'ник занят вообще');
  assert.equal(
    await store.nicknameFree(mine.fields.nickname, mine.user.id), true,
    'свой ник свободен: сохранение профиля без правки имени не «занято»',
  );
  assert.equal(
    await store.nicknameFree(mine.fields.nickname.toUpperCase(), mine.user.id), true,
    'сравнение нечувствительно к регистру и здесь',
  );
  assert.equal(await store.nicknameFree(stranger.fields.nickname), false);
});

test('уведомления сохраняются отдельными полями', { skip }, async () => {
  const { user } = await confirmedUser();

  await store.updateNotifications(user.id, {
    notifications_enabled: false, quiet_hours: true, nickname: 'подмена',
  });

  const { rows } = await pool.query(
    'SELECT notifications_enabled, quiet_hours, nickname FROM e_user WHERE id = $1',
    [user.id],
  );
  assert.equal(rows[0].notifications_enabled, false, 'общий выключатель сохранён');
  assert.equal(rows[0].quiet_hours, true, 'тихий режим сохранён');
  assert.match(rows[0].nickname, /^nick-/, 'чужое поле не записано');
});

test('выключение 2FA удаляет состояние и говорит, было ли оно', { skip }, async () => {
  const { user } = await confirmedUser();

  assert.equal(await store.disableTwoFactor(user.id), false, 'выключать было нечего');

  const secret = crypto.randomBytes(20);
  await store.enableTwoFactor(user.id, secret, [crypto.randomBytes(32)]);
  assert.equal(await store.disableTwoFactor(user.id), true, 'состояние было и удалено');
  assert.equal(await store.disableTwoFactor(user.id), false, 'повторно удалять нечего');

  const { rows } = await pool.query(
    'SELECT 1 FROM e_two_factor WHERE user_id = $1', [user.id],
  );
  assert.equal(rows.length, 0, 'строки в базе нет');
});

test('дата последней смены ника читается из истории', { skip }, async () => {
  const { user } = await confirmedUser();

  assert.equal(await store.nicknameChangedAt(user.id), null, 'истории ещё нет');
  await store.changeNickname(user.id, `nick-${uniq()}-другое`);
  const at = await store.nicknameChangedAt(user.id);

  assert.ok(at instanceof Date, 'возвращается дата, а не строка');
  assert.ok(Math.abs(Date.now() - at.getTime()) < 60_000, 'свежая запись истории');
});

// ─── Смена адреса (F-01-06 §4) ──────────────────────────────────────────────

test('заявка на смену адреса не действует, пока не подтверждена', { skip }, async () => {
  const { fields, user } = await confirmedUser();
  const newEmail = `smena-${uniq()}@example.com`;
  const { hash } = makeToken();

  const issued = await store.requestEmailChange(
    user.id, newEmail, hash, new Date(Date.now() + 30 * 60_000),
  );
  assert.ok(issued, 'заявка принята');

  const { rows } = await pool.query(
    'SELECT 1 FROM e_user WHERE email_blind_idx = $1', [blindIndex(newEmail)],
  );
  assert.equal(rows.length, 0, 'до подтверждения новый адрес в e_user не появился');
  assert.equal(await store.byEmail(newEmail), null, 'по новому адресу не войти');
  assert.ok(await store.byEmail(fields.email), 'старый адрес работает');

  await pool.query('DELETE FROM e_email_change WHERE user_id = $1', [user.id]);
});

test('занятый адрес заявку не создаёт', { skip }, async () => {
  const mine = await confirmedUser();
  const stranger = await confirmedUser();
  const { hash } = makeToken();

  const issued = await store.requestEmailChange(
    mine.user.id, stranger.fields.email, hash, new Date(Date.now() + 30 * 60_000),
  );

  assert.equal(issued, null, 'хранилище отвечает «нет», а не ошибкой');
  const { rows } = await pool.query(
    'SELECT 1 FROM e_email_change WHERE user_id = $1', [mine.user.id],
  );
  assert.equal(rows.length, 0, 'заявка не записана');
});

test('свой же адрес занят не считается', { skip }, async () => {
  // Смена на тот же адрес — обычное «сохранить», а не отказ: человек мог
  // открыть настройки и ничего в адресе не менять.
  const { fields, user } = await confirmedUser();
  const { hash } = makeToken();

  const issued = await store.requestEmailChange(
    user.id, fields.email, hash, new Date(Date.now() + 30 * 60_000),
  );
  assert.ok(issued, 'повтор того же адреса допустим');
  await pool.query('DELETE FROM e_email_change WHERE user_id = $1', [user.id]);
});

test('подтверждение применяет адрес и гасит заявку', { skip }, async () => {
  const { fields, user } = await confirmedUser();
  const newEmail = `primen-${uniq()}@example.com`;
  const { hash } = makeToken();
  await store.requestEmailChange(user.id, newEmail, hash, new Date(Date.now() + 30 * 60_000));

  const change = await store.emailChangeByToken(hash);
  assert.equal(change.email, newEmail, 'новый адрес возвращается открытым');
  assert.equal(change.user_id, user.id);

  assert.equal(await store.applyEmailChange(change.id, change.user_id, change.email), true);

  assert.ok(await store.byEmail(newEmail), 'новый адрес работает');
  assert.equal(await store.byEmail(fields.email), null, 'старый больше не работает');
  assert.equal(
    await store.emailChangeByToken(hash), null,
    'заявка удалена: тот же токен второй раз не применится',
  );
  assert.equal(await store.addressOf(user.id), newEmail, 'адрес читается и из базы');
});

test('вторая заявка отменяет первую', { skip }, async () => {
  const { user } = await confirmedUser();
  const first = makeToken();
  await store.requestEmailChange(user.id, `first-${uniq()}@example.com`, first.hash,
    new Date(Date.now() + 30 * 60_000));
  const second = makeToken();
  await store.requestEmailChange(user.id, `second-${uniq()}@example.com`, second.hash,
    new Date(Date.now() + 30 * 60_000));

  assert.equal(await store.emailChangeByToken(first.hash), null, 'прежняя заявка не действует');
  assert.match(
    (await store.emailChangeByToken(second.hash)).email, /^second-/,
    'действует последняя заявка',
  );
  await pool.query('DELETE FROM e_email_change WHERE user_id = $1', [user.id]);
});

test('несуществующий токен не находится', { skip }, async () => {
  assert.equal(await store.emailChangeByToken(hashToken('подделка')), null);
});
