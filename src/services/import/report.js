// Отчёт об импорте (F-12-08, S-76).
//
// Экран отвечает на два вопроса: что сейчас с расписанием (сколько сериалов
// выходит и у скольких есть даты выхода) и что делал импорт (запуски, их
// счётчики и исходы по позициям). Всё считается по базе: отчёт, собранный по
// журналу процесса, через неделю не говорит ничего, а журнал у процесса, который
// отработал и ушёл, — тем более.
//
// Плотность календаря — измеренная величина, а не плановая: сколько выходов
// стоит в каждой неделе до конца года. Окно взято из SCREENS S-76 («покрытие
// расписания до 31.12»); ключа `import.until` в настройках нет, и выдумывать
// его без решения автора нельзя (№100).

/** Границы плотности: до 31 декабря текущего года. */
function densityUntil(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), 11, 31)).toISOString().slice(0, 10);
}

/**
 * Источник данных отчёта об импорте.
 *
 * @param {import('pg').Pool} pool
 * @returns {object}
 */
export function pgImportReport(pool) {
  return {
    /**
     * Состояние и покрытие расписания.
     *
     * «Выходит с датами N из M» — ключевое число экрана: сколько выходящих
     * сериалов уже знают дату выхода. M считается по всем выходящим, N — по тем
     * из них, у кого есть хотя бы один выход: без дат сериал в календаре не
     * виден, и именно это и показывает число.
     *
     * @param {object} [options]
     * @param {Date} [options.now]
     * @returns {Promise<{withDates:number, total:number, states:object, weeks:object[], until:string}>}
     */
    async overview({ now = new Date() } = {}) {
      const until = densityUntil(now);
      const [states, cover, weeks] = await Promise.all([
        pool.query(
          `SELECT exit_state, count(*)::int AS n
             FROM e_series
            WHERE publication_state = 'published' AND archived_at IS NULL
            GROUP BY exit_state`,
        ),
        pool.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE d.dates > 0)::int AS with_dates
             FROM e_series s
             LEFT JOIN (
               SELECT se.series_id, count(*) AS dates
                 FROM e_release r JOIN e_season se ON se.id = r.season_id
                GROUP BY se.series_id
             ) d ON d.series_id = s.id
            WHERE s.exit_state = 'airing'
              AND s.publication_state = 'published'
              AND s.archived_at IS NULL`,
        ),
        // Окно — от сегодня до конца года: плотность нужна для будущего
        // календаря, а весь прошлый календарь в графике только мешает.
        pool.query(
          `SELECT to_char(date_trunc('week', r.release_date), 'YYYY-MM-DD') AS week,
                  count(*)::int AS n
             FROM e_release r
            WHERE r.release_date >= $2 AND r.release_date <= $1
            GROUP BY 1 ORDER BY 1`,
          [until, now.toISOString().slice(0, 10)],
        ),
      ]);

      const counters = {};
      for (const row of states.rows) counters[row.exit_state] = row.n;

      return {
        withDates: cover.rows[0].with_dates,
        total: cover.rows[0].total,
        states: counters,
        weeks: weeks.rows.map((row) => ({ week: row.week, count: row.n })),
        until,
      };
    },

    /**
     * Запуски импорта, последние сверху.
     *
     * @param {object} [options]
     * @param {number} [options.limit]
     * @returns {Promise<object[]>}
     */
    async runs({ limit = 50 } = {}) {
      const { rows } = await pool.query(
        `SELECT id, kind, status, started_at, finished_at, counters, params, checkpoint, dry_run
           FROM e_import_run
          ORDER BY id DESC LIMIT $1`,
        [limit],
      );
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        counters: row.counters ?? {},
        dryRun: row.dry_run,
        checkpoint: row.checkpoint ?? {},
      }));
    },

    /**
     * Детали запуска: счётчики и исходы по позициям.
     *
     * Исходы фильтруются по `outcome` (белый список) и показываются по
     * страницам: список на десять тысяч позиций в отчёт не годится.
     *
     * @param {number} id номер запуска
     * @param {object} [options]
     * @param {string} [options.outcome] фильтр исхода; пусто — все
     * @param {number} [options.page] страница, с единицы
     * @param {number} [options.size] строк на страницу
     * @returns {Promise<object|null>}
     */
    async run(id, { outcome = '', page = 1, size = 50 } = {}) {
      const { rows: runs } = await pool.query(
        `SELECT id, kind, status, started_at, finished_at, counters, params, checkpoint
           FROM e_import_run WHERE id = $1`,
        [id],
      );
      if (!runs.length) return null;

      const filter = OUTCOMES.includes(outcome) ? outcome : null;
      const [{ rows: counts }, { rows: items }, { rows: total }] = await Promise.all([
        pool.query(
          `SELECT outcome, count(*)::int AS n
             FROM e_import_item_result WHERE run_id = $1 GROUP BY outcome`,
          [id],
        ),
        pool.query(
          `SELECT tconst, tmdb_id, stage, outcome, reasons, http_codes, attempts
             FROM e_import_item_result
            WHERE run_id = $1 AND ($2::text IS NULL OR outcome = $2)
            ORDER BY tconst
            LIMIT $3 OFFSET $4`,
          [id, filter, size, (Math.max(1, page) - 1) * size],
        ),
        pool.query(
          `SELECT count(*)::int AS n
             FROM e_import_item_result
            WHERE run_id = $1 AND ($2::text IS NULL OR outcome = $2)`,
          [id, filter],
        ),
      ]);

      const byOutcome = {};
      for (const row of counts) byOutcome[row.outcome] = row.n;

      return {
        run: runs[0],
        items,
        byOutcome,
        total: total[0].n,
        page: Math.max(1, page),
        size,
        pages: Math.max(1, Math.ceil(total[0].n / size)),
        outcome: filter ?? '',
      };
    },
  };
}

/** Исходы позиции, которые можно отфильтровать в отчёте. */
export const OUTCOMES = ['ok', 'no_tmdb', 'pair_doubt', 'write_failed', 'skipped', 'error'];
