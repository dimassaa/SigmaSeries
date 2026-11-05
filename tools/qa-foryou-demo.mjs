// QA-фикстура для браузерной проверки S-34 /for-you на демо-базе.
// Заводит зрителя qa-foryou с известным паролем и 12 точными отметками
// жанра-лидера; `--clean` снимает отметки и деактивирует аккаунт.
//
// В демо-базе стоит правило no_delete_user (ON DELETE DO INSTEAD NOTHING):
// строки e_user не удаляются, поэтому имеющийся пользователь
// переиспользуется обновлением, а не создаётся заново.

import { createPool } from '../src/db/pool.js';
import { pgAuthStore } from '../src/services/auth/store.js';
import { hashPassword } from '../src/services/auth/password.js';

const clean = process.argv.includes('--clean');
const pool = createPool();

const { rows: [user] } = await pool.query(
  'SELECT id, status FROM e_user WHERE nickname = $1', ['qa-foryou'],
);

if (clean) {
  if (user) {
    await pool.query('DELETE FROM e_watch_mark WHERE user_id = $1', [user.id]);
    await pool.query('DELETE FROM e_reco_dismiss WHERE user_id = $1', [user.id]);
    await pool.query("UPDATE e_user SET status = 'deleted' WHERE id = $1", [user.id]);
    console.log('убрано: отметки и показ «не интересно»; аккаунт переведён в deleted');
  } else {
    console.log('убирать нечего: пользователя qa-foryou нет');
  }
} else {
  const passwordHash = await hashPassword('Смо-трите-Вне-2026-QA');
  const id = user
    ? (await pool.query(
        // Правило no_delete_user запрещает удалять строки e_user, поэтому
        // существующий зритель приводится к нужному виду обновлением.
        `UPDATE e_user SET password_hash = $2, status = 'active', email_confirmed = TRUE,
            timezone = 'Europe/Minsk', locale = 'ru', theme = 'dark' WHERE id = $1 RETURNING id`,
        [user.id, passwordHash],
      )).rows[0].id
    : (await pgAuthStore(pool).createUser({
        email: 'qa-foryou@example.com',
        nickname: 'qa-foryou',
        passwordHash,
        tokenHash: 'qa-token-hash',
        timezone: 'Europe/Minsk',
        locale: 'ru',
        theme: 'dark',
      })).id;

  await pool.query('DELETE FROM e_watch_mark WHERE user_id = $1', [id]);
  await pool.query('DELETE FROM e_reco_dismiss WHERE user_id = $1', [id]);

  // Жанр-лидер: кандидатов рекомендаций в демо-базе хватает, отдельные
  // фикстурные сериалы не нужны.
  const { rows: tops } = await pool.query(
    `SELECT sg.genre_code, count(DISTINCT s.id)::int AS n FROM e_series_genre sg
       JOIN e_series s ON s.id = sg.series_id AND s.publication_state = 'published' AND s.archived_at IS NULL
       JOIN e_genre g ON g.code = sg.genre_code AND g.active AND NOT g.is_raw
      GROUP BY sg.genre_code ORDER BY n DESC LIMIT 3`,
  );
  const genre = tops.find((g) => g.n >= 10) ?? tops[0];

  const { rows: picks } = await pool.query(
    `SELECT s.id, s.slug FROM e_series s
       JOIN e_series_genre sg ON sg.series_id = s.id AND sg.genre_code = $1
     WHERE s.publication_state = 'published' AND s.archived_at IS NULL
       AND EXISTS (SELECT 1 FROM e_season se JOIN e_episode e ON e.season_id = se.id WHERE se.series_id = s.id)
     ORDER BY s.slug LIMIT 8`, [genre.genre_code],
  );

  const { rowCount } = await pool.query(
    `INSERT INTO e_watch_mark (user_id, episode_id, precision)
     SELECT $1, f.episode_id, 'exact' FROM (
       SELECT e.id AS episode_id, row_number() OVER (PARTITION BY s.id ORDER BY e.number) AS rn
         FROM e_series s JOIN e_season se ON se.series_id = s.id AND se.number = 1
         JOIN e_episode e ON e.season_id = se.id WHERE s.id = ANY($2)
     ) f WHERE f.rn <= 3 ON CONFLICT DO NOTHING`, [id, picks.slice(0, 4).map((p) => p.id)],
  );
  console.log(`жанр: ${genre.genre_code} (${genre.n}); зритель id=${id}; точных отметок: ${rowCount}`);
}

await pool.end();
