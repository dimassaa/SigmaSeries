// Ночная цепочка новинок: обзор → обогащение → запись в каталог.
//
// Задача `discover_sync` планировщика (F-12-07 §4) вместе с приёмкой F-12-04
// §18: «Дано в TMDB есть сериал с серией через 5 дней; когда ночной запуск;
// тогда он в каталоге, состояние “Выходит”, серия в календаре». Значит, обзора
// мало — новинка обязана дойти до `e_series`.
//
// Чего здесь сознательно нет:
//
//   • картинок (F-12-05). Загрузка идёт отдельной стадией, а её тригвол —
//     «после F-12-03, если путь изображения изменился»; ночная новинка приходит
//     без постера, поэтому её уровень ниже, пока картинки не загружены;
//   • людей из датасетов IMDb (F-12-03). Чтобы их собрать, надо прочитать
//     `title.principals` и `name.basics` — по гигабайту за ночь ради единиц
//     сериалов. Причина `no_people` записывается честно: карточка не «полная»,
//     а «полная, кроме людей», и поднимется при следующем полном прогоне.
//
// Обе недоделки — в `IMPROVEMENTS.md`, решение по ним за автором.

import { discoverCandidates, internalKey } from './discover.js';
import { enrichAll } from './enrich.js';
import { loadSlugs, writeSeries } from './write.js';

/** Прошлая дата окна: выборка в прошлое бессмысленна, а пустой обзор молчит. */
const FALLBACK_UNTIL = '2026-12-31';

async function setting(pool, key) {
  const { rows } = await pool.query('SELECT value FROM e_system_setting WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

/**
 * Находит новые сериалы и добавляет их в каталог.
 *
 * Позиции, которые уже есть в каталоге, молча пропускаются: «окно» отдаёт их
 * каждую ночь, и без фильтра каталог рос бы на сотни строк в сутки (§4).
 *
 * @param {object} deps
 * @param {any} deps.pool
 * @param {any} deps.store
 * @param {any} deps.tmdb
 * @param {number} deps.runId прогон, куда пишутся позиции
 * @param {Set<string>} [deps.slugs]
 * @param {Date} [deps.now]
 * @param {(line: string) => void} [deps.log]
 * @returns {Promise<{status: string, items: number, errors: number, reason: string|null}>}
 *   `reason: 'window'` — окно расписания в прошлом, выборка не выполнялась
 */
export async function discoverSync({ pool, store, tmdb, runId, slugs = null, now = new Date(), log = () => {} }) {
  const until = await setting(pool, 'import.until') ?? FALLBACK_UNTIL;
  const today = now.toISOString().slice(0, 10);
  if (until < today) {
    log(`[новинки] окно расписания закончилось ${until}: выборка не выполняется`);
    return { status: 'success', items: 0, errors: 0, reason: 'window' };
  }

  const { items, unresolvedGenres } = await discoverCandidates({ tmdb, until, today: now });
  if (unresolvedGenres.length) {
    // Исключение потеряло силу для этих жанров (DEC-022): без слов
    // предупреждения в каталог тихо попадут сериалы, которые IMDb-путь отсекает.
    log(`[новинки] жанры TMDB не найдены в справочнике: ${unresolvedGenres.join(', ')}`);
  }
  if (!items.length) return { status: 'success', items: 0, errors: 0, reason: null };

  const { rows: known } = await pool.query('SELECT imdb_key, tmdb_id FROM e_series');
  const knownKeys = new Set(known.map((row) => row.imdb_key).filter(Boolean));
  const knownTmdb = new Set(known.map((row) => row.tmdb_id).filter((id) => id !== null));

  const records = [];
  const fresh = [];
  const seen = new Set();

  for (const item of items) {
    let card;
    try {
      // Карточка нужна ради IMDb-идентификатора: без него ключ остаётся
      // внутренним, и рейтинга IMDb у сериала не будет (F-12-04 §4).
      card = await tmdb.getDetailsLocalized(item.id, 'ru-RU');
    } catch (error) {
      log(`[новинки] ${internalKey(item.id)}: ${error.message}`);
      records.push({
        tconst: internalKey(item.id),
        tmdbId: item.id,
        stage: 'discovered',
        outcome: 'error',
        reasons: [String(error.message)],
      });
      continue;
    }
    if (!card) {
      log(`[новинки] ${internalKey(item.id)}: TMDB не отдал карточку`);
      records.push({
        tconst: internalKey(item.id),
        tmdbId: item.id,
        stage: 'discovered',
        outcome: 'error',
        reasons: ['TMDB не отдал карточку'],
      });
      continue;
    }

    const tconst = card.external_ids?.imdb_id ?? internalKey(item.id);
    if (knownTmdb.has(item.id) || knownKeys.has(tconst) || seen.has(tconst)) continue;
    seen.add(tconst);
    fresh.push({ tmdbId: item.id, tconst, reason: item.reason });
  }

  if (!fresh.length) return closeRun(store, runId, records, 0);

  // Жанры IMDb у новинок не читаются (датасет на то не берут), TMDB отдаёт
  // свои: справочник строится на именах, а `genresFor` берёт любые непустые.
  const enriched = await enrichAll({
    items: fresh.map((entry) => ({
      tmdbId: entry.tmdbId,
      imdb: { tconst: entry.tconst, startYear: null, genres: [], numVotes: null, averageRating: null },
    })),
    tmdb,
  });

  const taken = slugs ?? await loadSlugs(pool);
  let written = 0;

  // Записи идут по одной: счётчик ошибок и порядок позиций в отчёте должны
  // совпадать с тем, что видно в базе, а не с тем, кто успел раньше.
  for (const [index, entry] of enriched.entries()) {
    const target = fresh[index];
    if (!entry.raw) {
      records.push({
        tconst: target.tconst,
        tmdbId: target.tmdbId,
        stage: 'enriched',
        outcome: 'error',
        reasons: [entry.error],
      });
      log(`[новинки] ${target.tconst}: ${entry.error}`);
      continue;
    }

    try {
      await writeSeries({ pool, raw: entry.raw, slugs: taken, now });
      written += 1;
      records.push({
        tconst: target.tconst,
        tmdbId: target.tmdbId,
        stage: 'written',
        outcome: 'ok',
        reasons: [target.reason],
      });
    } catch (error) {
      // Ошибка записи — это «исход этой позиции», а не «весь прогон упал»:
      // остальные новинки от этого не перестают попадать в каталог (F-12-06 §5).
      records.push({
        tconst: target.tconst,
        tmdbId: target.tmdbId,
        stage: 'written',
        outcome: 'error',
        reasons: [String(error.message)],
      });
      log(`[новинки] ${target.tconst}: ${error.message}`);
    }
  }

  return closeRun(store, runId, records, written);
}

/**
 * Закрывает позиции прогона и отвечает, каким он вышел.
 *
 * Ошибки считаются по записям, а не по ходу работы: забытый счётчик тихо
 * закрыл бы прогон с упавшей позицией как успешный, и в отчёте выглядело бы
 * так, будто новинок просто не нашлось.
 *
 * @param {any} store
 * @param {number} runId
 * @param {any[]} records
 * @param {number} written сколько сериалов дошло до каталога
 * @returns {Promise<{status: string, items: number, errors: number, reason: null}>}
 */
async function closeRun(store, runId, records, written) {
  await store.saveItems(runId, records);
  const errors = records.filter((record) => record.outcome === 'error').length;
  return { status: errors ? 'partial' : 'success', items: written, errors, reason: null };
}