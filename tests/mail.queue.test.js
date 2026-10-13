// Очередь писем против настоящей базы.
//
// SQL в этой очереди легко написать неверно так, что тесты на заглушке
// останутся зелёными: пропущенный столбец в INSERT виден только при
// выполнении запроса (см. преамбулу `auth.store.test.js`).
//
// Тест пропускается без базы: проверять тут нечего.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createMailQueue } from '../src/services/mail/queue.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE — очередь писем не проверялась';

let pool;

/** Очередь с журналом отправок вместо настоящего шлюза. */
function queueWith(sink = { sent: [], fail: 0 }) {
  const sent = [];
  const deliver = async (job) => {
    if (sink.fail > 0) {
      sink.fail -= 1;
      throw new Error('провайдер недоступен');
    }
    sent.push(job);
  };
  return { queue: createMailQueue({ pool, deliver }), sent, sink };
}

/**
 * Письмо со ссылкой на смену пароля.
 *
 * Ссылка — это то, ради чего письмо и нужно: маршрут собирает её из адреса
 * приложения и токена. Проверка «письмо без ссылки не ставится» живёт в
 * `mails.test.js`, здесь она мешала бы проверять очередь.
 */
function resetJob(over = {}) {
  return {
    kind: 'password_reset',
    to: 'queue@example.com',
    locale: 'ru',
    link: 'http://127.0.0.1:3000/ru/password/reset?token=abc123',
    ...over,
  };
}

test.before(async () => {
  if (!available) return;
  pool = createPool();
});

test.beforeEach(async () => {
  if (!available) return;
  await pool.query("DELETE FROM e_mail WHERE recipient_enc IS NOT NULL");
});

test('письмо встаёт в очередь и ждёт отправки', { skip }, async () => {
  const { queue } = queueWith();
  const id = await queue.enqueue(resetJob());
  assert.ok(id, 'заявка должна вернуть идентификатор письма');

  const { rows } = await pool.query('SELECT * FROM e_mail WHERE id = $1', [id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'queued');
  assert.equal(rows[0].kind, 'password_reset');
  assert.equal(rows[0].locale, 'ru');
  assert.equal(rows[0].attempts, 0, 'до попытки отправки попыток не было');
  assert.equal(rows[0].sent_at, null);
  assert.ok(rows[0].subject.length > 0, 'тема заполнена');
  assert.ok(rows[0].body.includes('queue@example.com') === false, 'адрес получателя не в теле');
});

test('адрес получателя лежит зашифрованным', { skip }, async () => {
  const { queue } = queueWith();
  const id = await queue.enqueue(resetJob());

  const { rows } = await pool.query('SELECT recipient_enc FROM e_mail WHERE id = $1', [id]);
  assert.ok(Buffer.isBuffer(rows[0].recipient_enc), 'шифротекст, а не открытый адрес');
  assert.equal(rows[0].recipient_enc.toString('utf8').includes('example.com'), false);
});

test('письмо не отправляется раньше срока', { skip }, async () => {
  const { queue, sent } = queueWith();
  await queue.enqueue(resetJob());
  // Следующая попытка — в будущем, поэтому работник не должен брать письмо.
  const done = await queue.processDue({ now: new Date(Date.now() - 60_000) });
  assert.equal(done, 0, 'ничего не отправлено');
  assert.equal(sent.length, 0);
});

test('подошедшее письмо отправляется и помечается отправленным', { skip }, async () => {
  const { queue, sent } = queueWith();
  const id = await queue.enqueue(resetJob());

  const done = await queue.processDue({ now: new Date(Date.now() + 1_000) });
  assert.equal(done, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'queue@example.com', 'адрес расшифрован для отправки');
  assert.ok(sent[0].subject.length > 0, 'шлюз получил тему');
  assert.ok(
    sent[0].body.includes(resetJob().link),
    'тело пришло со ссылкой целиком: обрезанная ссылка бесполезна',
  );

  const { rows } = await pool.query('SELECT status, sent_at, attempts FROM e_mail WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'sent');
  assert.ok(rows[0].sent_at, 'время отправки записано');
  assert.equal(rows[0].attempts, 1);
});

test('отправленное письмо повторно не отправляется', { skip }, async () => {
  const { queue, sent } = queueWith();
  await queue.enqueue(resetJob());

  await queue.processDue({ now: new Date(Date.now() + 1_000) });
  await queue.processDue({ now: new Date(Date.now() + 60_000) });
  assert.equal(sent.length, 1, 'второй раз письмо из очереди не берётся');
});

test('письмо, взятое в обработку, второй раз не отправляется', { skip }, async () => {
  // Гонка двух проходов по очереди: первый взял письмо, но ещё отправляет.
  // Без аренды второй проход взял бы то же письмо, и человек получил бы
  // его дважды.
  const { queue, sent } = queueWith();
  const id = await queue.enqueue(resetJob());

  await queue.processDue({ now: new Date(Date.now() + 1_000) });
  const done = await queue.processDue({ now: new Date(Date.now() + 2_000) });

  assert.equal(done, 0, 'взятое письмо второй раз не берётся');
  assert.equal(sent.length, 1, 'и не отправляется повторно');

  const { rows } = await pool.query('SELECT next_attempt_at FROM e_mail WHERE id = $1', [id]);
  assert.ok(
    rows[0].next_attempt_at > new Date(),
    'письмо арендовано: время следующей попытки сдвинуто вперёд',
  );
});

test('неудача отправки оставляет письмо в очереди с увеличенной попыткой', { skip }, async () => {
  const { queue } = queueWith({ fail: 1 });
  const id = await queue.enqueue(resetJob());

  await queue.processDue({ now: new Date(Date.now() + 1_000) });

  const { rows } = await pool.query('SELECT status, attempts, next_attempt_at, last_error FROM e_mail WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'queued', 'письмо ждёт следующей попытки, а не потеряно');
  assert.equal(rows[0].attempts, 1);
  assert.ok(rows[0].last_error, 'причина сбоя записана: без неё очередь молчит о проблеме');
  assert.ok(
    rows[0].next_attempt_at > new Date(),
    'сразу повторять нельзя: очередь долбила бы провайдера',
  );
});

test('письмо с исчерпанными попытками помечается неудачным', { skip }, async () => {
  // Пять попыток по F-01-12 §5; после пятой письмо больше не ждёт.
  const { queue } = queueWith({ fail: 99 });
  const id = await queue.enqueue(resetJob());

  for (let i = 0; i < 6; i += 1) {
    await queue.processDue({ now: new Date(Date.now() + i * 3_600_000) });
  }

  const { rows } = await pool.query('SELECT status, attempts FROM e_mail WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'failed', 'письмо не крутится в очереди вечно');
  assert.equal(rows[0].attempts, 5, 'попытки прекращаются на пятой');
});

test('слишком много писем в очереди — новое отклоняется', { skip }, async () => {
  // Лимит из F-01-12 §9: 10 000 писем, дальше новые отклоняются. Проверять
  // его на настоящей цифре незачем — ради этого параметр и сделан.
  const queue = createMailQueue({ pool, deliver: async () => {}, maxQueued: 2 });

  await queue.enqueue(resetJob({ to: 'one@example.com' }));
  await queue.enqueue(resetJob({ to: 'two@example.com' }));

  // При срабатывании предохранителя заявка человека не должна выглядеть
  // как обработанная, поэтому это отказ, а не молчаливая потеря письма.
  await assert.rejects(
    () => queue.enqueue(resetJob({ to: 'three@example.com' })),
    /очередь/i,
  );
});
// ─── Режим devbox и демо-помощник (F-01-12 §4, §8(в), H-51) ───────────────

test('письмо велико не ставится в очередь', { skip }, async () => {
  const { queue } = queueWith();

  await assert.rejects(
    () => queue.enqueue(resetJob({ link: `http://x/reset?token=${'a'.repeat(120_000)}` })),
    /велико/,
    'письмо больше предела отвергается до вставки',
  );
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM e_mail');
  assert.equal(rows[0].n, 0, 'в очередь оно не попало');
});

test('письма своего браузера находятся, чужие — нет (H-51)', { skip }, async () => {
  const { queue } = queueWith();

  await queue.enqueue(resetJob({ browserId: 'браузер-анны' }));
  await queue.enqueue(resetJob({ browserId: 'чужой-браузер' }));

  const mine = await queue.forBrowser('браузер-анны');
  assert.equal(mine.length, 1, 'своё письмо найдено');
  assert.match(mine[0].body, /token=abc123/, 'тело письма на месте — из него берётся ссылка');
  assert.equal((await queue.forBrowser('чужой-браузер')).length, 1, 'у чужого — своё');
  assert.deepEqual(await queue.forBrowser(''), [], 'без отметки браузера — ничего');
});

test('отметка браузера в базе лежит хешем', { skip }, async () => {
  const { queue } = queueWith();
  await queue.enqueue(resetJob({ browserId: 'браузер-анны' }));

  const { rows } = await pool.query('SELECT browser_id FROM e_mail LIMIT 1');
  assert.ok(rows[0].browser_id, 'отметка записана');
  assert.equal(rows[0].browser_id.includes('браузер'), false, 'открытым текстом не лежит');
});

test('письма старше срока удаляются, неотправленные — нет', { skip }, async () => {
  const { queue } = queueWith();
  const sent = await queue.enqueue(resetJob());
  const waiting = await queue.enqueue(resetJob({ to: 'second@example.com' }));

  // Второе письмо отодвигается: иначе выборка «по времени следующей попытки»
  // взяла бы любое из двух, и проверялось бы не то.
  await pool.query(
    `UPDATE e_mail SET next_attempt_at = now() + interval '1 hour' WHERE id = $1`, [waiting],
  );
  // Одно письмо уходит, второе остаётся ждать провайдера; обоим по восемь дней.
  await pool.query(`UPDATE e_mail SET status = 'queued', next_attempt_at = now() WHERE id = $1`, [sent]);
  await queue.processDue();
  await pool.query(`UPDATE e_mail SET created_at = now() - interval '8 days'`);
  await pool.query(`UPDATE e_mail SET status = 'queued', next_attempt_at = now() WHERE id = $1`, [waiting]);

  const removed = await queue.purge();

  const { rows } = await pool.query('SELECT id, status FROM e_mail');
  assert.equal(removed, 1, 'удалено ровно одно — отправленное');
  assert.equal(rows.length, 1, 'в базе осталось одно');
  assert.equal(rows[0].id, waiting, 'осталось неотправленное: его ещё ждут');
  assert.equal(rows[0].status, 'queued');
});

test('список для ящика отдаёт ссылку из тела', { skip }, async () => {
  const { queue } = queueWith();
  await queue.enqueue(resetJob());

  const [row] = await queue.listing();
  assert.equal(row.kind, 'password_reset');
  assert.equal(row.link, 'http://127.0.0.1:3000/ru/password/reset?token=abc123');
  assert.equal(row.recipient, undefined, 'получатель в списке открытым не лежит');
});

test('пауза между попытками растёт: 1, 2, 4, 8, 16 минут', { skip }, async () => {
  // F-01-12 §5 называет именно эти числа; линейный рост растягивал последнюю
  // попытку до пяти минут вместо шестнадцати.
  const { queue, sink } = queueWith({ fail: 0 });
  const id = await queue.enqueue(resetJob());

  const wait = async (attempts) => {
    await pool.query(
      `UPDATE e_mail SET status = 'queued', attempts = 0, next_attempt_at = now()
        WHERE id = $1`,
      [id],
    );
    await queue.fail(id, attempts, 'провайдер недоступен');
    const { rows } = await pool.query(
      `SELECT EXTRACT(EPOCH FROM (next_attempt_at - now())) / 60 AS minutes FROM e_mail
        WHERE id = $1`,
      [id],
    );
    return Math.round(Number(rows[0].minutes));
  };

  const seen = [];
  for (const attempts of [1, 2, 3, 4, 5]) {
    // eslint-disable-next-line no-await-in-loop
    seen.push(await wait(attempts));
  }
  assert.deepEqual(seen, [1, 2, 4, 8, 16], 'пауза удваивается, а не растёт на минуту');
  void sink;
});
