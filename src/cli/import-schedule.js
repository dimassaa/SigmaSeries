// Ночная синхронизация расписания: сырой слой → каталог (F-12-07).
//
//   npm run import:schedule [-- --limit 50] [-- --tconst tt1234567] [-- --dry-run]
//
// Запусков два вида, и оба законны:
//
//   • планировщик в приложении — он вызывает ту же службу, а не эту команду;
//   • человек руками — когда нужно обновить расписание сейчас, не дожидаясь
//     ночи, или посмотреть, что изменилось бы (сухой прогон).
//
// Проверка режима защиты стоит внутри `try`: иначе сообщение о заморозке
// тонуло бы в стеке вызовов, а оператору нужно ровно сообщение (F-12-10).

import { createPool } from '../db/pool.js';
import { createTmdbClient } from '../services/import/tmdb.js';
import { createImportStore } from '../services/import/store.js';
import { assertNotFrozen } from '../services/import/freeze.js';
import { loadActiveSeries, scheduleSync } from '../services/import/schedule-sync.js';
import { loadSlugs } from '../services/import/write.js';

function parseArgs(argv) {
  const args = { limit: 0, tconst: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1]);
    if (argv[i] === '--tconst') args.tconst = String(argv[i + 1] ?? '');
    if (argv[i] === '--dry-run') args.dryRun = true;
  }
  if (!Number.isFinite(args.limit) || args.limit < 0) {
    throw new Error(`--limit должен быть неотрицательным числом, получено «${args.limit}»`);
  }
  if (args.tconst !== null && !/^tt\d{5,}$/.test(args.tconst)) {
    throw new Error(`--tconst должен быть идентификатором IMDb вида tt1234567, получено «${args.tconst}»`);
  }
  return args;
}

/** Человекочитаемые названия событий расписания. */
const CHANGE_TITLES = {
  postponed: 'перенесено на более позднее',
  advanced: 'перенесено на более раннее',
  announced: 'объявлена новая серия',
  state_changed: 'изменилось состояние выхода',
};

/**
 * Печатает сводку изменений: сколько чего и по одному примеру на вид.
 *
 * Полный список в терминал не годится — за ночь его набирается сотни строк, а
 * важно в них только «что изменилось» и «где смотреть».
 *
 * @param {object[]} changes
 */
function printChanges(changes) {
  if (!changes.length) {
    console.log('  изменений нет');
    return;
  }

  const byCode = new Map();
  for (const change of changes) {
    const group = byCode.get(change.code) ?? [];
    group.push(change);
    byCode.set(change.code, group);
  }

  for (const [code, group] of [...byCode].sort((a, b) => b[1].length - a[1].length)) {
    const title = CHANGE_TITLES[code] ?? code;
    const example = group.find((change) => change.to) ?? group[0];
    const where = example.season && example.episode ? ` (с${example.season}э${example.episode})` : '';
    const from = example.from ? ` было ${example.from}` : '';
    const to = example.to ? ` стало ${example.to}` : '';
    console.log(`  ${title}: ${group.length} — ${example.tconst}${where}${from}${to}`);
  }
}

async function main() {
  const { limit, tconst, dryRun } = parseArgs(process.argv.slice(2));
  if (!process.env.PGHOST && !process.env.DATABASE_URL) {
    throw new Error('не задано подключение к базе: нужны PGHOST/PGUSER/PGDATABASE или DATABASE_URL');
  }
  if (!process.env.TMDB_TOKEN) {
    throw new Error('не задан TMDB_TOKEN: без ключа расписание не обновить');
  }

  const pool = createPool();
  const store = createImportStore(pool);
  let runId;

  try {
    await assertNotFrozen(pool);

    let targets = null;
    if (tconst) {
      const active = await loadActiveSeries(pool);
      targets = active.filter((row) => row.tconst === tconst);
      if (!targets.length) {
        console.log(`${tconst}: сериал завершён, отменён или не найден — расписание ему не нужно`);
        process.exitCode = 0;
        return;
      }
    }

    const list = targets ?? await loadActiveSeries(pool, { limit: limit || null });
    if (!list.length) {
      console.log('Обновлять нечего: активных сериалов нет');
      process.exitCode = 0;
      return;
    }

    runId = await store.startRun('schedule_sync', { dryRun });
    const tmdb = createTmdbClient({ token: process.env.TMDB_TOKEN });
    const slugs = await loadSlugs(pool);

    console.log(`Синхронизация расписания: ${list.length} сериал(ов)`
      + `${dryRun ? ', сухой прогон' : ''}…`);
    const started = Date.now();
    const result = await scheduleSync({
      pool, store, tmdb, runId, slugs, targets,
      dryRun,
      log: (line) => console.error(`  ${line}`),
    });

    await store.finishRun(runId, result.status);
    console.log(`\nПрогон #${runId}: обновлено ${result.items} за `
      + `${Math.round((Date.now() - started) / 1000)} с, ошибок ${result.errors}`);
    printChanges(result.changes);

    process.exitCode = result.status === 'success' ? 0 : 1;
  } catch (error) {
    if (runId) await store.finishRun(runId, 'error').catch(() => {});
    console.error(`\nСинхронизация расписания не удалась: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();
