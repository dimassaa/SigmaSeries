// Похожие сериалы (F-02-08).
//
// Проверяются и веса (правило: редкий признак весит больше), и то, что в
// выдачу попадают шесть лучших без самого сериала.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import {
  similarityPairs, idfWeight, SIMILAR_LIMIT,
} from '../src/services/catalogue/similar.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available ? false : 'нет PGHOST/PGUSER/PGDATABASE — «Похожие» не проверялись';

let pool;

test.before(async () => {
  if (!available) return;
  pool = createPool();
});

test.after(async () => {
  if (!pool) return;
  await pool.end();
});

test('редкий признак весит больше частого', () => {
  assert.equal(SIMILAR_LIMIT, 6, 'шесть лучших — из правила F-02-08');

  const rare = idfWeight({ documents: 100, frequency: 2 });
  const common = idfWeight({ documents: 100, frequency: 100 });
  assert.ok(rare > common, 'редкий признак говорит больше');
  assert.equal(common, 0, 'признак у всех не различает ничего');
  assert.equal(idfWeight({ documents: 0, frequency: 0 }), 0);
});

test('в выдаче шесть лучших, без самого сериала, равные весы — по голосам', () => {
  const features = new Map();
  // Первый сериал делит страну с тремя, а жанр — со всеми: общий жанр не
  // различает и веса не даёт.
  features.set(1, new Set(['genre:drama', 'country:us', 'rare:one']));
  features.set(2, new Set(['genre:drama', 'country:us', 'rare:one']));
  features.set(3, new Set(['genre:drama', 'country:us']));
  features.set(4, new Set(['genre:drama', 'country:us']));
  for (let i = 5; i <= 11; i += 1) features.set(i, new Set(['genre:drama', `unique:${i}`]));

  const votes = new Map([[3, 500], [4, 100]]);
  const pairs = similarityPairs({ features, votes, limit: 3 });

  const first = pairs.get(1);
  assert.equal(first.length, 3, 'не больше лимита');
  assert.ok(!first.some((pair) => pair.similarId === 1), 'самого себя в выдаче нет');
  assert.equal(first[0].similarId, 2, 'редкий общий признак поднял кандидата');
  assert.ok(first[0].weight > first[1].weight, 'веса убывают');
  assert.equal(first[1].similarId, 3, 'при равных весах больше голосов — ближе');
});

test('без общих признаков пар нет', () => {
  const features = new Map([
    [1, new Set(['genre:drama'])],
    [2, new Set(['genre:comedy'])],
  ]);
  const pairs = similarityPairs({ features });
  assert.equal(pairs.get(1), undefined, 'нечего показывать — блок скрыт');
});
