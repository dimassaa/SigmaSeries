// Демо-население для аналитики (M8).
//
// Без трафика на защите дашборды пусты, а пустой дашборд интерфейс не
// показывает. Поэтому демо-данные генерируются и всегда помечены
// (R-AN-11): демо и реальные не смешиваются ни в одной метрике, а фильтр
// «исключить демо» включён по умолчанию.
//
// Запуск: `npm run analytics:demo`. Данные помечены `is_demo`, поэтому
// удаляются одним запросом.
//
// События пишутся напрямую в таблицу, а не через приёмник: демо не
// проходит проверку одноразового токена — у него нет сессии.

import crypto from 'node:crypto';

import { createPool } from '../db/pool.js';
import { ACTIVE_EVENTS } from '../services/analytics/taxonomy.js';

/** Сколько дней назад брать событие. */
const DAYS = 30;

/**
 * Готовит демо-данные.
 *
 * @param {import('pg').Pool} pool
 * @param {{days?: number, users?: number}} [options]
 * @returns {Promise<{events: number, ratings: number}>}
 */
export async function seedDemo(pool, { days = DAYS, users = 40 } = {}) {
  // Прежние демо-данные убираются: повторный запуск не должен удваивать их.
  await pool.query('DELETE FROM e_event WHERE is_demo');
  await pool.query('DELETE FROM e_rating WHERE is_demo');

  // Демо-аккаунты — свои и помеченные: синтетика не должна выглядеть как
  // живые люди (R-AN-11). Настоящие аккаунты демо не трогает.
  const accounts = [];
  for (let i = 0; i < users; i += 1) {
    const nickname = `demo-${i + 1}`;
    const { rows } = await pool.query(
      `INSERT INTO e_user (email_hash, email_blind_idx, email_enc, password_hash, nickname,
                           is_demo, email_confirmed, status)
       VALUES (NULL, NULL, NULL, 'demo', $1, TRUE, TRUE, 'active')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [nickname],
    );
    if (rows.length) {
      accounts.push({ id: Number(rows[0].id) });
      continue;
    }
    const existing = await pool.query(
      'SELECT id FROM e_user WHERE nickname = $1 AND is_demo',
      [nickname],
    );
    if (existing.rows.length) accounts.push({ id: Number(existing.rows[0].id) });
  }
  if (!accounts.length) return { events: 0, ratings: 0 };

  const names = [
    'page_view', 'status_set', 'episode_mark', 'rating_set', 'material_submit',
    'banner_click', 'reco_click', 'search_submit', 'signup_complete', 'web_vitals',
  ];

  const values = [];
  let events = 0;
  let ratings = 0;

  for (const [index, account] of accounts.entries()) {
    const pseudo = `demo_${account.id}`;
    for (let day = days; day >= 0; day -= 1) {
      // Событий в день тем больше, чем ближе день к сегодняшнему: трафик
      // растёт, и графики это показывают.
      const perDay = 3 + Math.round((days - day) / 2) + (index % 5);
      for (let i = 0; i < perDay; i += 1) {
        const name = names[(day * 7 + i + index) % names.length];
        values.push({
          eventId: crypto.randomUUID(),
          name,
          day,
          minute: (i * 37) % 1440,
          anonId: `demo_anon_${account.id}`,
          pseudo,
          props: JSON.stringify({ page_type: 'home', precision: 'exact', length: '9', results: '3' }),
        });
        events += 1;
      }
    }
  }

  if (values.length) {
    await pool.query(
      `INSERT INTO e_event (event_id, name, ts_server, anon_id, user_pseudo_id, props, is_demo)
       SELECT t.event_id, t.name,
              now() - (t.day || ' days')::interval - (t.minute || ' minutes')::interval,
              t.anon_id, t.pseudo, t.props, TRUE
         FROM unnest(
           $1::uuid[], $2::text[], $3::int[], $4::int[], $5::text[], $6::text[], $7::jsonb[]
         ) AS t(event_id, name, day, minute, anon_id, pseudo, props)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        values.map((row) => row.eventId),
        values.map((row) => row.name),
        values.map((row) => row.day),
        values.map((row) => row.minute),
        values.map((row) => row.anonId),
        values.map((row) => row.pseudo),
        values.map((row) => row.props),
      ],
    );
  }

  // Оценки — тоже демо: без них метрика «оценок на человека» пуста.
  const { rows: series } = await pool.query(
    `SELECT id FROM e_series WHERE publication_state = 'published' AND archived_at IS NULL LIMIT 200`,
  );
  if (series.length) {
    for (const account of accounts) {
      for (const row of series.slice(0, 10)) {
        const { rowCount } = await pool.query(
          `INSERT INTO e_rating (user_id, object_type, series_id, value, is_demo)
           VALUES ($1, 'series', $2, $3, TRUE)
           ON CONFLICT DO NOTHING`,
          [account.id, row.id, 4 + ((account.id + row.id) % 7)],
        );
        ratings += rowCount ?? 0;
      }
    }
  }

  return { events, ratings };
}

if (process.argv[1] && process.argv[1].endsWith('analytics-demo.js')) {
  const pool = createPool();
  const result = await seedDemo(pool);
  console.log(`Демо-данные готовы: событий ${result.events}, оценок ${result.ratings}.`);
  await pool.end();
}
