// Обзор «новинок и идущих» и добавление в каталог (F-12-04).
//
//   npm run import:discover
//
// Отдельный вид прогона `discover_sync` (§F-12-07): он ничего не перезаписывает,
// а только добавляет. Уже добавленные сериалы не трогаются — «окно» имеет
// право уйти, а каталог — нет (EC-D7).

import { createPool } from '../db/pool.js';
import { createTmdbClient } from '../services/import/tmdb.js';
import { discoverCandidates, internalKey, MAX_PAGES } from '../services/import/discover.js';
import { createImportStore } from '../services/import/store.js';
import { IMPORT_SETTINGS } from '../config/settings.js';

/** Окончание окна расписания — из системных настроек. */
async function untilOf(pool) {
  const { rows } = await pool.query(
    "SELECT value FROM e_system_setting WHERE key = 'import.until'",
  );
  return rows[0]?.value ?? '2026-12-31';
}

async function main() {
  if (!process.env.PGHOST && !process.env.DATABASE_URL) {
    throw new Error('не задано подключение к базе: нужны PGHOST/PGUSER/PGDATABASE или DATABASE_URL');
  }
  if (!process.env.TMDB_TOKEN) {
    throw new Error('не задан TMDB_TOKEN: без ключа обзор невозможен');
  }

  const pool = createPool();
  const store = createImportStore(pool);
  let runId;

  try {
    const until = await untilOf(pool);
    const tmdb = createTmdbClient({ token: process.env.TMDB_TOKEN });

    console.log(`Обзор TMDB до ${until}…`);
    const started = Date.now();
    const { items, unresolvedGenres } = await discoverCandidates({ tmdb, until });
    console.log(`  найдено ${items.length} за ${Math.round((Date.now() - started) / 1000)} с`
      + ` (страниц до ${MAX_PAGES}, потолок ${IMPORT_SETTINGS.newCap})`);
    if (unresolvedGenres.length) {
      // Исключение потеряло силу для этих жанров: без слов предупреждения они
      // молча пропустят сериалы, которые IMDb-путь отсекает (DEC-022).
      console.warn(`  ВНИМАНИЕ: жанры TMDB не найдены в справочнике: ${unresolvedGenres.join(', ')}`);
    }
    if (!items.length) {
      console.log('  подходящих сериалов нет');
      process.exitCode = 0;
      return;
    }

    // Детали нужны ради IMDb-идентификатора: без него ключ остаётся
    // внутренним, и рейтинга IMDb у сериала не будет (§4).
    const withKey = [];
    for (const item of items) {
      const card = await tmdb.getDetailsLocalized(item.id, 'ru-RU');
      const imdbId = card?.external_ids?.imdb_id ?? null;
      withKey.push({
        tmdbId: item.id,
        tconst: imdbId ?? internalKey(item.id),
        hasImdb: Boolean(imdbId),
        firstAirDate: item.first_air_date ?? null,
        popularity: item.popularity ?? null,
        reason: item.reason,
      });
    }

    const { rows: knownRows } = await pool.query('SELECT imdb_key, tmdb_id FROM e_series');
    const knownKeys = new Set(knownRows.map((row) => row.imdb_key).filter(Boolean));
    const knownTmdb = new Set(knownRows.map((row) => row.tmdb_id).filter(Boolean));

    const fresh = withKey.filter((row) => !knownTmdb.has(row.tmdbId));
    const internal = fresh.filter((row) => !row.hasImdb);

    runId = await store.startRun('discover_sync', { dryRun: true });
    await store.saveItems(runId, fresh.map((row) => ({
      tconst: row.tconst,
      tmdbId: row.tmdbId,
      stage: 'discovered',
      outcome: 'ok',
      reasons: [row.reason],
    })));

    console.log(`\nПрогон #${runId}: новых ${fresh.length} из ${withKey.length}`
      + `, уже в каталоге ${withKey.length - fresh.length}`);
    if (internal.length) {
      console.log(`  без IMDb-идентификатора: ${internal.length} (ключ вида tmdb:{id})`);
    }
    const byReason = new Map();
    for (const row of fresh) byReason.set(row.reason, (byReason.get(row.reason) ?? 0) + 1);
    for (const [reason, count] of byReason) console.log(`  причина «${reason}»: ${count}`);

    // Прогон закрывается сразу: незакрытый остаётся `running`, и следующий
    // шаг берёт «последний успешный» — то есть предыдущий, а не этот.
    await store.finishRun(runId, 'success');

    console.log('\nДальше: npm run import:enrich && npm run import:catalogue');
    process.exitCode = 0;
  } catch (error) {
    if (runId) await store.finishRun(runId, 'error').catch(() => {});
    console.error(`\nОбзор не удался: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();