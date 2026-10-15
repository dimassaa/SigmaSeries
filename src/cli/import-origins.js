// Дозагрузка стран и сетей (F-12-03 §4(4)).
//
//   npm run import:origins -- --limit 100
//   npm run import:origins -- --all
//   npm run import:origins -- --tconst tt1234567
//
// Команда ходит по каталогу и доставляет то, чего в нём нет: страну
// производства и сети. Логика — в `src/services/import/origins.js`, здесь
// только разбор аргументов и отчёт.

import { createPool } from '../db/pool.js';
import { createTmdbClient } from '../services/import/tmdb.js';
import { fillOrigins, parseArgs } from '../services/import/origins.js';
import { assertNotFrozen } from '../services/import/freeze.js';
import { IMPORT_SETTINGS } from '../config/settings.js';

async function main() {
  const { limit, tconst } = parseArgs(process.argv.slice(2));
  if (!process.env.PGHOST && !process.env.DATABASE_URL) {
    throw new Error('не задано подключение к базе: нужны PGHOST/PGUSER/PGDATABASE или DATABASE_URL');
  }
  if (!process.env.TMDB_TOKEN) {
    throw new Error('не задан TMDB_TOKEN: без ключа страны не взять');
  }

  const pool = createPool();
  try {
    await assertNotFrozen(pool);

    const tmdb = createTmdbClient({ token: process.env.TMDB_TOKEN });
    let lastReport = 0;
    const started = Date.now();
    const result = await fillOrigins({
      pool,
      tmdb,
      limit,
      tconst,
      log: (line) => console.error(`  ${line}`),
      onProgress: (done, total) => {
        // Отчёт раз в сотню: пересчитывать время на каждом сериале незачем,
        // а молчать минуту тоже нельзя — человек решит, что команда зависла.
        if (done - lastReport < 100 && done !== total) return;
        lastReport = done;
        const seconds = Math.round((Date.now() - started) / 1000);
        console.log(`  ${done} из ${total} за ${seconds} с (${IMPORT_SETTINGS.rps} запросов в секунду)`);
      },
    });

    console.log(`\nЗалито: ${result.filled} из ${result.scanned}`
      + `; без страны у источника: ${result.withoutCountry}; ошибок: ${result.errors}`);
    process.exitCode = result.errors ? 1 : 0;
  } catch (error) {
    console.error(`\nДозагрузка не удалась: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();
