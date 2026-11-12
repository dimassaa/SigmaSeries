// QA-вход зрителя в демо-базе. Первый запуск снимает текущий пароль зрителя
// и ставит временный; `--restore` возвращает исходный хеш байт в байт.
// Снимок лежит в `.qa/` (IMPROVEMENTS №251): там хеш пароля, в репозиторий
// ему нельзя; в `/tmp` его держать нельзя — среда перезапускается, `/tmp`
// очищается, и откат становился невозможен.
import { createPool } from '../src/db/pool.js';
import { hashPassword } from '../src/services/auth/password.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWER_ID = 172599;
const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.qa', 'qa-viewer-snapshot.json');
const pool = createPool();

if (process.argv.includes('--restore')) {
  const { passwordHash } = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  await pool.query('UPDATE e_user SET password_hash = $2 WHERE id = $1', [VIEWER_ID, Buffer.from(passwordHash)]);
  console.log('восстановлено: исходный пароль демо-зрителя');
} else {
  const { rows: [viewer] } = await pool.query('SELECT password_hash FROM e_user WHERE id = $1', [VIEWER_ID]);
  mkdirSync(dirname(SNAPSHOT), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify({ passwordHash: viewer.password_hash.toString('base64') }, null, 1));
  await pool.query(
    'UPDATE e_user SET password_hash = $2 WHERE id = $1',
    [VIEWER_ID, await hashPassword('QA-зритель-Не-Вручную-2026')],
  );
  console.log(`снят: временный пароль на демо-зрителя; снимок: ${SNAPSHOT}`);
}
await pool.end();
