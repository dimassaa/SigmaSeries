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
import { makeToken, hashToken } from '../src/services/auth/password.js';

// Слепой индекс считается секретом приложения, а не базы: без него поиск
// работать не должен вообще, а не «как-то».
process.env.SESSION_SECRET ??= 'test-secret';

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
  assert.equal(after.email_enc, null, 'шифрования в проекте нет, колонка пуста');
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
