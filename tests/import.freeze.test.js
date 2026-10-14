// Режим защиты: заморозка и разморозка (F-12-10).
//
// Суть режима — одна гарантия: во время него не уходит ни одного запроса
// наружу. Всё остальное (бейдж, кнопка) — интерфейс поверх неё, а он
// не построен, потому что администратора в системе нет (#64).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPool } from '../src/db/pool.js';
import { createFreezeService } from '../src/services/import/freeze.js';

const available = Boolean(process.env.PGHOST && process.env.PGDATABASE);
const skip = available
  ? false
  : 'нет PGHOST/PGUSER/PGDATABASE или TEST_DATABASE_URL — режим защиты не проверялся';

let pool;
let freeze;

test.before(async () => {
  if (!available) return;
  pool = createPool();
  freeze = createFreezeService({ pool, mailMode: null });
});

test.after(async () => {
  if (pool) {
    await pool.query("UPDATE e_system_setting SET value = 'on' WHERE key = 'import.enabled'");
    await pool.query("DELETE FROM e_system_setting WHERE key LIKE 'defence.%'");
    await pool.end();
  }
});

/** Ключи настроек до и после, чтобы тест ничего не оставлял за собой. */
async function reset() {
  await pool.query("UPDATE e_system_setting SET value = 'on' WHERE key = 'import.enabled'");
  await pool.query("DELETE FROM e_system_setting WHERE key LIKE 'defence.%'");
}

// ─── Состояние ────────────────────────────────────────────────────────────────

test('изначально режим защиты выключен', { skip }, async () => {
  await reset();
  const state = await freeze.state();
  assert.equal(state.frozen, false);
});

test('заморозка выключает импорт и оставляет метку', { skip }, async () => {
  await reset();
  await freeze.freeze({ at: new Date('2026-10-14T12:00:00Z') });

  const state = await freeze.state();
  assert.equal(state.frozen, true);
  assert.equal(state.since, '2026-10-14');
  // false означает «админ не просил менять почту», null — «заморозки ещё не было».
  assert.equal(state.mailDevbox, false);

  const { rows } = await pool.query("SELECT value FROM e_system_setting WHERE key = 'import.enabled'");
  assert.equal(rows[0].value, 'off', 'планировщик должен остановиться');
});

test('разморозка возвращает импорт', { skip }, async () => {
  await reset();
  await freeze.freeze({ at: new Date('2026-10-14T12:00:00Z') });
  await freeze.unfreeze();

  const state = await freeze.state();
  assert.equal(state.frozen, false);
  const { rows } = await pool.query("SELECT value FROM e_system_setting WHERE key = 'import.enabled'");
  assert.equal(rows[0].value, 'on', 'EC-I13: после разморозки всё возвращается');
});

test('повторная заморозка обновляет метку, а не ломает состояние', { skip }, async () => {
  await reset();
  await freeze.freeze({ at: new Date('2026-10-14T12:00:00Z') });
  await freeze.freeze({ at: new Date('2026-10-15T09:00:00Z') });

  const state = await freeze.state();
  assert.equal(state.frozen, true);
  assert.equal(state.since, '2026-10-15');
});

// ─── Почта ────────────────────────────────────────────────────────────────────

test('по требованию админа почта переводится в devbox', { skip }, async () => {
  await reset();
  // Заглушка ведёт себя как настоящий переключатель: `current()` отдаёт то,
  // что поставили. Иначе разморозка «восстановила» бы то, чего не было.
  const stubMode = {
    async current() {
      return stubMode.value;
    },
    async set(next) {
      stubMode.value = next;
      return { changed: true, mode: next, source: 'manual' };
    },
    value: 'smtp',
  };
  const service = createFreezeService({ pool, mailMode: stubMode });

  await service.freeze({ at: new Date('2026-10-14T12:00:00Z'), mailDevbox: true });
  assert.equal(stubMode.value, 'devbox');
  const state = await service.state();
  assert.equal(state.mailDevbox, true);

  await service.unfreeze();
  assert.equal(stubMode.value, 'smtp', 'разморозка возвращает почту как было');
});

test('без запроса почту не трогаем', { skip }, async () => {
  await reset();
  let touched = false;
  const stubMode = {
    async current() { return 'smtp'; },
    async set() { touched = true; return { changed: true, mode: 'devbox', source: 'manual' }; },
  };
  const service = createFreezeService({ pool, mailMode: stubMode });
  await service.freeze({ at: new Date('2026-10-14T12:00:00Z') });
  assert.equal(touched, false, 'F-01-12 §8: режим почты меняет только админ');
  await service.unfreeze();
});

// ─── Запреты ──────────────────────────────────────────────────────────────────

test('заморозка невозможна при идущем запуске импорта', { skip }, async () => {
  await reset();
  const { rows } = await pool.query(
    `INSERT INTO e_import_run (kind, dry_run, status) VALUES ('full_run', FALSE, 'running') RETURNING id`,
  );
  try {
    await assert.rejects(() => freeze.freeze({ at: new Date() }), /идёт|идущ/);
    const state = await freeze.state();
    assert.equal(state.frozen, false, 'неудачная заморозка не должна оставлять следов');
  } finally {
    await pool.query('DELETE FROM e_import_run WHERE id = $1', [rows[0].id]);
  }
});

test('неудачная копия отменяет заморозку (§F-12-10 §3)', { skip }, async () => {
  await reset();
  const service = createFreezeService({
    pool,
    mailMode: null,
    backup: async () => ({ status: 'error', error: 'dump: нет места' }),
  });

  await assert.rejects(() => service.freeze({ at: new Date(), requireBackup: true }), /копи|место/i);

  const state = await service.state();
  assert.equal(state.frozen, false, 'заморозка без копии — это ложь в отчёте');
  const { rows } = await pool.query("SELECT value FROM e_system_setting WHERE key = 'import.enabled'");
  assert.equal(rows[0].value, 'on', 'и импорт не выключается');
});

test('проверенная копия завершает заморозку', { skip }, async () => {
  await reset();
  const service = createFreezeService({
    pool,
    mailMode: null,
    backup: async () => ({ status: 'verified', bytes: 1024, checksum: 'abc' }),
  });

  const result = await service.freeze({ at: new Date('2026-10-14T12:00:00Z'), requireBackup: true });
  assert.equal(result.backup.status, 'verified');
  assert.equal(result.frozen, true);
  await service.unfreeze();
});

test('непроверенная копия копией не считается', { skip }, async () => {
  await reset();
  const service = createFreezeService({
    pool,
    mailMode: null,
    // `created` — файл есть, но восстановление не проверяли (OP-17).
    backup: async () => ({ status: 'created', bytes: 1024, checksum: 'abc' }),
  });
  await assert.rejects(() => service.freeze({ at: new Date(), requireBackup: true }), /провер|восстанов/i);
  await service.unfreeze();
});