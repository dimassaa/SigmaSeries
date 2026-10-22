// Запись результатов прогона импорта (F-12-01 §4, §17; F-12-09).
//
// Позиция перезаписывается, а не падает: повторный запуск после сбоя обязан
// довести начатое до конца, и уникальность по (run_id, tconst) для этого
// превращается в ON CONFLICT, а не в ошибку.

import { writeServerEvent } from '../analytics/events.js';

/** Колонки позиции — в том же порядке, что и значения в `saveChunk`. */
const COLUMNS = [
  'tconst',
  'tmdb_id',
  'stage',
  'outcome',
  'reasons',
  'http_codes',
  'attempts',
  'popularity_rank',
  'num_votes',
  'average_rating',
  'start_year',
  'raw',
];

/** Сколько позиций уходит в одну вставку. */
const CHUNK = 500;

/**
 * Ограничение выборки.
 *
 * `LIMIT ALL` нельзя передать параметром — Postgres ждёт литерал. Подставляем
 * его в текст, но только из числа, разобранного из аргументов: строковое
 * значение сюда попасть не может.
 *
 * @param {number} limit
 * @returns {string}
 */
function limitClause(limit) {
  if (!Number.isFinite(limit) || limit < 0) {
    throw new Error(`предел должен быть числом, получено «${limit}»`);
  }
  return limit > 0 ? `LIMIT ${Math.floor(limit)}` : '';
}

/**
 * Одна вставка пачки позиций.
 *
 * @param {any} pool
 * @param {number} runId
 * @param {Array<{tconst: string, tmdbId?: number|null, stage: string, outcome: string,
 *   rank?: number|null, numVotes?: number|null, averageRating?: number|null,
 *   startYear?: number|null, raw?: any,
 *   reasons?: string[], httpCodes?: number[], attempts?: number}>} items
 * @returns {Promise<number>}
 */
async function saveChunk(pool, runId, items) {
  const params = [runId];
  const tuples = items.map((item, index) => {
    const values = [
      item.tconst,
      item.tmdbId ?? null,
      item.stage,
      item.outcome,
      item.reasons ?? [],
      item.httpCodes ?? [],
      item.attempts ?? 0,
      item.rank ?? null,
      item.numVotes ?? null,
      item.averageRating ?? null,
      item.startYear ?? null,
      item.raw === undefined ? null : item.raw,
    ];
    for (const value of values) params.push(value);
    const first = index * COLUMNS.length + 2;
    // $1 — это прогон, он общий для всей пачки, поэтому повторяется в каждом
    // кортеже, а не выносится в VALUES.
    const placeholders = ['$1', ...Array.from({ length: COLUMNS.length }, (_, i) => `$${first + i}`)];
    return `(${placeholders.join(', ')})`;
  });

  // Колонки делятся на два типа, и путать их дорого.
  //
  // Данные IMDb (ранг, голоса, оценка, год начала) приходят один раз с
  // отбором и не меняются от стадии к стадии. Поэтому NULL здесь означает
  // «не передано», а не «стереть»: иначе сопоставление, которое знает только
  // tconst и результат поиска, обнулило бы год начала, и следующий шаг уже
  // не смог бы проверить пару.
  //
  // Данные стадии (стадия, исход, причины, коды, попытки, tmdb_id)
  // перезаписываются целиком: там NULL означает «теперь не найдено», и это
  // должно быть видно.
  const KEEP_ON_NULL = ['popularity_rank', 'num_votes', 'average_rating', 'start_year'];
  const update = [
    'tmdb_id = EXCLUDED.tmdb_id',
    'stage = EXCLUDED.stage',
    'outcome = EXCLUDED.outcome',
    'reasons = EXCLUDED.reasons',
    'http_codes = EXCLUDED.http_codes',
    'attempts = EXCLUDED.attempts',
    ...KEEP_ON_NULL.map((column) => `${column} = COALESCE(EXCLUDED.${column}, e_import_item_result.${column})`),
    'raw = COALESCE(EXCLUDED.raw, e_import_item_result.raw)',
    'updated_at = now()',
  ].join(',\n       ');

  await pool.query(
    `INSERT INTO e_import_item_result (run_id, ${COLUMNS.join(', ')})
     VALUES ${tuples.join(', ')}
     ON CONFLICT (run_id, tconst) DO UPDATE SET
       ${update}`,
    params,
  );
  return items.length;
}

/**
 * Хранилище результатов импорта.
 *
 * @param {any} pool подключение к базе
 * @returns {{startRun: Function, progress: Function, pendingCandidates: Function,
 *   matchedSeries: Function, resumeRun: Function, saveItems: Function,
 *   runFlags: Function, updateRun: Function, finishRun: Function}}
 */
export function createImportStore(pool) {
  return {
    /**
     * Открывает прогон.
     *
     * Статус задаётся явно: по умолчанию строка заводится как «запланирована»
     * (её создаёт планировщик заранее), а этот вызов означает «прогон начался
     * сейчас» — иначе прогон, закрытый сразу после старта, не отличался бы от
     * того, который ещё не начинали.
     *
     * @param {'schedule_sync'|'discover_sync'|'ratings_sync'|'full_run'} kind
     * @param {{dryRun?: boolean}} [options]
     * @returns {Promise<number>} идентификатор прогона
     */
    async startRun(kind, { dryRun = false } = {}) {
      const { rows } = await pool.query(
        `INSERT INTO e_import_run (kind, dry_run, status, started_at)
         VALUES ($1, $2, 'running', now()) RETURNING id`,
        [kind, dryRun],
      );
      return rows[0].id;
    },

    /**
     * Исходы позиций прогона.
     *
     * Считаются по всем позициям прогона, а не по тем, что обработаны в этом
     * запуске: прогон, который продолжали после обрыва, обязан показать в
     * отчёте весь объём работы — иначе «обработано 120 из 1000» в первой
     * попытке и «обработано 80 из 300» во второй читались бы как две
     * разные работы (F-12-09 §3, №68).
     *
     * @param {number} runId
     * @returns {Promise<{counts: Record<string, number>, total: number, done: number, failed: number, withoutPair: number}>}
     */
    async progress(runId) {
      const { rows } = await pool.query(
        `SELECT outcome,
                count(*)::int AS n,
                count(*) FILTER (WHERE tmdb_id IS NULL AND outcome <> 'error')::int AS without_pair
           FROM e_import_item_result WHERE run_id = $1
          GROUP BY outcome`,
        [runId],
      );

      const counts = {};
      let total = 0;
      let failed = 0;
      let withoutPair = 0;
      for (const row of rows) {
        counts[row.outcome] = row.n;
        total += row.n;
        withoutPair += row.without_pair;
        if (row.outcome === 'error') failed += row.n;
      }
      return { counts, total, failed, done: total - failed, withoutPair };
    },

    /**
     * Позиции, которым ещё не искали пару.
     *
     * Берётся последний начатый прогон, а не последний успешный: прогон,
     * оборванный сбоем, продолжается с места, а не начинается заново
     * (F-12-09, №95). Перебираются только незавершённые позиции — те, что не
     * дошли до своей стадии, и те, что упали: упавшая позиция не сделана, и
     * прогон, однажды сорвавшийся на сети, иначе больше никогда не дошёл бы
     * до конца.
     *
     * @param {object} [options]
     * @param {number} [options.limit] сколько позиций взять; 0 — все
     * @param {number|null} [options.runId] прогон, из которого брать; без него
     *   берётся последний начатый
     * @returns {Promise<{runId: number, items: any[], status: string}|null>}
     */
    async pendingCandidates({ limit = 0, runId = null } = {}) {
      // Прогон можно задать явно: полный прогон по кнопке (S-76) идёт по
      // своему прогону, а не по «последнему начатому» — иначе он сопоставлял
      // бы чужую работу.
      const { rows: runs } = runId
        ? await pool.query('SELECT id, status FROM e_import_run WHERE id = $1', [runId])
        : await pool.query(
          `SELECT id, status FROM e_import_run
            WHERE kind = 'full_run' AND status NOT IN ('planned','skipped')
            ORDER BY id DESC LIMIT 1`,
        );
      if (!runs.length) return null;

      const { rows } = await pool.query(
        `SELECT tconst, popularity_rank, start_year
           FROM e_import_item_result
          WHERE run_id = $1 AND tmdb_id IS NULL
            AND (stage = 'candidates' OR outcome = 'error')
          ORDER BY popularity_rank
          ${limitClause(limit)}`,
        [runs[0].id],
      );
      return { runId: runs[0].id, items: rows, status: runs[0].status };
    },

    /**
     * Позиции с подтверждённой парой — для обогащения.
     *
     * Берётся последний запуск любого вида: новинки приходят прогоном
     * `discover_sync`, и если смотреть только на `full_run`, обогащение их
     * просто не увидит. И последний прогон, в котором есть сопоставленные
     * позиции: он мог оборваться, и тогда обогащение продолжает его, а не
     * ищет другой (F-12-09, №95).
     *
     * @param {object} [options]
     * @param {number} [options.limit] сколько позиций взять; 0 — все
     * @param {number|null} [options.runId] прогон, из которого брать; без него
     *   берётся последний, где есть пары
     * @returns {Promise<{runId: number, rows: any[], status: string}|null>}
     */
    async matchedSeries({ limit = 0, runId = null } = {}) {
      const { rows: runs } = runId
        ? await pool.query(
          `SELECT r.id, r.status FROM e_import_run r
            WHERE r.id = $1
              AND EXISTS (
                SELECT 1 FROM e_import_item_result i
                 WHERE i.run_id = r.id AND i.tmdb_id IS NOT NULL)`,
          [runId],
        )
        : await pool.query(
          `SELECT r.id, r.status FROM e_import_run r
            WHERE r.status NOT IN ('planned','skipped')
              AND EXISTS (
                SELECT 1 FROM e_import_item_result i
                 WHERE i.run_id = r.id AND i.tmdb_id IS NOT NULL)
            ORDER BY r.id DESC LIMIT 1`,
        );
      if (!runs.length) return null;

      // Отбираются ВСЕ строки с подтверждённой парой, а не только те, что ещё
      // не обогащены. Иначе прогон нельзя переиграть: после записи в каталог
      // стадия становится `written`, и повторное обогащение молча нашло бы
      // ноль позиций — а новые сезоны и даты как раз и требуют повторного
      // обогащения.
      const { rows } = await pool.query(
        `SELECT tconst, tmdb_id, popularity_rank, start_year, num_votes, average_rating
           FROM e_import_item_result
          WHERE run_id = $1 AND tmdb_id IS NOT NULL
          ORDER BY popularity_rank
          ${limitClause(limit)}`,
        [runs[0].id],
      );
      return { runId: runs[0].id, rows, status: runs[0].status };
    },

    /**
     * Продолжить прогон после обрыва.
     *
     * Новый прогон не заводится: у него есть позиции и их стадии, и новый
     * прогон потерял бы половину работы (F-12-09, №95). Статус «resumed» —
     * для отчёта: видно, что прогон продолжался, а не начинался заново.
     *
     * @param {number} runId
     * @returns {Promise<boolean>} был ли прогон в состоянии, из которого
     *   продолжают
     */
    async resumeRun(runId) {
      const { rowCount } = await pool.query(
        `UPDATE e_import_run SET status = 'resumed', started_at = now()
          WHERE id = $1 AND status IN ('error','partial','running','resumed')`,
        [runId],
      );
      return (rowCount ?? 0) > 0;
    },

    /**
     * Пишет позиции прогона.
     *
     * @param {number} runId
     * @param {Array<{tconst: string, stage: string, outcome: string, tmdbId?: number|null,
     *   rank?: number, numVotes?: number, averageRating?: number, startYear?: number|null,
     *   raw?: any, reasons?: string[], httpCodes?: number[], attempts?: number}>} items
     * @returns {Promise<number>} сколько позиций записано
     */
    async saveItems(runId, items) {
      if (!items.length) return 0;

      // Пачками по 500: параметров у PostgreSQL 65 535, и при top_n больше
      // шести тысяч одна вставка упёрлась бы в потолок. К тому же оборванная
      // передача не должна стоить уже записанного.
      let written = 0;
      for (let from = 0; from < items.length; from += CHUNK) {
        written += await saveChunk(pool, runId, items.slice(from, from + CHUNK));
      }
      return written;
    },

    /**
     * Флаги прогона: сухой ли он.
     *
     * Читаются из строки, а не передаются вызывающим: «сухой» прогон не
     * должен писать в каталог, и это не должно зависеть от того, правильно ли
     * его позвали (F-12-08 §6).
     *
     * @param {number} runId
     * @returns {Promise<{dryRun: boolean, status: string|null}>}
     */
    async runFlags(runId) {
      const { rows } = await pool.query(
        'SELECT dry_run, status FROM e_import_run WHERE id = $1',
        [runId],
      );
      return { dryRun: rows[0]?.dry_run ?? false, status: rows[0]?.status ?? null };
    },

    /**
     * Обновить счётчики и контрольную точку, не трогая статус.
     *
     * Полный прогон (F-12-08) идёт в одну строку, и стадия за стадией в неё
     * пишется: статус у такой строки меняет только тот, кто её закрыл.
     *
     * @param {number} runId
     * @param {{counters?: any|null, checkpoint?: any|null}} [extra]
     * @returns {Promise<void>}
     */
    async updateRun(runId, { counters = null, checkpoint = null } = {}) {
      await pool.query(
        `UPDATE e_import_run
            SET counters = counters || coalesce($2::jsonb, '{}'::jsonb),
                checkpoint = coalesce($3::jsonb, checkpoint)
          WHERE id = $1`,
        [
          runId,
          counters ? JSON.stringify(counters) : null,
          checkpoint ? JSON.stringify(checkpoint) : null,
        ],
      );
    },

    /**
     * Закрыть прогон.
     *
     * Счётчики и контрольная точка пишутся рядом со статусом: по отчёту
     * должно быть видно, сколько позиций дошло до конца, сколько упало и на чём
     * прогон остановился (F-12-09, №68, №102).
     *
     * Счётчики не заменяются, а дополняются: полный прогон (F-12-08) идёт в
     * одну строку и пишет в неё по очереди — отбор, сопоставление, обогащение,
     * запись. Замена стёрла бы то, что уже посчитано.
     *
     * @param {number} runId
     * @param {string} status
     * @param {{counters?: any|null, checkpoint?: any|null}} [extra]
     * @returns {Promise<void>}
     */
    async finishRun(runId, status, { counters = null, checkpoint = null } = {}) {
      // Прогон закончен — событие сервера (R-AN-05, EV-23): число записанных
      // сериалов и число ошибок, без имён файлов и без текстов.
      await writeServerEvent(pool, {
        name: 'import_run_finished',
        props: {
          series: String(counters?.series ?? counters?.written ?? counters?.catalogued ?? 0),
          errors: String(counters?.errors ?? 0),
        },
      });
      await pool.query(
        `UPDATE e_import_run
            SET status = $2,
                finished_at = now(),
                counters = counters || coalesce($3::jsonb, '{}'::jsonb),
                checkpoint = coalesce($4::jsonb, checkpoint)
          WHERE id = $1`,
        [
          runId,
          status,
          counters ? JSON.stringify(counters) : null,
          checkpoint ? JSON.stringify(checkpoint) : null,
        ],
      );
    },
  };
}