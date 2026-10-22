// Ночные задачи планировщика (F-12-07 §4).
//
// Здесь только связывание: какая функция отвечает за вид запуска. Сами задачи
// живут в своих модулях и проверяются отдельно — иначе проверка планировщика
// проверяла бы не то.
//
// `full_run` не ходит по расписанию: его заводит кнопка на экране импорта
// (S-76, F-12-08) и выполняет планировщик — тяжёлое не должно идти в веб-запросе
// (R-PERF-09). `backup` появится вместе с M9 (ADR-004): порядок
// «резервная копия → расписание» задан в `TASK_ORDER` заранее.

import { ensureDataset } from './datasets.js';
import { discoverSync } from './discover-sync.js';
import { refreshRatings } from './ratings.js';
import { scheduleSync } from './schedule-sync.js';
import { notifyScheduleChanges } from '../notify/changes.js';
import { loadSlugs } from './write.js';
import { pgSimilar } from '../catalogue/similar.js';
import {
  candidatesStep, matchStep, enrichStep, catalogueStep, failRun, DATA_DIR,
} from './steps.js';
import { IMPORT_SETTINGS } from '../../config/settings.js';

/**
 * Размер выборки: настройка администратора, а не константа.
 *
 * @param {any} pool
 * @returns {Promise<number>}
 */
async function readTopN(pool) {
  const { rows } = await pool.query(
    "SELECT value FROM e_system_setting WHERE key = 'import.top_n'",
  );
  const value = Number(rows[0]?.value);
  return Number.isInteger(value) && value > 0 ? value : IMPORT_SETTINGS.topN;
}

/**
 * Реестр задач для `createScheduler`.
 *
 * @param {object} deps
 * @param {any} deps.pool
 * @param {any} deps.store
 * @param {any} deps.tmdb клиент TMDB; без ключа задачи обзора упадут сами
 * @param {string} [deps.dataDir] каталог с датасетами IMDb
 * @param {any} [deps.notifications] уведомления M3; без них переносы
 *   остаются в отчёте прогона и никому не пишутся
 * @param {(line: string) => void} [deps.log]
 * @returns {Record<string, Function>}
 */
export function createImportTasks({ pool, store, tmdb, dataDir = DATA_DIR, notifications = null, log = () => {} }) {
  // Похожие сериалы (F-02-08): считаются после импорта, когда изменился сам
  // каталог. Считает тот же код, что и страница читает, — веса лежат в базе.
  const similar = pgSimilar(pool);

  return {
    // Полный прогон (S-76, F-12-08): отбор → сопоставление → обогащение →
    // запись в каталог. Строку прогона заводит планировщик, а выполняет он же.
    //
    // Сухой прогон отличается только флагом строки: те же стадии и тот же
    // объём запросов, но в каталог он не пишет (F-12-08 §6). Запрет задан в
    // самом шаге записи и считывается из строки прогона, а не из аргумента
    // задачи, — «сухой» прогон не может записать в каталог, даже если его
    // позвали с неверным флагом.
    full_run: async ({ runId, now }) => {
      try {
        const topN = await readTopN(pool);
        const candidates = await candidatesStep({ store, runId, topN, dataDir, log });
        await store.updateRun(runId, {
          counters: candidates.counters, checkpoint: candidates.checkpoint,
        });

        const matched = await matchStep({ pool, store, tmdb, runId, log });
        await store.updateRun(runId, {
          counters: matched.counters, checkpoint: matched.checkpoint,
        });

        const enriched = await enrichStep({ pool, store, tmdb, runId, dataDir, log });
        await store.updateRun(runId, {
          counters: enriched.counters, checkpoint: enriched.checkpoint,
        });

        const written = await catalogueStep({ pool, store, runId, now, log });
        await store.updateRun(runId, {
          counters: written.counters, checkpoint: written.checkpoint,
        });

        const steps = [candidates, matched, enriched, written];
        const status = steps.some((step) => step.status === 'partial') ? 'partial' : 'success';

        // Похожие сериалы считаются после того, как каталог обновлён (F-02-08):
        // раньше считать нечего, а веса должны соответствовать каталогу.
        const pairs = await similar.recompute();
        log(`[похожие] сериалов ${pairs.series}, пар ${pairs.pairs}`);

        return { status, items: written.counters.written ?? 0, errors: 0, reason: null };
      } catch (error) {
        // Прогон закрывается ошибкой, а об отвергнутом ключе администратор
        // узнаёт из уведомления: в журнале процесса он бы уже не нашёл
        // ничего (F-12-09 §17, №94).
        await failRun({ pool, store, runId, error });
        throw error;
      }
    },

    schedule_sync: async ({ runId, dryRun, now }) => {
      const result = await scheduleSync({
        pool, store, tmdb, runId, dryRun, now, slugs: await loadSlugs(pool), log,
      });

      // События о переносах уходят подписчикам здесь, а не отдельной задачей:
      // догонять их потом нечем — в базе хранятся только коды (`postponed`,
      // `advanced`), а даты «до» и «после» остались в результате прогона
      // (F-03-08 §3б). Сухой прогон ничего не пишет в каталог, поэтому и
      // уведомлений не создаёт.
      if (notifications && !dryRun) {
        const notified = await notifyScheduleChanges({
          pool, notifications, changes: result.changes ?? [],
        });
        if (notified.created) {
          log(`[уведомления] переносов: уведомлений ${notified.created}, `
            + `заменено предыдущих ${notified.superseded}`);
        }
      }

      return result;
    },

    // Сухого прогона у обзора нет: добавление новинок пишет в каталог всегда,
    // а «посмотреть, что нашлось бы» — это `npm run import:discover`.
    discover_sync: async ({ runId, now }) => {
      const result = await discoverSync({
        pool, store, tmdb, runId, now, slugs: await loadSlugs(pool), log,
      });
      // Новинки изменили каталог — похожие пересчитываются (F-02-08).
      const pairs = await similar.recompute();
      log(`[похожие] сериалов ${pairs.series}, пар ${pairs.pairs}`);
      return result;
    },

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