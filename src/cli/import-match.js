// Сопоставление кандидатов с TMDB: взять отобранное, найти пары, записать
// исход (F-12-02).
//
//   npm run import:match [-- --limit 50]
//
// Кандидаты берутся из последнего начатого прогона отбора, а не читаются
// заново из датасета: сопоставление идёт по одной позиции, и повторное
// чтение 226 МБ ради тысячи строк было бы лишним. Ключ TMDB обязателен —
// без него сопоставление невозможно, и это лучше сказать сразу, чем после
// тысячи строк «не найдено».
//
// Прогон, оборванный сбоем, продолжается с места: новый прогон не заводится,
// а перебираются только те позиции, что не дошли до своей стадии или упали
// (F-12-09, №95).

import { createPool } from '../db/pool.js';
import { createTmdbClient, isKeyRejected } from '../services/import/tmdb.js';
import { matchCandidates } from '../services/import/match.js';
import { createImportStore } from '../services/import/store.js';
import { assertNotFrozen } from '../services/import/freeze.js';
import { notifyAdmins } from '../services/import/notify.js';

function parseArgs(argv) {
  const args = { limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1]);
  }
  return args;
}

async function main() {
  const { limit } = parseArgs(process.argv.slice(2));
  if (!process.env.PGHOST && !process.env.DATABASE_URL) {
    throw new Error('не задано подключение к базе: нужны PGHOST/PGUSER/PGDATABASE или DATABASE_URL');
  }
  if (!process.env.TMDB_TOKEN) {
    throw new Error('не задан TMDB_TOKEN: без ключа сопоставление невозможно');
  }

  const pool = createPool();
  const store = createImportStore(pool);
  // Номер прогона нужен вне блока try: при сбое прогон надо закрыть и
  // сообщить администратору, а он известен только после выбора прогона.
  let runId = null;

  try {
  await assertNotFrozen(pool);
    const pending = await store.pendingCandidates({ limit });
    if (!pending) {
      console.log('Нет ни одного прогона отбора: сначала `npm run import:candidates`');
      process.exitCode = 1;
      return;
    }
    if (!pending.items.length) {
      console.log('Все кандидаты уже сопоставлены');
      process.exitCode = 0;
      return;
    }

    runId = pending.runId;

    // Продолжение: прогон, который вчера оборвался, продолжается с места.
    if (pending.status !== 'success') {
      await store.resumeRun(pending.runId);
      console.log(`Прогон #${pending.runId} продолжается после обрыва.`);
    }

    const tmdb = createTmdbClient({ token: process.env.TMDB_TOKEN });
    const started = Date.now();
    console.log(`Прогон #${pending.runId}: сопоставляю ${pending.items.length} позиций…`);


    const results = await matchCandidates({
      items: pending.items.map((row) => ({ tconst: row.tconst, startYear: row.start_year })),
      tmdb,
    });

    const ranks = new Map(pending.items.map((row) => [row.tconst, row.popularity_rank]));
    await store.saveItems(pending.runId, results.map((r) => ({
      tconst: r.tconst,
      tmdbId: r.tmdbId,
      stage: 'matched',
      outcome: r.outcome,
      reasons: r.reasons,
      rank: ranks.get(r.tconst) ?? null,
    })));

    const tally = new Map();
    for (const r of results) tally.set(r.outcome, (tally.get(r.outcome) ?? 0) + 1);
    const seconds = Math.round((Date.now() - started) / 1000);
    // Счётчики и контрольная точка пишутся рядом со статусом: по отчёту должно
    // быть видно, сколько позиций дошло до конца и где прогон остановился
    // (F-12-09, №68, №102). Считаются они по всему прогону, а не по текущей
    // попытке: прогон мог быть продолжен после обрыва, и отчёт обязан показать
    // весь объём работы.
    const progress = await store.progress(pending.runId);
    const counters = {
      matched: progress.counts.ok ?? 0,
      no_tmdb: progress.counts.no_tmdb ?? 0,
      pair_doubt: progress.counts.pair_doubt ?? 0,
      error: progress.failed,
      total: progress.total,
      seconds,
    };
    const checkpoint = { stage: 'matched', processed: progress.total, planned: progress.total };
    if (tmdb.breakerTripped) {
      await store.finishRun(pending.runId, 'partial', { counters, checkpoint });
      console.log(`\nПрогон #${pending.runId} частичный: размыкатель открыт после ${tmdb.breakerPauses} пауз`);
      // Источник перестал отвечать: администратор должен узнать об этом без
      // запроса в консоль (F-12-09 §17, №94).
      await notifyAdmins({
        pool,
        kind: 'import_partial',
        params: {
          runId: pending.runId,
          done: progress.done,
          total: progress.total,
        },
        dedupKey: `import-partial:${pending.runId}`,
      });
    } else {
      await store.finishRun(pending.runId, 'success', { counters, checkpoint });
    }
    console.log(`Готово за ${seconds} с:`);
    for (const [outcome, count] of [...tally].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${outcome}: ${count}`);
    }

    const doubtful = results.filter((r) => r.outcome === 'pair_doubt');
    if (doubtful.length) {
      console.log(`\nСомнительные пары, первые десять из ${doubtful.length}:`);
      for (const r of doubtful.slice(0, 10)) console.log(`  ${r.tconst} — ${r.reasons.join(', ')}`);
    }
    const failed = results.filter((r) => r.outcome === 'error');
    if (failed.length) {
      console.log(`\nОшибки API, первые пять из ${failed.length}:`);
      for (const r of failed.slice(0, 5)) console.log(`  ${r.tconst} — ${r.reasons.join(', ')}`);
    }
    process.exitCode = 0;
  } catch (error) {
    console.error(`\nСопоставление не удалось: ${error.message}`);
    process.exitCode = 1;
    // Прогон закрывается ошибкой: иначе он навсегда остался бы «идущим», и
    // отчёт показывал бы незавершённый прогон (F-12-09 §3).
    if (runId) await store.finishRun(runId, 'error').catch(() => {});
    // 401 — ключ отклонили: без уведомления администратор узнал бы об этом
    // только из журнала процесса, которого к тому времени уже нет (§17, №94).
    if (isKeyRejected(error) && runId) {
      await notifyAdmins({
        pool,
        kind: 'import_key_rejected',
        // В параметры — только числа: текст собирается при чтении на языке
        // читателя (R-I18N-14), и русская причина из журнала туда попасть не
        // должна.
        params: { runId },
        dedupKey: `import-key-rejected:${runId}`,
      }).catch(() => {});
    }
  } finally {
    await pool.end();
  }
}

await main();