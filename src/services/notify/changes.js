// Переносы и отмены выходов из событий импорта (F-03-08 §3(б), §8(б)).
//
// События приходят из ночной синхронизации расписания (`import/schedule-sync`),
// а не из таблицы: там лежит код (`postponed`, `advanced`), а не сам выход.
// Поэтому этот модуль — единственное место, где код превращается в уведомление,
// и поэтому он же решает, что делать с предыдущим уведомлением.
//
// Три правила, каждое из которых легко нарушить:
//
//  · Человек должен узнать о переносе один раз. Два переноса за сутки схлопываются
//    в последний (§8б): «на 20-е», а через час «на 27-е» — это одна новость,
//    а не две. Уведомление старше суток не трогается: человек его уже прочитал,
//    и молчаливая правка старого текста выглядела бы как ошибка.
//  · Прежнее «вышла сегодня» не удаляется (EC-T5): перенос — это дополнение,
//    а не замена. Человек должен видеть, что серия уже была в его списке.
//  · Подписчику без действующей подписки уведомление не создаётся (§8д) —
//    получателей берёт тот же отбор, что и у ежечасной задачи.

import pg from 'pg';

/** Коды события синхронизации → тип уведомления. */
const KIND_BY_CODE = {
  postponed: 'release_changed',
  advanced: 'release_changed',
  release_cancelled: 'release_cancelled',
};

/**
 * Создать уведомления по событиям расписания.
 *
 * @param {object} deps
 * @param {pg.Pool} deps.pool
 * @param {object} deps.notifications источник данных уведомлений
 * @param {object[]} deps.changes события `scheduleSync`: `code`, `tconst`, `season`, `episode`, `from`, `to`
 * @param {number} [deps.maxPerUser]
 * @returns {Promise<{checked: number, created: number, superseded: number}>}
 */
export async function notifyScheduleChanges({ pool, notifications, changes, maxPerUser = 500 }) {
  const summary = { checked: changes.length, created: 0, superseded: 0 };

  for (const change of changes) {
    const kind = KIND_BY_CODE[change.code];
    if (!kind || change.episode === undefined || change.episode === null) continue;

    // eslint-disable-next-line no-await-in-loop
    const found = await findRelease(pool, change);
    if (!found) continue;   // серия не в каталоге — показывать некому

    // eslint-disable-next-line no-await-in-loop
    const users = await notifications.recipientsOfRelease({
      releaseId: found.id,
      date: found.release_date,
      maxPerUser,
      // Перенос интересует подписчика и до новой даты: ждать её было бы
      // молчанием там, где человек ждёт новости.
      requireStarted: false,
    });
    if (!users.length) continue;

    const params = {
      seriesId: found.series_id,
      seriesSlug: found.slug,
      seriesTitle: found.title_ru ?? found.title_original ?? found.slug,
      season: found.season,
      episodes: [change.episode],
      date: change.to,
      from: change.from,
      releaseKey: `${found.series_id}:s${found.season}:${change.episode}`,
    };
    const dedupKey = `changed:${params.releaseKey}:${change.to}`;

    // eslint-disable-next-line no-await-in-loop
    const result = await notifications.create({
      userIds: users,
      kind,
      params,
      dedupKey,
    });
    summary.created += result.created;

    // eslint-disable-next-line no-await-in-loop
    summary.superseded += await supersedeOlder(pool, {
      userIds: users,
      kind,
      releaseKey: params.releaseKey,
      keep: dedupKey,
    });
  }

  return summary;
}

/**
 * Найти выход по событию синхронизации.
 *
 * Событие говорит «серия 5 переехала на такую-то дату», а строки в базе после
 * синхронизации новые: искать приходится по содержимому, а не по прежнему
 * идентификатору.
 *
 * @param {pg.Pool} pool
 * @param {object} change
 * @returns {Promise<object|null>}
 */
async function findRelease(pool, change) {
  const { rows } = await pool.query(
    `SELECT r.id, r.release_date::text, se.number AS season, s.id AS series_id,
            s.slug, s.title_ru, s.title_original
       FROM e_release r
       JOIN e_release_episode x ON x.release_id = r.id
       JOIN e_episode e ON e.id = x.episode_id
       JOIN e_season se ON se.id = r.season_id
       JOIN e_series s ON s.id = se.series_id
      WHERE s.imdb_key = $1 AND se.number = $2 AND e.number = $3
        AND r.release_date = $4::date
      LIMIT 1`,
    [change.tconst, change.season, change.episode, change.to],
  );
  return rows[0] ?? null;
}

/**
 * Убрать предыдущие уведомления о переносе того же выхода за сутки (§8б).
 *
 * @param {pg.Pool} pool
 * @param {object} args
 * @returns {Promise<number>} сколько строк убрано
 */
async function supersedeOlder(pool, { userIds, kind, releaseKey, keep }) {
  const { rowCount } = await pool.query(
    `DELETE FROM e_notification
      WHERE user_id = ANY($1::bigint[]) AND kind = $2
        AND params->>'releaseKey' = $3 AND dedup_key <> $4
        AND created_at > now() - interval '24 hours'`,
    [userIds, kind, releaseKey, keep],
  );
  return rowCount;
}