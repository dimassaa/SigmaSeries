// Снимок для защиты: копия, которая действительно проверяется (F-12-10 §3).
//
// Ключевое здесь — порядок и подмена. Настоящий `pg_dump` базы на 450 МБ
// занимает минуты, но именно он раньше молча не выполнялся: команда создавала
// службу без копии, тесты подставляли заглушку, и всё оставалось зелёным.
// Поэтому проверяется и порядок обращений, и отказ при каждом шаге.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSnapshotBackup } from '../src/services/backup/snapshot.js';

/**
 * Заглушка внешних вызовов: пишет, что было, и отвечает как велит сценарий.
 *
 * Файл дампа подменённый `pg_dump` пишет по-настоящему — иначе `fs.stat` в
 * службе спотыкался бы о пустой каталог, и пришлось бы внедрять ещё и
 * файловую систему. Один настоящий файл в настоящем каталоге дешевле.
 */
function fakeExec({ liveCount = 42, restoredCount = 42, failOn = null } = {}) {
  const calls = [];
  const exec = async (file, args, _options) => {
    calls.push([file, ...args.filter((a) => !a.startsWith('/'))].join(' '));
    if (failOn === file) throw new Error(`${file}: сработал отказ`);
    if (file === 'pg_dump') {
      const target = args[args.indexOf('-f') + 1];
      await fs.writeFile(target, 'BEGIN\n');
    }
    if (file === 'psql') return { stdout: `${restoredCount}\n` };
    return { stdout: '' };
  };
  return { exec, calls, pool: { query: async () => ({ rows: [{ n: liveCount }] }) } };
}

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-test-'));

test('порядок: снять, создать временную базу, развернуть, сверить, удалить', async () => {
  const { exec, calls, pool } = fakeExec();
  const result = await createSnapshotBackup({ pool, exec, tmpDir });

  assert.equal(result.status, 'verified', result.error);
  assert.deepEqual(calls.map((c) => c.split(' ')[0]), [
    'pg_dump', 'createdb', 'pg_restore', 'psql', 'dropdb',
  ]);
  assert.ok(result.bytes >= 0);
});

test('во временную базу, а не в рабочую', async () => {
  const { exec, calls, pool } = fakeExec();
  await createSnapshotBackup({ pool, exec, tmpDir });

  const restore = calls.find((c) => c.startsWith('pg_restore'));
  assert.match(restore, /defence_check_/, 'имя временной базы обязано отличаться от рабочей');
  assert.doesNotMatch(restore, /-d serial_tracker/, 'восстановление в рабочую базу ничего не проверяет');
});

test('меньше сериалов, чем в жизни — это ошибка, а не «примерно»', async () => {
  const { exec, pool } = fakeExec({ liveCount: 1052, restoredCount: 1040 });
  const result = await createSnapshotBackup({ pool, exec, tmpDir });

  assert.equal(result.status, 'error');
  assert.match(result.error, /1040/);
});

test('больше сериалов, чем в жизни — тоже ошибка', async () => {
  const { exec, pool } = fakeExec({ liveCount: 10, restoredCount: 11 });
  const result = await createSnapshotBackup({ pool, exec, tmpDir });
  assert.equal(result.status, 'error', 'лишние строки означают, что восстановили не тот снимок');
});

test('пустая база сверяется как нулевая, а не пропускается', async () => {
  // Иначе первая же заморозка на пустой базе прошла бы с любым мусором.
  const { exec, pool } = fakeExec({ liveCount: 0, restoredCount: 7 });
  const result = await createSnapshotBackup({ pool, exec, tmpDir });
  assert.equal(result.status, 'verified', result.error);
});

test('упавший pg_dump — это ошибка, а не пустая копия', async () => {
  const { exec, pool } = fakeExec({ failOn: 'pg_dump' });
  const result = await createSnapshotBackup({ pool, exec, tmpDir });
  assert.equal(result.status, 'error');
  assert.match(result.error, /pg_dump/);
});

test('упавший pg_restore — ошибка', async () => {
  const { exec, pool } = fakeExec({ failOn: 'pg_restore' });
  const result = await createSnapshotBackup({ pool, exec, tmpDir });
  assert.equal(result.status, 'error');
});

test('временная база удаляется даже при упавшем восстановлении', async () => {
  const { exec, calls, pool } = fakeExec({ failOn: 'pg_restore' });
  await createSnapshotBackup({ pool, exec, tmpDir });
  assert.ok(
    calls.some((c) => c.startsWith('dropdb')),
    'иначе каждая неудачная заморозка оставляла бы базу на диске',
  );
});

test('отказ удаления временной базы не превращает успех в ошибку', async () => {
  // Копия уже проверена; из-за неудачного `dropdb` заморозка срываться не
  // должна — но молчать о мусоре тоже нельзя.
  const base = fakeExec();
  const exec = async (file, args, options) => {
    if (file === 'dropdb') throw new Error('нет прав');
    return base.exec(file, args, options);
  };
  const result = await createSnapshotBackup({ pool: base.pool, exec, tmpDir });
  assert.equal(result.status, 'verified');
});
