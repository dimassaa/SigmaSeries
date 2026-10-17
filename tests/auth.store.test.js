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
  if (!pool) return;
  // Сериалы фикстур уходят за собой: без этого каждый прогон оставлял в рабочей
  // базе сотни строк `test-series-…`, а база одна и та же — та, с которой
  // показывают проект (#132).
  //
  // Порядок задан не удобством, а схемой: `e_rating` и `e_material` ссылаются на
  // сериал с RESTRICT, `e_season.series_id` объявлен RESTRICT намеренно, а
  // ответ на материал осиротить нельзя — `ck_material_target` требует цель. Поэтому
  // сначала собираются ответы на фикстурные материалы (рекурсией, а не одним
  // уровнем), потом то, что на них ссылается, и только потом сериалы.
  //
  // Дерево ответов повторяется в каждом запросе, а не кладётся во временную
  // таблицу: пул отдаёт соседним запросам другое соединение, а временная таблица
  // живёт в том, где её создали.
  const tree = `WITH RECURSIVE tree(id) AS (
       SELECT m.id FROM e_material m
         JOIN e_series s ON s.id = m.series_id AND s.slug LIKE 'test-series-%'
       UNION
       SELECT m.id FROM e_material m JOIN tree t ON m.parent_id = t.id
     ) SELECT id FROM tree`;

  await pool.query(
    `DELETE FROM e_rating WHERE series_id IN (SELECT id FROM e_series WHERE slug LIKE 'test-series-%')`,
  );
  await pool.query(`DELETE FROM e_helpful_vote WHERE material_id IN (${tree})`);
  await pool.query(`DELETE FROM e_material WHERE id IN (${tree})`);
  await pool.query(`DELETE FROM e_season WHERE series_id IN (SELECT id FROM e_series WHERE slug LIKE 'test-series-%')`);
  await pool.query("DELETE FROM e_series WHERE slug LIKE 'test-series-%'");
  await pool.end();
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

test('тихие часы сохраняются отдельными полями, границы — временем', { skip }, async () => {
  const { user } = await confirmedUser();

  await store.updateNotifications(user.id, {
    quietHours: true, quietFrom: '23:30', quietTo: '07:45', nickname: 'подмена',
  });

  const { rows } = await pool.query(
    `SELECT quiet_hours, quiet_hours_from::text AS f, quiet_hours_to::text AS t, nickname
       FROM e_user WHERE id = $1`,
    [user.id],
  );
  assert.equal(rows[0].quiet_hours, true, 'тихий режим сохранён');
  assert.equal(rows[0].f, '23:30:00', 'граница «с» сохранена');
  assert.equal(rows[0].t, '07:45:00', 'граница «до» сохранена');
  assert.match(rows[0].nickname, /^nick-/, 'чужое поле не записано');

  await store.updateNotifications(user.id, { quietHours: false });
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

// ─── Удаление аккаунта (F-01-10 §4, OP-16) ───────────────────────────────────
//
// Обезличивание — самая опасная операция в проекте: ошибка здесь либо стирает
// лишнее, либо оставляет лишнее, и оба исхода не видны в HTTP-тестах, пока всё
// идёт по заглушке.

/**
 * Аккаунт в состоянии «Удаляется».
 *
 * `inDays` — смещение срока от текущего момента: отрицательное значение
 * означает, что срок уже наступил и заявка ждёт обезличивания (EC-A17).
 */
async function deletingUser({ materials = false, inDays = 14 } = {}) {
  const { fields, user } = await confirmedUser();
  await pool.query(
    `UPDATE e_user
        SET status = 'deleting', delete_requested_at = $2,
            anonymize_after = $3, delete_materials = $4
      WHERE id = $1`,
    [
      user.id,
      new Date(Date.now() + (inDays - 14) * 86_400_000),
      new Date(Date.now() + inDays * 86_400_000),
      materials,
    ],
  );
  return { fields, user };
}

/**
 * Сериал с одной серией для материалов и оценок.
 *
 * Отдельная глава нужна оценке: первичный ключ `e_rating` включает
 * `episode_id`, и сериальной оценки без серии база не принимает.
 */
async function series() {
  const { rows } = await pool.query(
    `INSERT INTO e_series (slug, title_original, imdb_key)
     VALUES ($1, 'Test Series', $2) RETURNING id`,
    [`test-series-${uniq()}`, `tt${uniq()}`],
  );
  const seriesId = rows[0].id;
  const { rows: season } = await pool.query(
    'INSERT INTO e_season (series_id, number) VALUES ($1, 1) RETURNING id', [seriesId],
  );
  await pool.query('INSERT INTO e_episode (season_id, number) VALUES ($1, 1)', [season[0].id]);
  return seriesId;
}

test('заявка на удаление принимается один раз', { skip }, async () => {
  const { user } = await deletingUser({ inDays: 14 });

  const again = await store.requestDeletion(user.id, {
    deleteMaterials: true,
    requestedAt: new Date(),
    anonymizeAfter: new Date(Date.now() + 86_400_000),
  });

  assert.equal(again, false, 'повторный запрос из «Удаляется» не принимается');
  const { rows } = await pool.query(
    'SELECT delete_materials FROM e_user WHERE id = $1', [user.id],
  );
  assert.equal(rows[0].delete_materials, false, 'и отметка второй раз не переписана');
});

test('отмена удаления возвращает «Активен» и снимает срок', { skip }, async () => {
  const { user } = await deletingUser();

  assert.equal(await store.cancelDeletion(user.id), true);
  const { rows } = await pool.query(
    'SELECT status, anonymize_after, delete_materials FROM e_user WHERE id = $1', [user.id],
  );
  assert.equal(rows[0].status, 'active');
  assert.equal(rows[0].anonymize_after, null);
  assert.equal(rows[0].delete_materials, false);
});

test('просроченные заявки находятся, незапросенные — нет (EC-A17)', { skip }, async () => {
  const later = await deletingUser({ inDays: -1 });
  const now = await confirmedUser();

  const due = await store.dueDeletions(new Date());

  // Проверка членством, а не счётом: база общая, и записи от прошлых прогонов
  // в списке тоже лежат — их отсутствие ничего бы не доказывало.
  assert.ok(due.some((row) => row.id === later.user.id), 'просроченная заявка в списке');
  assert.equal(due.some((row) => row.id === now.user.id), false, 'обычный аккаунт не в списке');
});

test('обезличивание стирает личное и освобождает адрес с ником', { skip }, async () => {
  const { fields, user } = await deletingUser();
  await pool.query(
    `INSERT INTO e_session (user_id, device_label) VALUES ($1, 'браузер')`, [user.id],
  );
  await pool.query(
    `INSERT INTO e_watch_status (user_id, series_id, status)
     VALUES ($1, $2, 'watching')`,
    [user.id, await series()],
  );

  await store.anonymizeUser(user.id);

  const { rows } = await pool.query(
    `SELECT status, deleted_at, anonymized_at, email_hash, email_blind_idx, email_enc,
            password_hash, nickname, locale, theme, timezone, recs_enabled,
            quiet_hours, anonymize_after
       FROM e_user WHERE id = $1`,
    [user.id],
  );
  const row = rows[0];
  assert.ok(row, 'запись осталась: внешние ключи не рвутся');
  assert.equal(row.status, 'deleted');
  assert.ok(row.deleted_at && row.anonymized_at, 'обе даты проставлены');
  assert.equal(row.email_hash, null, 'слепой индекс удалён');
  assert.equal(row.email_blind_idx, null, 'по нему больше не найти');
  assert.equal(row.email_enc, null, 'шифр удалён');
  assert.equal(row.password_hash, '', 'хеш пароля пуст и не подходит ни к одному паролю');
  assert.equal(row.nickname, `удалённый-${user.id}`, 'ник освобождён');
  assert.equal(row.locale, 'ru');
  assert.equal(row.theme, 'system');
  assert.equal(row.timezone, 'UTC');
  assert.equal(row.recs_enabled, false);
  assert.equal(row.quiet_hours, false, 'тихие часы сняты вместе с аккаунтом');
  assert.equal(row.anonymize_after, null, 'срок снят');
  assert.equal(await store.byEmail(fields.email), null, 'по старому адресу не войти');
  assert.equal(await store.nicknameFree(fields.nickname), true, 'ник свободен под новый');

  for (const table of ['e_session', 'e_watch_status']) {
    // eslint-disable-next-line no-await-in-loop
    const left = await pool.query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [user.id]);
    assert.equal(left.rows.length, 0, `${table} очищена`);
  }
});

test('освобождённый адрес занимается заново', { skip }, async () => {
  const { fields, user } = await deletingUser();
  await store.anonymizeUser(user.id);

  // Частичный уникальный индекс смотрит на deleted_at, поэтому новый
  // аккаунт с тем же адресом должен завестись.
  const again = newUser({ email: fields.email });
  const created = await store.createUser(again.fields);

  assert.ok(created.id, 'адрес снова свободен');
  assert.ok(await store.byEmail(fields.email), 'по нему можно войти');
  await pool.query('DELETE FROM e_user WHERE id = $1', [user.id]);
  await pool.query('DELETE FROM e_user WHERE id = $1', [created.id]);
});

test('материалы без отметки остаются, с отметкой исчезают (H-61)', { skip }, async () => {
  const seriesId = await series();
  const mine = await deletingUser({ materials: false });
  const theirs = await confirmedUser();
  const material = (authorId) => pool.query(
    `INSERT INTO e_material (author_id, kind, series_id, body, state)
     VALUES ($1, 'review', $2, 'мой отзыв', 'published') RETURNING id`,
    [authorId, seriesId],
  );
  const kept = await material(mine.user.id);
  const foreign = await material(theirs.user.id);

  await store.anonymizeUser(mine.user.id);

  const left = await pool.query('SELECT body, state FROM e_material WHERE id = $1', [kept.rows[0].id]);
  assert.equal(left.rows.length, 1, 'без отметки материал остался');
  assert.equal(left.rows[0].body, 'мой отзыв', 'текст не тронут');
  const foreignLeft = await pool.query(
    'SELECT 1 FROM e_material WHERE id = $1', [foreign.rows[0].id],
  );
  assert.equal(foreignLeft.rows.length, 1, 'чужой материал цел');

  // Тот же сценарий с отметкой: материал физически удаляется, запись автора
  // остаётся — на неё он и ссылался.
  const marked = await deletingUser({ materials: true });
  const doomed = await material(marked.user.id);
  await store.anonymizeUser(marked.user.id);
  const gone = await pool.query('SELECT 1 FROM e_material WHERE id = $1', [doomed.rows[0].id]);
  assert.equal(gone.rows.length, 0, 'с отметкой материал удалён');
  const authorLeft = await pool.query('SELECT 1 FROM e_user WHERE id = $1', [marked.user.id]);
  assert.equal(authorLeft.rows.length, 1, 'запись автора осталась');
});

test('материал с чужими ответами остаётся оболочкой', { skip }, async () => {
  const owner = await deletingUser({ materials: true });
  const stranger = await confirmedUser();
  const { rows: topic } = await pool.query(
    `INSERT INTO e_material (author_id, kind, series_id, body)
     VALUES ($1, 'topic', $2, 'моя тема') RETURNING id`,
    [owner.user.id, await series()],
  );
  await pool.query(
    `INSERT INTO e_material (author_id, kind, parent_id, body)
     VALUES ($1, 'post', $2, 'ответ')`,
    [stranger.user.id, topic[0].id],
  );

  await store.anonymizeUser(owner.user.id);

  const left = await pool.query(
    'SELECT body, state FROM e_material WHERE id = $1', [topic[0].id],
  );
  assert.equal(left.rows.length, 1, 'тема не исчезла: на неё ссылается чужой ответ');
  assert.equal(left.rows[0].body, '', 'текст очищен');
  assert.equal(left.rows[0].state, 'deleted');
});

// ─── Выгрузка данных (F-01-10 §4, EC-A21) ───────────────────────────────────

test('пауза 24 часа считается по последней заявке (EC-A21)', { skip }, async () => {
  const { user } = await confirmedUser();
  const at = new Date();

  assert.deepEqual(await store.requestExport(user.id, 'ru', at), { ok: true });

  const tooSoon = await store.requestExport(user.id, 'ru', new Date(at.getTime() + 3_600_000));
  assert.equal(tooSoon.ok, false, 'через час второй заказ не проходит');
  assert.ok(tooSoon.retryAt > at, 'сказано, когда можно');

  const later = await store.requestExport(
    user.id, 'ru', new Date(at.getTime() + 25 * 3_600_000),
  );
  assert.deepEqual(later, { ok: true }, 'через сутки снова можно');
  await pool.query('DELETE FROM e_export_job WHERE user_id = $1', [user.id]);
});

test('выгрузка содержит только свои данные', { skip }, async () => {
  const { fields, user } = await confirmedUser();
  const stranger = await confirmedUser();
  const seriesId = await series();

  for (const [author, body] of [[user.id, 'мой отзыв'], [stranger.user.id, 'чужой отзыв']]) {
    await pool.query(
      `INSERT INTO e_material (author_id, kind, series_id, body)
       VALUES ($1, 'review', $2, $3)`,
      [author, seriesId, body],
    );
  }
  const { rows: episode } = await pool.query(
    `SELECT e.id FROM e_episode e
       JOIN e_season s ON s.id = e.season_id WHERE s.series_id = $1`,
    [seriesId],
  );
  await pool.query(
    `INSERT INTO e_rating (user_id, object_type, series_id, episode_id, value)
     VALUES ($1, 'episode', $2, $3, 9)`,
    [user.id, seriesId, episode[0].id],
  );
  await pool.query(
    `INSERT INTO e_session (user_id, device_label) VALUES ($1, 'браузер')`, [user.id],
  );

  const mine = await store.exportData(user.id);

  assert.equal(mine.profile.nickname, fields.nickname);
  assert.equal(mine.materials.length, 1, 'только свои материалы');
  assert.equal(mine.materials[0].body, 'мой отзыв');
  assert.equal(mine.ratings.length, 1, 'свои оценки');
  assert.equal('sessionId' in (mine.devices[0] ?? {}), false, 'идентификатора сессии нет');
  assert.equal(JSON.stringify(mine).includes('чужой отзыв'), false, 'чужих данных нет');
});

test('файл по токену живёт сутки и не отдаётся чужому', { skip }, async () => {
  const { user } = await confirmedUser();
  await store.requestExport(user.id, 'ru', new Date());
  const [job] = await store.dueExports();
  assert.ok(job, 'заказ ждёт сборки');

  const expiresAt = new Date(Date.now() + 86_400_000);
  await store.markExportReady(job.id, '{"nickname":"anna"}', Buffer.alloc(32), 20, expiresAt, 'секретный-токен');

  const own = await store.exportByToken('секретный-токен', new Date());
  assert.equal(own.payload, '{"nickname":"anna"}', 'свой токен открывает файл');

  assert.equal(await store.exportByToken('чужой', new Date()), null, 'чужой токен не открывает');
  assert.equal(
    await store.exportByToken('секретный-токен', new Date(Date.now() + 2 * 86_400_000)), null,
    'после срока ссылка не работает',
  );
  await pool.query('DELETE FROM e_export_job WHERE user_id = $1', [user.id]);
});
