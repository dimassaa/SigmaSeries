// Режим защиты: заморозить и разморозить каталог (F-12-10).
//
//   npm run import:freeze            # заморозить
//   npm run import:freeze -- status  # только показать состояние
//   npm run import:freeze -- --unfreeze
//
// Кнопка в S-76 не построена: администратора в системе нет (#64). Поэтому
// режим включается из командной строки — а на защите это даже надёжнее, чем
// кнопка, которую можно не нажать.
//
// Копия перед заморозкой обязательна и проверяется восстановлением (OP-17):
// «заморожено» без страховки врёт админу, и обнаружится это уже на защите.

import { createPool } from '../db/pool.js';
import { createFreezeService } from '../services/import/freeze.js';
import { createSnapshotBackup } from '../services/backup/snapshot.js';
import { effectiveMode } from '../services/mail/mode.js';

async function main() {
  const args = process.argv.slice(2);
  const status = args.includes('status');
  const unfreeze = args.includes('--unfreeze');
  const mailDevbox = args.includes('--mail-devbox');
  const skipBackup = args.includes('--no-backup');

  if (!process.env.PGHOST && !process.env.DATABASE_URL) {
    throw new Error('не задано подключение к базе: нужны PGHOST/PGUSER/PGDATABASE или DATABASE_URL');
  }

  const pool = createPool();
  const mailMode = {
    current: () => effectiveMode(pool),
    set: async (mode) => {
      const { rows } = await pool.query(
        `INSERT INTO e_system_setting (key, value) VALUES ('mail.mode', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, changed_at = now() RETURNING value`,
        [mode],
      );
      return { changed: true, mode: rows[0].value, source: 'manual' };
    },
  };
  // Копия подключается здесь же: без неё заморозка проходила «успешно», не
  // создав страховки, и тесты этого не видели — у них была своя заглушка.
  const freeze = createFreezeService({
    pool,
    mailMode,
    backup: () => createSnapshotBackup({ pool }),
  });

  try {
    const state = await freeze.state();
    if (status) {
      console.log(state.frozen
        ? `Режим защиты включён с ${state.since}${state.mailDevbox ? ', почта devbox' : ''}`
        : 'Режим защиты выключен');
      process.exitCode = 0;
      return;
    }

    if (unfreeze) {
      await freeze.unfreeze();
      console.log('Режим защиты снят: импорт и почта возвращены как было');
      process.exitCode = 0;
      return;
    }

    console.log('Заморозка для защиты…');
    if (skipBackup) {
      console.log('  копия пропущена по вашему указанию (--no-backup)');
    } else {
      console.log('  создаю резервную копию и проверяю её восстановлением…');
    }
    const result = await freeze.freeze({ mailDevbox, requireBackup: !skipBackup });

    console.log(`\nКаталог заморожен с ${result.since}`);
    if (result.backup) {
      console.log(`  копия: ${(result.backup.bytes / 1048576).toFixed(0)} МБ, восстановление проверено`);
    }
    console.log(`  импорт выключен, запросы к внешним API прекращены`);
    console.log(`  почта: ${mailDevbox ? 'devbox' : 'без изменений'}`);
    console.log('\nНа защите интернет не нужен: каталог, карточки и календарь читаются из базы.');
    console.log('Отменить: npm run import:freeze -- --unfreeze');
    process.exitCode = 0;
  } catch (error) {
    console.error(`\nЗаморозка не выполнена: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();