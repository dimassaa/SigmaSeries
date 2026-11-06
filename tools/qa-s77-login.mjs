// QA-вход администратора в демо-базе S-77. Первый запуск снимает текущие
// пароль и 2FA администратора, ставит временные; `--restore` возвращает
// их байт в байт из файла-снимка. Меняются только строки демо-базы
// serial_tracker_demo, приложения не запускает.
import { createPool } from '../src/db/pool.js';
import { hashPassword } from '../src/services/auth/password.js';
import { readFileSync, writeFileSync } from 'node:fs';

const restore = process.argv.includes('--restore');
const pool = createPool();
const SNAPSHOT = '/tmp/opencode/qa-admin-snapshot.json';

if (restore) {
  const { passwordHash, status, twoFactor } = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  await pool.query(
    'UPDATE e_user SET password_hash = $2, status = $3 WHERE id = $1',
    [172600, Buffer.from(passwordHash), status],
  );
  if (twoFactor) {
    await pool.query(
      `INSERT INTO e_two_factor (user_id, secret_enc, enabled_at, last_accepted_step)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET secret_enc = $2, enabled_at = $3, last_accepted_step = $4`,
      [172600, Buffer.from(twoFactor.secret), new Date(twoFactor.enabledAt), Number(twoFactor.lastAcceptedStep)],
    );
    console.log('восстановлено: пароль и 2FA демо-администратора');
  } else {
    console.log('восстановлено: пароль демо-администратора (2FA включена не была)');
  }
} else {
  const { rows: [admin] } = await pool.query(
    'SELECT id, password_hash, status FROM e_user WHERE id = 172600',
  );
  const { rows: [twoFactor] } = await pool.query(
    'SELECT secret_enc, enabled_at, last_accepted_step FROM e_two_factor WHERE user_id = $1',
    [172600],
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
  writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 1));
  await pool.query(
    'UPDATE e_user SET password_hash = $2, status = $3 WHERE id = $1',
    [172600, await hashPassword('QA-запуск-Не-Вручную-2026-S77'), 'active'],
  );
  if (twoFactor) await pool.query('DELETE FROM e_two_factor WHERE user_id = $1', [172600]);
  console.log(`снят: временный пароль на демо-администратора, 2FA отложена; снимок: ${SNAPSHOT}`);
}

await pool.end();
