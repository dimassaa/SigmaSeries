// Ночная резервная копия по расписанию (F-09-04 §3, `backup.schedule`).
//
// Копия создавалась только при заморозке каталога, то есть на защите сервер мог
// неделю работать без копии, и никто об этом не узнавал: журнал `e_backup_job`
// молчал, а экран со списком копий ещё и не был написан. Расписание было в
// таблице настроек модуля и не читалось нигде.
//
// Задача спрашивает базу, а не помнит своё расписание: сервер мог быть выключен
// в назначенный час, и пропущенный день догоняется при ближайшем запуске — но
// копия за этот день всё равно создаётся, потому что пропущенная копия хуже
// копии поздней.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBackupTask, parseSchedule, DEFAULT_SCHEDULE, TICK_MS,
} from '../src/services/backup/schedule.js';

test('расписание разбирается, а мусор заменяется значением по умолчанию', () => {
  assert.deepEqual(parseSchedule('03:30'), { hour: 3, minute: 30 });
  assert.deepEqual(parseSchedule(' 23:05 '), { hour: 23, minute: 5 });
  // Мусор в настройке не должен останавливать копирование: лучше копия в
  // неожиданное время, чем её отсутствие.
  for (const bad of [null, '', 'полдень', '25:00', '03:99', '0330']) {
    assert.deepEqual(parseSchedule(bad), parseSchedule(DEFAULT_SCHEDULE), `«${bad}»`);
  }
});

// Время задаётся локальной датой без зоны: `03:30` в настройке — это 03:30 там,
// где стоит сервер, а не в UTC. Проверяется на «половине суток», где сдвиг зоны
// был бы виден.
const at = (hour, minute) => {
  const date = new Date(2026, 9, 17, hour, minute, 0, 0);
  return date;
};

test('до назначенного часа копия не нужна', () => {
  const task = createBackupTask({
    pool: null,
    backups: {},
    snapshot: async () => ({ status: 'verified', bytes: 1 }),
    now: () => at(2, 0),
    lastBackupAt: async () => null,
  });
  assert.equal(task.due(), false, 'в 02:00 копия на 03:30 не делается');
});

test('после назначенного часа копия нужна', () => {
  const task = createBackupTask({
    pool: null,
    backups: {},
    snapshot: async () => ({ status: 'verified', bytes: 1 }),
    now: () => at(3, 45),
    lastBackupAt: async () => null,
  });
  assert.equal(task.due(), true, 'в 03:45 копия за сегодня ещё не делалась');
});

test('копия за сегодня уже есть — повторно не делается', () => {
  // Без этой проверки задача создавала бы копию при каждом тике.
  const task = createBackupTask({
    pool: null,
    backups: {},
    snapshot: async () => ({ status: 'verified', bytes: 1 }),
    now: () => at(9, 0),
    lastBackupAt: async () => at(3, 30),
  });
  assert.equal(task.due(), false, 'вторая копия за тот же день не нужна');
});

test('копия вчерашнего дня копию сегодняшнего не отменяет', () => {
  const task = createBackupTask({
    pool: null,
    backups: {},
    snapshot: async () => ({ status: 'verified', bytes: 1 }),
    now: () => at(9, 0),
    lastBackupAt: async () => at(0, 1),   // сегодня, но до расписания
  });
  assert.equal(task.due(), true, 'важно время копии, а не только дата');
});

test('проход снимает копию, пишет в журнал и чистит старые', async () => {
  const calls = [];
  const task = createBackupTask({
    pool: null,
    backups: {
      record: async (row) => { calls.push(['record', row]); return { id: 1 }; },
      prune: async (args) => { calls.push(['prune', args]); return 0; },
    },
    snapshot: async () => ({ status: 'verified', bytes: 4096, file: '/backups/сегодня.dump' }),
    now: () => at(4, 0),
    lastBackupAt: async () => null,
  });

  const result = await task.run();

  assert.equal(result.status, 'verified');
  assert.deepEqual(calls.map(([name]) => name), ['record', 'prune']);
  assert.deepEqual(calls[0][1], {
    status: 'verified', sizeBytes: 4096, filePath: '/backups/сегодня.dump',
  });
});

test('неудачная копия тоже попадает в журнал', async () => {
  // Иначе в списке копий не было бы видно, что копирование перестало работать.
  const calls = [];
  const task = createBackupTask({
    pool: null,
    backups: {
      record: async (row) => { calls.push(row); return { id: 2 }; },
      prune: async () => 0,
    },
    snapshot: async () => ({ status: 'error', bytes: 0, error: 'pg_dump: нет доступа' }),
    now: () => at(4, 0),
    lastBackupAt: async () => null,
  });

  await task.run();

  assert.equal(calls[0].status, 'error', 'сбой виден в журнале, а не теряется');
});

test('шаг задачи — четверть часа', () => {
  // Числа в таблице M9 §0 нет: за шаг берётся тот же, что у задачи обезличивания,
  // потому что обе задачи живут в одном процессе и разъезжаться им незачем.
  assert.equal(TICK_MS, 15 * 60_000);
});