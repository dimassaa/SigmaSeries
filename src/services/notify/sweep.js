// Ежечасный проход уведомлений (F-03-08, OP-09).
//
// Задача «выходы сегодня» делает три вещи за один проход:
//
//  1. Создаёт `release_today` для всех выходов, у которых наступила локальная
//     дата подписчика. Пачками по 500 и по курсору: шаг, который упал,
//     повторяется с места остановки, а повтор не создаёт дублей.
//  2. Схлопывает «много одинаковых за день» в одну сводку — так же, как это
//     сделано для писем, только без письма.
//  3. Пересчитывает кэш прогресса для тех строк, у которых вышел новый эпизод
//     (`#130`, `F-03-03` §8в). Отдельной ночной задачи не будет: ключ дедупликации
//     уже держит повторный проход, а лишний таймер — это ещё одно место, где
//     можно забыть про курсор.
//
// Чего задача не делает: тихих часов (§8г) и письма (P1). Тихие часы по спецификации
// не касаются уведомлений в сервисе, а письма — задача F-03-10.

import { recompute } from '../tracking/progress.js';
import { DEFAULT_TIMEZONE, todayIn } from '../timezone.js';
import { STEP } from './notification.js';

/** Строк `e_progress` за один проход. */
const PROGRESS_STEP = 500;

/** Сколько проходов по прогрессу за раз, чтобы задача не шла полчаса. */
const PROGRESS_ROUNDS = 4;

/** `notify.max_per_user` (M3 §0). */
export const MAX_PER_USER = 500;

/** `notify.digest_threshold` (M3 §0): столько одинаковых за день — уже сводка. */
export const DIGEST_THRESHOLD = 5;

/**
 * Проход уведомлений.
 *
 * Числа лимитов передаются снаружи с рабочими значениями из настроек модуля
 * (`notify.max_per_user`, `notify.digest_threshold`), а проверки берут малые
 * числа: проверка должна доказывать правило, а не повторять 500 строк в базу.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {object} deps.notifications источник данных уведомлений
 * @param {number} [deps.maxPerUser] `notify.max_per_user`
 * @param {number} [deps.digestThreshold] `notify.digest_threshold`
 * @param {Date} [deps.now]
 * @param {(line: string) => void} [deps.log]
 */
export function createNotificationSweep({
  pool,
  notifications,
  maxPerUser = MAX_PER_USER,
  digestThreshold = DIGEST_THRESHOLD,
  now = new Date(),
  log = () => {},
}) {
  return {
    /**
     * Один проход. Идемпотентен: повторный вызов на том же окне ничего не меняет.
     *
     * @returns {Promise<{releases: number, created: number, digests: number, progress: number}>}
     */
    async run() {
      const cursor = await notifications.cursor();
      const to = await lastLocalDate(pool);
      // Нижняя граница — не «вчера по верхней границе», а «последний
      // обработанный день». Разница видна, когда у кого-то пояс впереди: верхняя
      // граница уезжает на завтра, и отсчёт от неё проглатывал бы сегодняшние
      // выходы для всех остальных.
      const from = cursor ? addDays(isoDate(cursor), -1) : addDays(todayIn(DEFAULT_TIMEZONE, now), -1);

      let releases = 0;
      let created = 0;
      let lastDate = null;

      // Выходы читаются по частям, а курсор двигается только после успешной
      // части: упавший шаг повторится целиком, а дублей не будет — их снимает
      // ключ дедупликации.
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const batch = await notifications.dueReleases({ from: lastDate ?? from, to });
        if (!batch.length) break;

        for (const release of batch) {
          // eslint-disable-next-line no-await-in-loop
          const users = await notifications.recipientsOfRelease({
            releaseId: release.id,
            date: release.date,
            maxPerUser,
          });
          if (!users.length) {
            releases += 1;
            lastDate = release.date;
            continue;
          }
          // eslint-disable-next-line no-await-in-loop
          const result = await notifications.create({
            userIds: users,
            kind: 'release_today',
            params: releaseParams(release),
            dedupKey: `release:${releaseKey(release)}`,
          });
          releases += 1;
          created += result.created;
          lastDate = release.date;
        }

        // Курсор двигается после каждой части: упавший на середине проход
        // начнёт сначала с последней целой части, а не с начала окна. День
        // границы сканируется повторно — это цена одного дня лишних строк,
        // зато уведомления не создаются дважды.
        await notifications.saveCursor(`${lastDate}T00:00:00.000Z`);

        if (batch.length < STEP) break;
      }

      const digests = await digestsToday(notifications, digestThreshold, now);
      const progress = await recomputeStaleProgress(pool, now);

      await notifications.saveCursor(now.toISOString());

      const summary = { releases, created, digests, progress };
      log(`[уведомления] выходов ${releases}, уведомлений ${created}, `
        + `сводок ${digests}, прогресс ${progress}`);
      return summary;
    },
  };
}

/** Параметры уведомления о выходе: текст собирается при чтении (R-I18N-04). */
function releaseParams(release) {
  return {
    seriesId: release.series_id,
    seriesSlug: release.slug,
    seriesTitle: release.title_ru ?? release.title_original ?? release.slug,
    season: release.season,
    episodes: release.episodes,
    coversSeason: Boolean(release.covers_season),
    date: release.date,
    releaseKey: releaseKey(release),
  };
}

/**
 * Устойчивый ключ выхода: сериал, сезон, состав и дата.
 *
 * Идентификатор `e_release.id` в ключ не годится: ночная синхронизация
 * расписания удаляет выходы сезона и создаёт их заново, поэтому идентификаторы
 * меняются каждую ночь, и ключ по `id` прислал бы каждому подписчику одно и то
 * же уведомление снова — без всякой смены часового пояса и без EC-T4.
 *
 * @param {object} release
 * @returns {string}
 */
function releaseKey(release) {
  const part = release.covers_season ? 'season' : [...release.episodes].sort((a, b) => a - b).join(',');
  return `${release.series_id}:s${release.season}:${part}:${release.date}`;
}

/**
 * Последняя локальная дата среди активных подписчиков.
 *
 * Берётся максимум, а не дата сервера: в поясе впереди Минска «сегодня» уже
 * наступило, и уведомление за этот день должно уйти в этом же проходе.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<string>}
 */
async function lastLocalDate(pool) {
  const { rows } = await pool.query(
    `SELECT max((now() AT TIME ZONE timezone)::date)::text AS date
       FROM e_user WHERE status = 'active' AND deleted_at IS NULL`,
  );
  return rows[0]?.date ?? isoToday();
}

/**
 * Свернуть «много одинаковых за день» в сводку (F-03-08 §5).
 *
 * @param {object} notifications
 * @param {number} threshold
 * @param {Date} now
 * @returns {Promise<number>} сколько сводок создано
 */
async function digestsToday(notifications, threshold, now) {
  const candidates = await notifications.digestCandidates({ kind: 'release_today', threshold });
  let made = 0;

  for (const candidate of candidates) {
    const date = candidate.series[0]?.date ?? isoDate(now.toISOString());
    // eslint-disable-next-line no-await-in-loop
    const stored = await notifications.storeDigest({
      userId: candidate.userId,
      kind: 'release_today',
      count: candidate.count,
      series: candidate.series,
      date,
    });
    if (stored) made += 1;
  }

  return made;
}

/**
 * Пересчёт кэша прогресса для сериалов, где вышел новый эпизод (#130).
 *
 * @param {import('pg').Pool} pool
 * @param {Date} now
 * @returns {Promise<number>} сколько строк пересчитано
 */
async function recomputeStaleProgress(pool, now) {
  const today = todayIn(DEFAULT_TIMEZONE, now);
  let done = 0;

  for (let round = 0; round < PROGRESS_ROUNDS; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await pool.query(
      `SELECT p.user_id, p.series_id
         FROM e_progress p
        WHERE p.updated_at < (
                SELECT max(r.release_date) FROM e_release r
                  JOIN e_season se ON se.id = r.season_id
                 WHERE se.series_id = p.series_id)
        LIMIT $1`,
      [PROGRESS_STEP],
    );
    if (!rows.length) break;

    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      try {
        // eslint-disable-next-line no-await-in-loop
        await recompute(pool, { userId: row.user_id, seriesId: row.series_id, today });
        done += 1;
      } catch (error) {
        // Сериал могли удалить между отбором строки и пересчётом: кэш при этом
        // исчезает каскадом, и пересчитывать уже нечего. Это не ошибка задачи,
        // поэтому такая строка пропускается, а всё остальное падает как обычно.
        if (error.code !== '23503') throw error;
      }
    }
  }

  return done;
}

/** `YYYY-MM-DD` из ISO-момента. */
function isoDate(value) {
  return String(value).slice(0, 10);
}

/** Сегодняшняя дата серверного пояса — запасной вариант, когда подписчиков нет. */
function isoToday(now = new Date()) {
  return todayIn(DEFAULT_TIMEZONE, now);
}

/** Сдвиг даты на число дней. */
function addDays(date, days) {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}