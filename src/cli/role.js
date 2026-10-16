// Служебные роли: выдать и снять (M9 §5, R-SEC-04).
//
//   npm run role -- grant admin user@example.com --reason "защита"
//   npm run role -- grant analyst user@example.com --days 7 --reason "аналитика за декабрь"
//   npm run role -- revoke analyst user@example.com --reason "срок вышел"
//   npm run role -- list user@example.com
//
// Зачем это отдельной командой. Экраны служебных ролей (S-50…S-53, S-70…S-84)
// начинаются с человека, у которого роль есть, а роли выдавать было нечем:
// таблица `e_role_assignment` читалась, но не заполнялась никем. Пока команды
// нет, двадцать экранов нельзя ни открыть, ни показать на защите (#64).
//
// Правила не выдуманы: роль без причины не выдаётся, служебная роль без срока
// не создаётся (иначе временная выдача навсегда остаётся), а всё, что команда
// сделала, попадает в `e_audit_log` — журнал, который иначе остаётся пустым.

import { createPool } from '../db/pool.js';
import { pgAuthStore } from '../services/auth/store.js';
import { pgAuditLog } from '../services/audit/log.js';
import { STAFF_ROLES } from '../config/settings.js';

const USAGE = `Использование:
  npm run role -- grant  <роль> <email> --reason "причина" [--days N]
  npm run role -- revoke <роль> <email> --reason "причина"
  npm run role -- list   <email>

Роли: ${STAFF_ROLES.join(', ')}`;

async function main() {
  const args = process.argv.slice(2);
  const [command, role, email] = args;
  const reason = valueOf(args, '--reason');
  const days = Number(valueOf(args, '--days'));

  if (!process.env.PGHOST && !process.env.DATABASE_URL) {
    throw new Error('не задано подключение к базе: нужны PGHOST/PGUSER/PGDATABASE или DATABASE_URL');
  }
  if (!command || command === 'help') {
    console.log(USAGE);
    return;
  }

  const pool = createPool();
  const auth = pgAuthStore(pool);
  const audit = pgAuditLog(pool);

  try {
    if (!email) throw new Error('нужен адрес аккаунта');
    const user = await auth.byEmail(email);
    if (!user) throw new Error(`аккаунт ${email} не найден`);

    if (command === 'list') {
      const roles = await auth.roles(user.id);
      console.log(roles.length ? `роли: ${roles.join(', ')}` : 'служебных ролей нет');
      return;
    }

    if (!STAFF_ROLES.includes(role)) throw new Error(`роль должна быть одной из: ${STAFF_ROLES.join(', ')}`);
    if (!reason) throw new Error('нужна причина: --reason "…", она попадёт в журнал аудита');

    if (command === 'grant') {
      const expiresAt = role === 'admin'
        ? (Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86_400_000) : null)
        : (Number.isFinite(days) && days > 0
          ? new Date(Date.now() + days * 86_400_000)
          : new Date(Date.now() + 30 * 86_400_000));

      const result = await auth.assignRole({
        userId: user.id, role, expiresAt, grantedBy: null, reason,
      });
      if (!result.ok) {
        console.error(`роль не выдана: ${describe(result.reason)}`);
        await audit.write({
          actorId: null,
          action: 'role_grant',
          objectType: 'user',
          objectId: user.id,
          result: 'denied',
          reason,
          after: { role },
        });
        process.exitCode = 1;
        return;
      }

      await audit.write({
        actorId: null,
        action: 'role_grant',
        objectType: 'user',
        objectId: user.id,
        result: 'ok',
        reason,
        after: { role, expires_at: expiresAt },
      });
      console.log(`роль ${role} выдана: ${email}`
        + (expiresAt ? ` до ${expiresAt.toISOString().slice(0, 10)}` : ' бессрочно'));
      console.log('вход в служебный раздел — по второму фактору (R-SEC-04)');
      return;
    }

    if (command === 'revoke') {
      const result = await auth.revokeRole({ userId: user.id, role });
      await audit.write({
        actorId: null,
        action: 'role_revoke',
        objectType: 'user',
        objectId: user.id,
        result: result.removed ? 'ok' : 'denied',
        reason,
        after: { role, removed: result.removed },
      });
      console.log(result.removed
        ? `роль ${role} снята: ${email}`
        : `у ${email} нет роли ${role}`);
      return;
    }

    throw new Error(`неизвестная команда: ${command}\n\n${USAGE}`);
  } finally {
    await pool.end();
  }
}

const valueOf = (args, flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
};

const describe = (reason) => ({
  'unknown-role': 'роль неизвестна',
  'no-reason': 'не указана причина',
  'no-expiry': 'роль без срока запрещена',
  'not-admin': 'выдаёт не администратор',
}[reason] ?? reason);

try {
  await main();
} catch (error) {
  // Сообщение пользователю, а не стек: команда запускается руками с защиты,
  // и трассировка стека там только мешает.
  console.error(`\n${error.message}\n`);
  process.exitCode = 1;
}