// Словарь модерации: загрузка и отказ (OP-01).
//
// Загрузка вынесена из проверки текста: `checkMaterial` — чистая функция, а
// доступность словаря — свойство базы. Отсюда единственное правило, которое
// здесь проверяется: сбой чтения не должен превращаться в «словарь пуст» —
// иначе упавшая база молча публиковала бы всё подряд (F-05-02 правило (а)).

import test from 'node:test';
import assert from 'node:assert/strict';

import { pgDictionary } from '../src/services/moderation/dictionary.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — словарь не проверялся';

const PREFIX = 'zz-dict-test-';
let pool;

test.before(async () => {
  if (!available) return;
  const { createPool } = await import('../src/db/pool.js');
  pool = createPool();
  await pool.query(`DELETE FROM e_dictionary_word WHERE word LIKE '${PREFIX}%'`);
});

test.after(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM e_dictionary_word WHERE word LIKE '${PREFIX}%'`);
  await pool.end();
});

test('словарь отдаёт слова списков и их категории', { skip }, async () => {
  await pool.query(
    `INSERT INTO e_dictionary_word (word, language, list, category) VALUES
       ($1, 'ru', 'block', 'profanity'), ($2, 'ru', 'allow', NULL)`,
    [`${PREFIX}слово`, `${PREFIX}можно`],
  );
  const dictionary = await pgDictionary(pool).load();
  assert.equal(dictionary.available, true);
  assert.deepEqual(dictionary.block, [{ word: `${PREFIX}слово`, category: 'profanity' }]);
  assert.deepEqual(dictionary.allow, [{ word: `${PREFIX}можно`, category: null }]);
});

test('неактивные слова не попадают в словарь', { skip }, async () => {
  await pool.query(
    `INSERT INTO e_dictionary_word (word, language, list, active)
     VALUES ($1, 'ru', 'block', FALSE)`, [`${PREFIX}выключено`],
  );
  const dictionary = await pgDictionary(pool).load();
  assert.ok(!dictionary.block.some((item) => item.word === `${PREFIX}выключено`));
});

test('сбой базы — словарь недоступен, а не пуст (F-05-02 а)', async () => {
  const broken = { query: async () => { throw new Error('база недоступна'); } };
  const dictionary = await pgDictionary(broken, { onError: () => {} }).load();
  assert.equal(dictionary.available, false);
  assert.deepEqual(dictionary.block, []);
  assert.deepEqual(dictionary.allow, []);
});
