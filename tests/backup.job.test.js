// OP-17 — резервная копия. Тесты.
// Спецификация: docs/01-product/features/M9-admin.md F-09-04.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createVerifiedBackup,
  rotatable,
  isStale,
  shouldCatchUp,
  SIZES,
} from '../src/services/backup/job.js';

/** Заглушки внешних эффектов: модуль не знает, откуда берётся дамп. */
function deps(over = {}) {
  const events = [];
  const base = {
    dump: async () => ({ bytes: 1000, checksum: 'abc' }),
    restore: async () => true,
    dbSize: async () => ({ dbBytes: 5000 }), // 1000 > 10% от 5000
    onEvent: async (e) => { events.push(e); },
    id: 'job_test',
  };
  return { ...base, ...over, events };
}

// ─── Статус копии ─────────────────────────────────────────────────────────────

test('копия считается проверенной только после реального восстановления', async () => {
  const d = deps();
  const job = await createVerifiedBackup(d);
  assert.equal(job.status, 'verified');
});

test('восстановление, вернувшее false, оставляет копию негодной', async () => {
  const d = deps({ restore: async () => false });
  const job = await createVerifiedBackup(d);
  assert.equal(job.status, 'error');
});

test('восстановление, бросившее исключение, не роняет саму операцию', async () => {
  const d = deps({ restore: async () => { throw new Error('нет диска'); } });
  const job = await createVerifiedBackup(d);
  assert.equal(job.status, 'error');
  assert.match(job.error, /restore/);
});

test('неудачный дамп не трогает предыдущие копии и сообщает администратору', async () => {
  const d = deps({ dump: async () => { throw new Error('нет места'); } });
  const job = await createVerifiedBackup(d);
  assert.equal(job.status, 'error');
  assert.equal(d.events.at(-1).type, 'backup.dump_failed');
});

test('подозрительно маленькая копия не проверяется, а помечается ошибкой', async () => {
  // Восстанавливать нечего: пустой или обрезанный дамп поднимется
  // «успешно» и обманет ровно так же, как отсутствие копии.
  let restored = false;
  const d = deps({
    dump: async () => ({ bytes: 10, checksum: 'x' }),
    dbSize: async () => ({ dbBytes: 100000 }),
    restore: async () => { restored = true; return true; },
  });
  const job = await createVerifiedBackup(d);
  assert.equal(job.status, 'error');
  assert.equal(restored, false, 'проверка не должна запускаться');
  assert.equal(d.events.at(-1).type, 'backup.too_small');
});

// ─── Ротация ──────────────────────────────────────────────────────────────────

test('ротация удаляет только проверенные копии', () => {
  // EC-B8: если удалять и негодные, то после серии неудачных проверок
  // не останется ничего. Это самая дорогая ошибка в модуле.
  const jobs = [
    { id: 'a', status: 'verified' }, { id: 'b', status: 'verified' },
    { id: 'c', status: 'error' }, { id: 'd', status: 'created' },
  ];
  assert.deepEqual(rotatable(jobs, 2), [], 'ошибку удалять нельзя');
});

test('ротация оставляет последние N проверенных, удаляя самые старые', () => {
  // Порядок: свежие первыми. Значит хвост списка — самые старые, и именно
  // они уходят. Если порядок поменяется местами, удалится не то.
  const jobs = [
    { id: 'свежая', status: 'verified' }, { id: 'свежее', status: 'verified' },
    { id: 'средняя', status: 'verified' }, { id: 'старая', status: 'verified' },
  ];
  assert.deepEqual(rotatable(jobs, 3), ['старая']);
  assert.deepEqual(rotatable(jobs, 1), ['свежее', 'средняя', 'старая']);
  assert.deepEqual(rotatable(jobs, 4), [], 'слотов столько же, сколько копий — ничего не удаляется');
  assert.equal(rotatable(jobs, SIZES.keep).length, 0);
});

test('проверенная копия не удаляется, если она моложе остальных негодных', () => {
  const jobs = [
    { id: 'свежая-ошибка', status: 'error' },
    { id: 'старая-ошибка', status: 'error' },
    { id: 'проверенная', status: 'verified' },
  ];
  assert.deepEqual(rotatable(jobs, 1), []);
});

// ─── Устаревание ──────────────────────────────────────────────────────────────

test('копия без отметки о проверке считается устаревшей', () => {
  assert.equal(isStale({ status: 'verified' }, Date.now()), true);
});

test('свежепроверенная копия не устаревает', () => {
  const now = Date.now();
  assert.equal(isStale({ status: 'verified', verifiedAt: now - 3600 * 1000 }, now), false);
});

test('копия старше суток устаревает', () => {
  const now = Date.now();
  assert.equal(isStale({ status: 'verified', verifiedAt: now - 25 * 3600 * 1000 }, now), true);
});

// ─── Догон после простоя ──────────────────────────────────────────────────────

test('первый запуск создаёт копию', () => {
  assert.equal(shouldCatchUp(null, Date.now()), true);
});

test('после простоя длиннее 36 часов копия догоняется', () => {
  // Планировщик живёт в процессе и не переживает перезапуск (ADR-004).
  const now = Date.now();
  assert.equal(shouldCatchUp({ status: 'verified', finishedAt: now - 37 * 3600 * 1000 }, now), true);
  assert.equal(shouldCatchUp({ status: 'verified', finishedAt: now - 35 * 3600 * 1000 }, now), false);
});

test('после неудачной копии следующая пробуется снова', () => {
  const now = Date.now();
  assert.equal(shouldCatchUp({ status: 'error', finishedAt: now }, now), true);
});