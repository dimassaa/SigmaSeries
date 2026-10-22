// Демо-население для аналитики (M8, R-AN-11).
//
// Демо-данные генерируются и всегда помечены: демо и реальные не
// смешиваются ни в одной метрике, а фильтр «исключить демо» включён по
// умолчанию. Демо-аккаунты — свои и тоже помеченные: демо-активность,
// приписанная живому человеку, врёт вдвойне.
//
// Запуск: `npm run analytics:demo`. Повторный запуск чистит прежние
// демо-данные, чтобы не удваивать их.

import crypto from 'node:crypto';

import { createPool } from '../db/pool.js';
import { pgAuthStore } from '../services/auth/store.js';
import { hashPassword, makeToken } from '../services/auth/password.js';
import { ACTIVE_EVENTS } from '../services/analytics/taxonomy.js';

/** Сколько демо-людей заводим. */
const DEMO_USERS = 40;

/**
 * Демо-аккаунты: заводим или берём уже заведённые.
 *
 * @param {import('pg').Pool} pool
 * @param {number} count
 * @returns {Promise<number[]>} идентификаторы аккаунтов
 */
export async function demoAccounts(pool, count = DEMO_USERS) {
  const auth = pgAuthStore(pool);
  const passwordHash = await hashPassword('демо-пароль-из-десяти');
  const accounts = [];

  for (let i = 1; i <= count; i += 1) {
    const nickname = `demo-${i}`;
    const { rows } = await pool.query(
      'SELECT id FROM e_user WHERE nickname = $1 AND is_demo',
      [nickname],
    );
    if (rows.length) {
      accounts.push(Number(rows[0].id));
      continue;
    }
    const { hash } = makeToken();
    const created = await auth.createUser({
      email: `${nickname}@example.invalid`,
      nickname,
      passwordHash,
      tokenHash: hash,
      timezone: 'Europe/Minsk',
      locale: 'ru',
      theme: 'dark',
      confirmed: true,
    });
    await pool.query(
      `UPDATE e_user SET is_demo = TRUE, email_confirmed = TRUE,
              registered_at = now() - interval '30 days'
        WHERE id = $1`,
      [created.id],
    );
    accounts.push(Number(created.id));
  }
  return accounts;
}

/**
 * Готовит демо-данные: аккаунты, события и оценки.
 *
 * @param {import('pg').Pool} pool
 * @param {{days?: number, users?: number}} [options]
 * @returns {Promise<{events: number, ratings: number, accounts: number}>}
 */
export async function seedDemo(pool, { days = 30, users = DEMO_USERS } = {}) {
  // Прежние демо-данные убираются: повторный запуск не должен удваивать их.
  await pool.query('DELETE FROM e_event WHERE is_demo');
  await pool.query('DELETE FROM e_rating WHERE is_demo');

  const accounts = await demoAccounts(pool, users);
  if (!accounts.length) return { events: 0, ratings: 0, accounts: 0 };

  const { rows: episodes } = await pool.query(
    `SELECT e.id FROM e_episode e
       JOIN e_season sn ON sn.id = e.season_id
       JOIN e_series s ON s.id = sn.series_id
      WHERE s.publication_state = 'published'
      ORDER BY e.id
      LIMIT 400`,
  );
  const episodeIds = episodes.map((row) => Number(row.id));

  const names = [...ACTIVE_EVENTS, 'search_submit', 'notification_open', 'reco_impression'];
  let events = 0;

  for (const [index, accountId] of accounts.entries()) {
    const pseudo = `demo_${accountId}`;
    const own = episodeIds.filter((unused, i) => (i + index) % 7 === 0).slice(0, 25);
    for (const episodeId of own) {
      await pool.query(
        `INSERT INTO e_watch_mark (user_id, episode_id, marked_at, precision)
         VALUES ($1, $2, now() - ($3 || ' days')::interval, 'exact')
         ON CONFLICT DO NOTHING`,
        [accountId, episodeId, String(index % 28)],
      );
    }
    for (let day = days; day >= 0; day -= 1) {
      const perDay = 3 + Math.round((days - day) / 2) + (index % 5);
      for (let i = 0; i < perDay; i += 1) {
        const name = names[(day * 7 + i + index) % names.length];
        await pool.query(
          `INSERT INTO e_event (event_id, name, ts_server, anon_id, user_pseudo_id, props, is_demo)
           VALUES ($1, $2, now() - ($3 || ' days')::interval - ($4 || ' minutes')::interval,
                   $5, $6, $7, TRUE)`,
          [
            crypto.randomUUID(),
            name,
            String(day),
            String((i * 37) % 1440),
            `demo_anon_${accountId}`,
            pseudo,
            JSON.stringify({ page_type: 'home', length: '9', results: '3' }),
          ],
        );
        events += 1;
      }
    }
  }

  const { rows: series } = await pool.query(
    `SELECT id FROM e_series WHERE publication_state = 'published' ORDER BY id LIMIT 200`,
  );
  let ratings = 0;
  for (const accountId of accounts) {
    for (const row of series.slice(0, 10)) {
      const { rowCount } = await pool.query(
        `INSERT INTO e_rating (user_id, object_type, series_id, value, is_demo)
         VALUES ($1, 'series', $2, $3, TRUE)
         ON CONFLICT DO NOTHING`,
        [accountId, row.id, 4 + ((accountId + row.id) % 7)],
      );
      ratings += rowCount ?? 0;
    }
  }

  return { events, ratings, accounts: accounts.length };
}

if (process.argv[1] && process.argv[1].endsWith('analytics-demo.js')) {
  const pool = createPool();
  const result = await seedDemo(pool);
  console.log(`Демо-данные готовы: аккаунтов ${result.accounts}, событий ${result.events}, оценок ${result.ratings}.`);
  await pool.end();
}
