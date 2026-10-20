// Прогон сопоставления IMDb ↔ TMDB (F-12-02 §4).
//
// Один проход по кандидатам: `/find` по внешнему идентификатору, выбор
// сериала из ответа, проверка пары. Название не сверяется (H-28), сомнение
// всегда разрешается в `pair_doubt`, а не в догадку.

import { pickCandidate, verifyPair, isKeyRejected } from './tmdb.js';
import { IMPORT_SETTINGS } from '../../config/settings.js';

/**
 * Сопоставляет один сериал.
 *
 * @param {{tconst:string, startYear:number|null}} item
 * @param {object} tmdb клиент из `createTmdbClient`
 * @returns {Promise<{tconst:string, tmdbId:number|null, outcome:string, reasons:string[]}>}
 */
async function matchOne(item, tmdb) {
  const { tconst } = item;

  // Детали одного и того же сериала запрашиваются и при выборе из нескольких
  // кандидатов, и при проверке пары. Без кэша это удвоило бы запросы.
  const cards = new Map();
  const getDetails = async (id) => {
    if (!cards.has(id)) cards.set(id, await tmdb.getDetails(id));
    return cards.get(id);
  };

  const { tvResults } = await tmdb.findByImdbId(tconst);
  const picked = await pickCandidate({ results: tvResults, tconst, getDetails });
  if (picked.outcome !== 'ok') {
    return { tconst, tmdbId: null, outcome: picked.outcome, reasons: [picked.reason] };
  }

  const verdict = verifyPair({ tconst, startYear: item.startYear, details: await getDetails(picked.tmdbId) });
  return {
    tconst,
    // Сомнительный идентификатор не сохраняется: подтвердить его должен
    // админ (S-74), а не догадка по одному совпадению года.
    tmdbId: verdict.ok ? picked.tmdbId : null,
    outcome: verdict.outcome,
    reasons: verdict.reason ? [verdict.reason] : [],
  };
}

/**
 * Сопоставляет список кандидатов.
 *
 * Позиции идут параллельно (`import.api_concurrency`), но порядок результата
 * совпадает с порядком входа — иначе отчёт о прогоне зависел бы от того, кто
 * как ответил.
 *
 * @param {object} options
 * @param {{tconst:string, startYear:number|null}[]} options.items
 * @param {object} options.tmdb клиент TMDB
 * @param {number} [options.concurrency]
 * @returns {Promise<{tconst:string, tmdbId:number|null, outcome:string, reasons:string[]}[]>}
 */
export async function matchCandidates({ items, tmdb, concurrency = IMPORT_SETTINGS.apiConcurrency }) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await matchOne(items[index], tmdb);
      } catch (error) {
        // 401 — не «ошибка позиции», а отказ ключа: прогон прерывается целиком
        // (F-12-09 §3), иначе тысяча позиций получит тысячу одинаковых отказов.
        if (isKeyRejected(error)) throw error;
        // Сбой сети или API на одной позиции не должен уносить прогон: иначе
        // из тысячи сериалов не отвечали бы все (F-12-09 §3).
        results[index] = {
          tconst: items[index].tconst,
          tmdbId: null,
          outcome: 'error',
          reasons: [String(error?.message ?? error)],
        };
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}