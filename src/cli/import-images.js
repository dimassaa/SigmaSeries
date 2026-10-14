// Загрузка картинок для каталога (F-12-05).
//
//   npm run import:images [-- --limit 20]
//
// Загрузка идёт после обогащения: пути к картинкам лежат в сыром слое.
// Каждая картинка — своя транзакция, а сбой одного сериала не уносит
// остальные (§5): постер и фон независимы, и отсутствие фона не должно
// мешать постеру записаться.

import { createPool } from '../db/pool.js';
import {
  downloadImage,
  prepareImage,
  saveImage,
  pickBackdrop,
  posterPathOf,
  LIMITS,
} from '../services/import/images.js';
import { IMPORT_SETTINGS } from '../config/settings.js';

function parseArgs(argv) {
  const args = { limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1]);
  }
  if (!Number.isFinite(args.limit) || args.limit < 0) {
    throw new Error(`--limit должен быть неотрицательным числом, получено «${args.limit}»`);
  }
  return args;
}

/** Сериалы последнего прогона, у которых есть путь к картинке. */
async function targets(pool, limit) {
  const { rows: runs } = await pool.query(
    `SELECT id FROM e_import_run WHERE kind = 'full_run' AND status = 'success' ORDER BY id DESC LIMIT 1`,
  );
  if (!runs.length) return null;

  const { rows } = await pool.query(
    `SELECT r.tconst, r.raw
       FROM e_import_item_result r
       JOIN e_series s ON s.imdb_key = r.tconst
      WHERE r.run_id = $1 AND r.raw IS NOT NULL
        AND r.raw->'tmdb'->>'posterPath' IS NOT NULL
      ORDER BY r.popularity_rank
      ${limit > 0 ? `LIMIT ${Math.floor(limit)}` : ''}`,
    [runs[0].id],
  );
  return { runId: runs[0].id, rows };
}

/** Загружает одну картинку и пишет её. */
async function loadOne(pool, seriesId, role, path) {
  const buffer = await downloadImage(path, {
    maxBytes: LIMITS.maxBytes,
    timeoutMs: LIMITS.timeoutMs,
    attempts: IMPORT_SETTINGS.downloadAttempts,
  });
  const prepared = await prepareImage(buffer, role);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await saveImage({
      client,
      seriesId,
      role,
      source: 'tmdb',
      sourcePath: path,
      prepared,
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const { limit } = parseArgs(process.argv.slice(2));
  if (!process.env.PGHOST && !process.env.DATABASE_URL) {
    throw new Error('не задано подключение к базе: нужны PGHOST/PGUSER/PGDATABASE или DATABASE_URL');
  }

  const pool = createPool();
  try {
    const found = await targets(pool, limit);
    if (!found) {
      console.log('Нет успешного прогона: сначала `npm run import:candidates`');
      process.exitCode = 1;
      return;
    }
    if (!found.rows.length) {
      console.log('Нет сериалов с путями к картинкам: сначала `npm run import:enrich`');
      process.exitCode = 1;
      return;
    }

    const started = Date.now();
    let posters = 0;
    let backdrops = 0;
    let noBackdrop = 0;
    const failed = [];

    // Параллельность ограничена `import.image_concurrency`: это к сетевому
    // каналу и к памяти, а не к серверу базы.
    const queue = [...found.rows];
    const workers = Array.from(
      { length: Math.min(IMPORT_SETTINGS.imageConcurrency, queue.length) },
      async () => {
        for (;;) {
          const row = queue.shift();
          if (!row) return;
          const { rows: ids } = await pool.query('SELECT id FROM e_series WHERE imdb_key = $1', [row.tconst]);
          const seriesId = ids[0]?.id;
          if (!seriesId) continue;

          try {
            const posterPath = row.raw?.tmdb?.posterPath ?? posterPathOf(row.raw?.details);
            if (posterPath) {
              await loadOne(pool, seriesId, 'poster', posterPath);
              posters += 1;
            }
          } catch (error) {
            failed.push(`${row.tconst} постер: ${error.message}`);
          }

          try {
            // Баннер и заставка требуют фона без текста 16:9 (H-34); обычный
            // фон под шапку подходит любой — но он тоже пишется ролью
            // `backdrop`, иначе плашка останется серой.
            const backdrop = pickBackdrop(row.raw?.tmdb?.backdrops);
            if (backdrop) {
              await loadOne(pool, seriesId, 'backdrop', backdrop.file_path);
              backdrops += 1;
            } else {
              noBackdrop += 1;
            }
          } catch (error) {
            failed.push(`${row.tconst} фон: ${error.message}`);
          }
        }
      },
    );
    await Promise.all(workers);

    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`\nЗагружено за ${seconds} с: постеров ${posters}, фонов ${backdrops}, без пригодного фона ${noBackdrop}`);
    if (failed.length) {
      console.log(`не удалось: ${failed.length}`);
      for (const line of failed.slice(0, 5)) console.log(`  ${line}`);
    }

    const totals = await pool.query(
      `SELECT count(*)::int AS images,
              coalesce(sum(iv.bytes), 0)::bigint AS bytes
         FROM e_image i JOIN e_image_variant iv ON iv.image_id = i.id`,
    );
    console.log(`  в базе картинок: ${totals.rows[0].images}, объём вариантов ${Math.round(Number(totals.rows[0].bytes) / 1048576)} МБ`);
    process.exitCode = 0;
  } catch (error) {
    console.error(`\nЗагрузка картинок не удалась: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();