// QA-вход администратора в демо-базе S-77. Первый запуск снимает текущие
// пароль и 2FA администратора, ставит временные; `--restore` возвращает
// их байт в байт из файла-снимка. Меняются только строки демо-базы
// serial_tracker_demo, приложения не запускает.
//
// Снимок лежит в `.qa/` рядом с проектом, а не в системном temp: между
// QA-этапами среда перезапускалась, `/tmp` очищался, и откат становился
// невозможен (IMPROVEMENTS №251). Каталог в `.gitignore`: в снимке лежат хеш
// пароля и секрет 2FA, в репозиторий им нельзя.
import { createPool } from '../src/db/pool.js';
import { hashPassword } from '../src/services/auth/password.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const restore = process.argv.includes('--restore');
const pool = createPool();
const SNAPSHOT = join(
  dirname(fileURLToPath(import.meta.url)), '..', '.qa', 'qa-admin-snapshot.json',
);
const ADMIN_ID = 172600;

if (restore) {
  const { passwordHash, status, twoFactor } = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  await pool.query(
    'UPDATE e_user SET password_hash = $2, status = $3 WHERE id = $1',
    [ADMIN_ID, Buffer.from(passwordHash), status],
  );
  if (twoFactor) {
    await pool.query(
      `INSERT INTO e_two_factor (user_id, secret_enc, enabled_at, last_accepted_step)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET secret_enc = $2, enabled_at = $3, last_accepted_step = $4`,
      [ADMIN_ID, Buffer.from(twoFactor.secret), new Date(twoFactor.enabledAt), Number(twoFactor.lastAcceptedStep)],
    );
    console.log('восстановлено: пароль и 2FA демо-администратора');
  } else {
    // 2FA включили во время QA (№258): «как было» — это выключенная проверка,
    // поэтому удаляются и секрет, и резервные коды. Без этого демо-админ
    // остаётся за вторым фактором, а снимка для входа у следующей сессии нет.
    await pool.query('DELETE FROM e_two_factor_code WHERE user_id = $1', [ADMIN_ID]);
    await pool.query('DELETE FROM e_two_factor WHERE user_id = $1', [ADMIN_ID]);
    console.log('восстановлено: пароль демо-администратора, 2FA удалена (при снимке её не было)');
  }
} else {
  const { rows: [admin] } = await pool.query(
    'SELECT id, password_hash, status FROM e_user WHERE id = $1',
    [ADMIN_ID],
  );
  const { rows: [twoFactor] } = await pool.query(
    'SELECT secret_enc, enabled_at, last_accepted_step FROM e_two_factor WHERE user_id = $1',
    [ADMIN_ID],
  );
  const snapshot = {
    passwordHash: admin.password_hash.toString('base64'),
    status: admin.status,
    twoFactor: twoFactor ? {
      secret: Buffer.from(twoFactor.secret_enc).toString('base64'),
      enabledAt: twoFactor.enabled_at,
      lastAcceptedStep: String(twoFactor.last_accepted_step),
    } : null,
  };
  mkdirSync(dirname(SNAPSHOT), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 1));
  await pool.query(
    'UPDATE e_user SET password_hash = $2, status = $3 WHERE id = $1',
    [ADMIN_ID, await hashPassword('QA-запуск-Не-Вручную-2026-S77'), 'active'],
  );
  if (twoFactor) await pool.query('DELETE FROM e_two_factor WHERE user_id = $1', [ADMIN_ID]);
  console.log(`снят: временный пароль на демо-администратора, 2FA отложена; снимок: ${SNAPSHOT}`);
}

await pool.end();
