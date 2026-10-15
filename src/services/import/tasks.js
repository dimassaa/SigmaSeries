// Ночные задачи планировщика (F-12-07 §4).
//
// Здесь только связывание: какая функция отвечает за вид запуска. Сами задачи
// живут в своих модулях и проверяются отдельно — иначе проверка планировщика
// проверяла бы не то.
//
// `full_run` в реестре нет намеренно: он запускается по кнопке (S-76, F-12-08)
// и по расписанию не ходит. `backup` появится вместе с M9 (ADR-004): порядок
// «резервная копия → расписание» задан в `TASK_ORDER` заранее.

import path from 'node:path';

import { ensureDataset } from './datasets.js';
import { discoverSync } from './discover-sync.js';
import { refreshRatings } from './ratings.js';
import { scheduleSync } from './schedule-sync.js';
import { loadSlugs } from './write.js';
import { IMPORT_SETTINGS } from '../../config/settings.js';

/** Каталог с датасетами IMDb: то же место, что и у команд импорта. */
export const DATA_DIR = process.env.IMDB_DATA_DIR ?? path.resolve('data/imdb');

/**
 * Реестр задач для `createScheduler`.
 *
 * @param {object} deps
 * @param {object} deps.pool
 * @param {object} deps.store
 * @param {object} deps.tmdb клиент TMDB; без ключа задачи обзора упадут сами
 * @param {string} [deps.dataDir] каталог с датасетами IMDb
 * @param {(line: string) => void} [deps.log]
 * @returns {Record<string, Function>}
 */
export function createImportTasks({ pool, store, tmdb, dataDir = DATA_DIR, log = () => {} }) {
  return {
    schedule_sync: async ({ runId, dryRun, now }) => scheduleSync({
      pool, store, tmdb, runId, dryRun, now, slugs: await loadSlugs(pool), log,
    }),

    // Сухого прогона у обзора нет: добавление новинок пишет в каталог всегда,
    // а «посмотреть, что нашлось бы» — это `npm run import:discover`.
    discover_sync: async ({ runId, now }) => discoverSync({
      pool, store, tmdb, runId, now, slugs: await loadSlugs(pool), log,
    }),

    // Датасет качается здесь же, а не «когда-нибудь раньше»: недельная задача
    // без файла должна стать ошибкой прогона, а не тишиной.
    ratings_sync: async ({ now }) => {
      const file = await ensureDataset({
        key: 'ratings',
        dir: dataDir,
        maxBytes: IMPORT_SETTINGS.downloadMaxMb * 1024 * 1024,
        timeoutMs: IMPORT_SETTINGS.downloadTimeoutMs,
        attempts: IMPORT_SETTINGS.downloadAttempts,
        freshDays: IMPORT_SETTINGS.downloadFreshDays,
      });
      const result = await refreshRatings({ pool, path: file.path, now });
      log(`[рейтинги] файл ${file.reused ? 'свежий' : 'скачан'}: `
        + `обновлено ${result.updated} из ${result.matched} позиций каталога`);
      return { status: 'success', items: result.updated, errors: 0, reason: null };
    },
  };
}