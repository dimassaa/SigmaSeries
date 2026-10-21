// Планировщик запусков импорта (F-12-07).
//
// Четыре правила держат всю конструкцию:
//
//  1. Блокировка живёт в базе, а не в памяти процесса (ADR-004). Иначе после
//     перезапуска приложение считало бы, что ничего не занято, и запустило
//     ночь поверх полного прогона, запущенного вручную.
//  2. Строка запуска создаётся заранее, со временем в будущем. Пропуск ночи —
//     тоже строка (§18), а к моменту, когда стало ясно, что запускать нельзя,
//     ничего не существовало бы, и пропуск негде было бы записать.
//  3. `discover_sync` идёт не по своему часу, а сразу за `schedule_sync`:
//     обзор новых опирается на расписание, и отдельное время для него означало
//     бы либо запуск поверх ещё идущего расписания, либо запуск после сбоя.
//  4. Порядок ночью один: расписание → новые → рейтинг (ADR-004).
//
// Про «пропущено, но просрочено»: сервер мог быть выключен несколько суток.
// Просроченные планы запускаются при старте, но только если с последнего
// успеха прошло меньше 36 часов. Дольше это уже не одна пропущенная ночь, а
// чужая неделя работы, которую нельзя честно закрыть одним запуском: S-76
// показывает «данные устарели» (EC-I10), а данные освежает обычный запуск.

import { isDue, isWeeklyDue, nextOccurrence, nextWeekly, parseScheduleTime } from './schedule-time.js';

/** Прогон старше этого числа часов считается упавшим, а не идущим. */
export const STALE_HOURS = 6;

/** Сколько может пройти с последнего успеха, чтобы догонять ночь при старте. */
export const CATCH_UP_HOURS = 36;

/**
 * Порядок ночных задач (ADR-004, ARCHITECTURE §5).
 *
 * Резервная копия идёт первой, когда M9 зарегистрирует свою задачу: копия
 * снимается до того, как что-то изменилось. Отсутствующие в реестре задачи
 * пропускаются — порядок это свойство списка, а не отдельный механизм.
 */
export const TASK_ORDER = ['backup', 'schedule_sync', 'discover_sync', 'ratings_sync'];

/** Задача, за которой следует эта: у неё нет своего часа. */
const FOLLOWS = { discover_sync: 'schedule_sync' };

/**
 * Планировщик.
 *
 * @param {object} deps
 * @param {object} deps.pool
 * @param {object} deps.store хранилище прогонов
 * @param {Record<string, Function>} deps.tasks задачи по виду запуска
 * @param {() => Date} [deps.now] часы; в тестах — свои
 * @param {(line: string) => void} [deps.log] куда писать о пропусках и сбоях
 * @returns {object}
 */
export function createScheduler({ pool, store, tasks = {}, now = () => new Date(), log = () => {} }) {
  const clock = () => now();

  /**
   * Источники настроек и состояния.
   *
   * Вынесены в объект, а не в параметры конструктора, потому что в приложении
   * всё настоящее, а в тестах — свои часы и своя база; смешивать одно с другим
   * в конструкторе нельзя.
   */
  const settings = {
    scheduleTime: async () => (await setting('import.schedule_time')) ?? '04:00',
    importEnabled: async () => (await setting('import.enabled')) ?? 'on',
    frozen: async () => Boolean(await setting('defence.frozen_at')),
    lastSuccess: async (kind) => (await pool.query(
      `SELECT max(finished_at) AS at FROM e_import_run
        WHERE kind = $1 AND status IN ('success','partial')`,
      [kind],
    )).rows[0]?.at ?? null,
  };

  async function setting(key) {
    const { rows } = await pool.query('SELECT value FROM e_system_setting WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  }

  /** Держит ли кто-то прогон: блокировка общая для всех видов. */
  async function lockHeld() {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM e_import_run
        WHERE status = 'running' AND started_at > now() - ($1 || ' hours')::interval`,
      [String(STALE_HOURS)],
    );
    return rows[0].n > 0;
  }

  /** Запуски, ждущие своего часа. */
  async function plannedRuns() {
    const { rows } = await pool.query(
      "SELECT id, kind, started_at FROM e_import_run WHERE status = 'planned' ORDER BY started_at, id",
    );
    return rows;
  }

  async function planRun(kind, at) {
    const { rows } = await pool.query(
      `INSERT INTO e_import_run (kind, status, started_at, params) VALUES ($1, 'planned', $2, $3)
       ON CONFLICT (kind) WHERE status = 'planned' DO NOTHING RETURNING id, kind, started_at`,
      // Параметры прогона: с чем он запланирован. Без них отчёт не объясняет,
      // что именно запускали (F-12-09 §3, №68).
      [kind, at, JSON.stringify({ planned_at: new Date(at).toISOString() })],
    );
    return rows[0] ?? null;
  }

  /** Почему планировщик молчит: и для ответа, и для S-76. */
  async function silence() {
    if (await settings.importEnabled() === 'off') return 'disabled';
    if (await settings.frozen()) return 'defence';
    return null;
  }

  /** Час еженедельной задачи: на час позже ночного запуска (DEC-053). */
  const weeklyTime = (scheduleTime) => ({
    hours: (scheduleTime.hours + 1) % 24,
    minutes: scheduleTime.minutes,
  });

  /**
   * Планирует ближайшее вхождение задач, у которых есть свой час.
   *
   * `discover_sync` здесь не появляется: он следует за расписанием и
   * планируется в момент его завершения.
   *
   * @returns {Promise<object[]>} созданные планы
   */
  async function plan() {
    if (await silence()) return [];

    const at = clock();
    const scheduleTime = parseScheduleTime(await settings.scheduleTime());
    const created = [];

    created.push(await planRun('schedule_sync', nextOccurrence(scheduleTime, at)));
    created.push(await planRun('ratings_sync', nextWeekly(weeklyTime(scheduleTime), at)));
    return created.filter(Boolean);
  }

  /**
   * Основной такт: выполняет всё, чему подошёл срок.
   *
   * @returns {Promise<{ran: string[], skipped: string[], reason: string|null}>}
   */
  async function tick() {
    const reason = await silence();
    if (reason) return { ran: [], skipped: [], reason };

    const at = clock();
    const scheduleTime = parseScheduleTime(await settings.scheduleTime());
    const ran = [];
    const skipped = [];

    for (const kind of ['schedule_sync', 'ratings_sync']) {
      const row = await plannedRow(kind);
      if (!row || !dueNow(kind, scheduleTime, at)) continue;

      const outcome = await start(row);
      skipped.push(...outcome.skipped);
      if (outcome.status === 'skipped') continue;
      ran.push(kind);
      if (outcome.status === 'error') break;

      // Обзор новых следует за расписанием, а не за своим часом.
      if (FOLLOWS.discover_sync === kind) {
        const fresh = await planRun('discover_sync', at);
        const next = fresh
          ? await start(fresh)
          : { status: 'skipped', skipped: ['discover_sync'] };
        skipped.push(...next.skipped);
        if (next.status === 'skipped') continue;
        ran.push('discover_sync');
      }
    }

    // Ручные запуски (S-76): их ждал не час, а кнопка администратора. Они
    // выполняются после ночных: расписание и рейтинги в своё время, а
    // полный прогон — сразу, как только до него дошла очередь.
    for (const row of await manualRuns()) {
      const outcome = await start(row);
      skipped.push(...outcome.skipped);
      if (outcome.status === 'skipped') continue;
      ran.push(row.kind);
      if (outcome.status === 'error') break;
    }

    await plan();
    return { ran, skipped, reason: null };
  }

  /**
   * Следующие за задачей виды: их тоже надо записать, даже если они не шли.
   *
   * Планы создаются и помечаются пропущенными через `start`, поэтому возвращаются
   * только имена — их добавляет вызывающий.
   *
   * @param {string} kind
   * @returns {Promise<string[]>} какие виды записаны пропущенными
   */
  async function skipFollowers(kind) {
    const followers = Object.entries(FOLLOWS)
      .filter(([, parent]) => parent === kind)
      .map(([child]) => child);
    const recorded = [];
    for (const child of followers) {
      const fresh = await planRun(child, clock());
      if (!fresh) continue;
      // Пропуск без проверки блокировки: она и так есть, раз мы здесь.
      await pool.query(
        `UPDATE e_import_run
            SET status = 'skipped', finished_at = now(), skip_reason = 'следователь за прогоном'
          WHERE id = $1 AND status = 'planned'`,
        [fresh.id],
      );
      recorded.push(child);
    }
    return recorded;
  }

  async function plannedRow(kind) {
    const { rows } = await pool.query(
      "SELECT id, kind, started_at, dry_run FROM e_import_run WHERE kind = $1 AND status = 'planned'",
      [kind],
    );
    return rows[0] ?? null;
  }

  /**
   * Ручные запуски: строки, заведённые кнопкой на экране импорта (S-76).
   *
   * Отдельный список, а не «всё, что ждёт своего часа»: ночной план в 04:00
   * должен ждать 04:00, а ручной запуск — немедленно. И «просроченный» ручной
   * запуск не подчиняется правилу 36 часов: он ждал не ночь, а минуту.
   *
   * @returns {Promise<object[]>}
   */
  async function manualRuns() {
    const { rows } = await pool.query(
      `SELECT id, kind, started_at, dry_run FROM e_import_run
        WHERE status = 'planned' AND params->>'manual' = 'true' AND started_at <= now()
        ORDER BY started_at, id`,
    );
    return rows;
  }

  /** Подошёл ли срок этой задаче. */
  function dueNow(kind, scheduleTime, at) {
    if (kind === 'ratings_sync') return isWeeklyDue(weeklyTime(scheduleTime), at);
    return isDue(scheduleTime, at);
  }

  /**
   * Начинает запланированный запуск.
   *
   * Переход `planned → running` условный: если строку уже взял другой такт или
   * другой процесс, обновление не вернёт ничего и второй запуск не начнётся.
   *
   * @returns {Promise<{status: string, skipped: string[]}>}
   */
  async function start(row) {
    if (await lockHeld()) {
      const skipped = await pool.query(
        `UPDATE e_import_run
            SET status = 'skipped', finished_at = now(), skip_reason = 'прогон держит другой'
          WHERE id = $1 AND status = 'planned' RETURNING id`,
        [row.id],
      );
      if (skipped.rows.length) {
        log(`[планировщик] ${row.kind} пропущен: держит другой прогон`);
      }
      // Обзор новых стоит следом за расписанием: расписание не пошло — не пойдёт
      // и он, и это тоже записывается (§18).
      const followers = await skipFollowers(row.kind);
      return { status: 'skipped', skipped: [row.kind, ...followers] };
    }

    const { rows } = await pool.query(
      `UPDATE e_import_run SET status = 'running', started_at = now()
        WHERE id = $1 AND status = 'planned' RETURNING id`,
      [row.id],
    );
    if (!rows.length) return { status: 'skipped', skipped: [] };

    const task = tasks[row.kind];
    if (!task) {
      // Молча пропущенная задача — это «всё прошло» в отчёте и ничего в
      // каталоге. Такой пропуск обязан быть виден.
      await pool.query(
        `UPDATE e_import_run
            SET status = 'skipped', finished_at = now(), skip_reason = 'задача не зарегистрирована'
          WHERE id = $1`,
        [row.id],
      );
      log(`[планировщик] ${row.kind}: задача не зарегистрирована, запуск пропущен`);
      return { status: 'skipped', skipped: [row.kind] };
    }

    try {
      // Флаг сухого прогона приходит из строки, а не из вызывающего: строка
      // заведена кнопкой на S-76, и «сухой» прогон не должен писать в каталог
      // (F-12-08 §6).
      const result = await task({ runId: row.id, dryRun: row.dry_run, now: clock() });
      const status = result?.status === 'partial' ? 'partial' : 'success';
      await store.finishRun(row.id, status);
      return { status, skipped: [] };
    } catch (error) {
      await store.finishRun(row.id, 'error');
      log(`[планировщик] ${row.kind} не удался: ${error.message}`);
      return { status: 'error', skipped: [] };
    }
  }

  /**
   * Догон при старте процесса (EC-I10).
   *
   * @returns {Promise<{ran: string[], skipped: string[], reason: string|null, stale: boolean}>}
   */
  async function catchUp() {
    const reason = await silence();
    if (reason) return { ran: [], skipped: [], reason, stale: false };

    const at = clock();
    const scheduleTime = parseScheduleTime(await settings.scheduleTime());
    const ran = [];
    const skipped = [];

    // Ночи могло не быть вовсе: планы заводятся работающим процессом, а
    // выключенный сервер не завёл ни одного. Тогда просроченный план создаётся
    // здесь — и запускается, только если с успеха прошло меньше 36 часов.
    const last = await settings.lastSuccess('schedule_sync');
    const overdueHours = last ? (at - new Date(last)) / 3_600_000 : Infinity;
    if (overdueHours > CATCH_UP_HOURS) {
      log(`[планировщик] последнее расписание ${Math.round(overdueHours)} ч назад — догоняю`);
      await planRun('schedule_sync', at);
    }

    const row = await plannedRow('schedule_sync');
    if (row && row.started_at <= at) {
      const outcome = await start(row);
      skipped.push(...outcome.skipped);
      if (outcome.status !== 'skipped') {
        ran.push('schedule_sync');
        if (outcome.status !== 'error') {
          const fresh = await planRun('discover_sync', at);
          const next = fresh
            ? await start(fresh)
            : { status: 'skipped', skipped: ['discover_sync'] };
          skipped.push(...next.skipped);
          if (next.status !== 'skipped') ran.push('discover_sync');
        }
      }
    }

    await plan();
    const state = await readState();
    return { ...state, ran, skipped, reason: null };
  }

  async function readState() {
    const last = await settings.lastSuccess('schedule_sync');
    const hours = last ? (clock() - new Date(last)) / 3_600_000 : Infinity;
    return {
      enabled: await settings.importEnabled() !== 'off',
      frozen: Boolean(await setting('defence.frozen_at')),
      scheduleTime: await settings.scheduleTime(),
      lastSuccessAt: last ? new Date(last) : null,
      stale: hours > CATCH_UP_HOURS,
    };
  }

  const api = {
    settings,
    plan,
    tick,
    catchUp,
    state: readState,
    lockHeld,
    plannedRuns,
    /**
     * Подменяет источники настроек (тесты) и возвращает планировщик.
     *
     * @param {object} source
     * @returns {object}
     */
    setSetting(source) {
      Object.assign(settings, source);
      return api;
    },
  };

  return api;
}
