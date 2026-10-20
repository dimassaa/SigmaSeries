// Запуск приложения.
//
// Разделение с app.js намеренное: там собирается приложение, здесь —
// процесс. Иначе тест на HTTP-слой невозможен, потому что пришлось бы
// занимать настоящий порт и гасить сервер после каждой проверки.

import { createApp } from './app.js';
import { createPool, checkConnection } from './db/pool.js';
import { pgData } from './services/home/data.js';
import { pgSeries } from './services/catalogue/series.js';
import { pgCatalogueList } from './services/catalogue/list.js';
import { pgSearch } from './services/search/service.js';
import { pgSeasons } from './services/catalogue/season.js';
import { pgCollections } from './services/catalogue/collection.js';
import { pgPerson } from './services/catalogue/person.js';
import { pgCalendar } from './services/catalogue/calendar.js';
import { pgWatchStatus } from './services/tracking/status.js';
import { pgMarks } from './services/tracking/marks.js';
import { pgProgress } from './services/tracking/progress.js';
import { pgNotifications } from './services/notify/notification.js';
import { pgNotificationFeed, POLL_SECONDS } from './services/notify/feed.js';
import { pgNotificationPreferences } from './services/notify/preferences.js';
import { pgUpcomingPanel } from './services/catalogue/panel.js';
import { createNotificationSweep } from './services/notify/sweep.js';
import { pgSubscriptions } from './services/tracking/subscription.js';
import { pgLibrary } from './services/tracking/library.js';
import { searchSettings } from './services/search/limits.js';
import { pgRatings } from './services/rating/store.js';
import { pgAnomalySensor } from './services/rating/anomalies.js';
import { pgModerationBudget } from './services/moderation/budget.js';
import { loadSettings } from './services/settings.js';
import { pgSystemHealth } from './services/admin/health.js';
import { pgStudioCatalogue } from './services/studio/catalogue.js';
import { pgEditorialPicks } from './services/studio/picks.js';
import { pgStudioCard } from './services/studio/card.js';
import { pgDiscussions } from './services/discussions/topics.js';
import { pgStudioCollections } from './services/studio/collections.js';
import { pgStudioDictionaries } from './services/studio/dictionaries.js';
import { pgBannerSelection, localDate } from './services/home/banners.js';
import { homeSettings } from './services/home/settings.js';
import { pgModerationDecisions } from './services/moderation/decision.js';
import { pgModerationClusters } from './services/moderation/cluster.js';
import { pgModerationRestrictions } from './services/moderation/restriction.js';
import { pgMyMaterials } from './services/moderation/materials.js';
import { pgAdminUsers } from './services/admin/users.js';
import { pgAdminOverview } from './services/admin/overview.js';
import { pgAuditLog } from './services/audit/log.js';
import { pgReviews } from './services/reviews/store.js';
import { pgReviewList } from './services/reviews/list.js';
import { pgReviewVotes } from './services/reviews/votes.js';
import { pgReviewReports } from './services/reviews/reports.js';
import { pgDictionary } from './services/moderation/dictionary.js';
import { pgBackupJobs } from './services/backup/store.js';
import { pgTaste } from './services/recommendations/taste.js';
import {
  createBackupTask, readSchedule, TICK_MS as BACKUP_TICK_MS,
} from './services/backup/schedule.js';
import { createSnapshotBackup } from './services/backup/snapshot.js';
import { createRateLimiter } from './services/limits.js';
import { pgAuthStore } from './services/auth/store.js';
import { createSessionMiddleware } from './services/auth/session.js';
import { createJournal } from './services/journal.js';
import { createMailQueue } from './services/mail/queue.js';
import { consoleMailer } from './services/mail/console-mailer.js';
import { effectiveMode, smtpMailer } from './services/mail/mode.js';
import { runDeletionSweep, runUnverifiedSweep, DELETE_TICK_MS } from './services/auth/deletion.js';
import { runExportSweep, EXPORT_TICK_MS } from './services/data/export-job.js';
import { createImportStore } from './services/import/store.js';
import { createScheduler } from './services/import/scheduler.js';
import { createImportTasks } from './services/import/tasks.js';
import { createTmdbClient } from './services/import/tmdb.js';
import { MAIL_SETTINGS, RATING, MODERATION, REVIEW, HOUR, DAY } from './config/settings.js';
import cron from 'node-cron';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

const pool = createPool();

try {
  await checkConnection(pool);
} catch (e) {
  console.error(`[startup] ${e.message}`);
  process.exit(1);
}

// Секреты проверяются до старта, а не при первом обращении: без них
// приложение поднялось бы и отвечало бы, падая на первой же регистрации.
const REQUIRED_SECRETS = ['SESSION_SECRET', 'BLIND_INDEX_SECRET', 'ADDRESS_SECRET'];
const missing = REQUIRED_SECRETS.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`[startup] Не заданы секреты: ${missing.join(', ')}. Сгенерируйте: openssl rand -hex 32`);
  process.exit(1);
}

const baseUrl = `http://${HOST}:${PORT}`;
const journal = createJournal();
const mailer = consoleMailer();

// Такт работника уведомлений: раз в час (F-03-08 §3(а)). Отдельного ключа в
// настройках модуля нет — час задан текстом фичи, и выдумывать «настраиваемый
// период» без решения автора нельзя.
const NOTIFY_SWEEP_MS = 60 * 60 * 1000;

// Режим решает, кто доставляет письма (F-01-12 §4). В `devbox` доставки нет
// вовсе: письмо остаётся в базе и показывается в S-84, иначе токены подтверждения
// ушли бы наружу там, где интернета нет (H-51).
const smtp = await smtpMailer();
const mailMode = {
  current: async () => effectiveMode(pool),
  change: async (value, changedBy) => {
    const { rows } = await pool.query(
      `INSERT INTO e_system_setting (key, value, changed_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, changed_by = $3, changed_at = now()`,
      ['mail.mode', value, changedBy ?? null],
    );
    return { ok: rows.length > 0 };
  },
};

const mailQueue = createMailQueue({
  pool,
  deliver: async (job) => {
    if (await mailMode.current() === 'devbox') return;
    if (smtp.configured) {
      await smtp.send(job);
      return;
    }
    // Провайдер не настроен: это не ошибка кода, а неготовность окружения.
    // Письмо остаётся в очереди и повторится (F-01-12 §5).
    if (process.env.MAIL_PRINT === 'true') await mailer.send(job);
    else throw new Error('SMTP-провайдер не настроен (SMTP_HOST пуст)');
  },
});

// Хранилище одно на приложение: два экземпляра делили бы пул, но выглядели бы
// как две разные копии учётных записей — и расхождение было бы не видно.
// Бюджет модерации нужен и сборке приложения (режим читается при отправке),
// и работнику (он режим пересчитывает) — значит, создаётся раньше обоих.
// Настройки из базы поверх стартовых констант: сервисы читают живые значения,
// и без перезапуска (см. `src/services/settings.js`).
const settingsReload = setInterval(() => {
  loadSettings(pool).catch((e) => console.error(`[настройки] ${e.message}`));
}, 60_000);
settingsReload.unref();
loadSettings(pool).catch((e) => console.error(`[настройки] ${e.message}`));

// Три баннера дня: расчёт раз в сутки, в час смены локальной даты
// (F-06-02). При запуске, если на сегодня баннеров нет, они считаются сразу:
// пустая главная хуже расчёта вне расписания.
const bannerSelection = pgBannerSelection(pool);
let bannerDay = null;

/**
 * Пересчитать баннеры, если на сегодня их ещё нет.
 *
 * @returns {Promise<void>}
 */
async function refreshBanners() {
  const date = localDate();
  if (bannerDay === date) return;
  const settings = await homeSettings(pool);
  if (await bannerSelection.countFor(date) > 0) {
    bannerDay = date;
    return;
  }
  const picked = await bannerSelection.recompute({ date, settings });
  bannerDay = date;
  console.log(`[баннеры] ${date}: ${picked.length} мест занято`);
}

// Проверка раз в минуту: час смены даты наступает один раз в сутки, и
// сравнение дешевле, чем пересчёт по расписанию.
const bannerWorker = setInterval(() => {
  const date = localDate();
  const hour = new Date().getHours();
  const settings = homeSettings(pool).then((values) => {
    if (hour !== values.reloadHour) return null;
    if (bannerDay === date) return null;
    return bannerSelection.recompute({ date, settings: values })
      .then((picked) => {
        bannerDay = date;
        console.log(`[баннеры] ${date}: ${picked.length} мест занято`);
      });
  });
  settings.catch((e) => console.error(`[баннеры] ${e.message}`));
}, 60_000);
bannerWorker.unref();
refreshBanners().catch((e) => console.error(`[баннеры] ${e.message}`));

// Число людей в сети: раз в час считается и пишется в базу (F-09-05).
// Пропущенный час — разрыв, а не ноль.
const systemHealth = pgSystemHealth(pool);
const onlineWorker = setInterval(() => {
  systemHealth.sample().catch((e) => console.error(`[онлайн] ${e.message}`));
}, 60 * 60_000);
onlineWorker.unref();
// Первый замер — сразу: час пустого ряда перед первым значением был бы
// разрывом, которого никто не видел бы.
systemHealth.sample().catch((e) => console.error(`[онлайн] ${e.message}`));

const moderationBudget = pgModerationBudget(pool);
const auth = pgAuthStore(pool);

// Лимит читается один раз при старте: см. services/search/limits.js.
const { ratePerIp: searchRatePerIp } = await searchSettings(pool);

// Уведомления о выходах (F-03-08). Работник ежечасный и запускается сразу при
// старте: пока сервер был выключен, могли выйти серии у кого-то «сегодня» —
// их уведомления обязаны догнаться при первом же запуске (EC-T17), а не через
// час ожидания.
const notifications = pgNotifications(pool);
const feed = pgNotificationFeed(pool);
const preferences = pgNotificationPreferences(pool);
// Панель «Предстоящие» живёт вместе с приложением: её кэш держит последние
// три календарные даты, и пересоздавать его на каждый запрос незачем.
const panel = pgUpcomingPanel(pool, {
  onError: (error) => console.error(`[панель] ${error.message}`),
});
const notificationSweep = createNotificationSweep({
  pool,
  notifications,
  feed,
  log: (line) => console.log(line),
});

const sweepNotifications = () => notificationSweep.run()
  .catch((error) => console.error(`[уведомления] ${error.message}`));

const notificationWorker = setInterval(sweepNotifications, NOTIFY_SWEEP_MS);
notificationWorker.unref();

sweepNotifications();

// Оценки аккаунтов, дожидающих возраста, вводятся в агрегат (EC-V4), и тем же
// ежечасным проходом пересчитывается среднее по сайту C (F-04-03): C — среднее
// учитываемых голосов, и голос, вошедший сейчас, обязан войти в него в этом же
// проходе, а не в следующем. Таймер один, а не два: место, где об этом
// забывают, должно быть одно.
const ratings = pgRatings(pool);
// Датчик аномалий работает с тем же хранилищем оценок, что и показ:
// снимок заморозки обязан читаться без пересчётов (F-04-08).
const anomalies = pgAnomalySensor({ pool, ratings });
const audit = pgAuditLog(pool);

const countMatured = () => ratings.countMaturedRatings(new Date())
  .then((count) => {
    if (count) console.log(`[оценки] в рейтинг вошли голоса: ${count}`);
  });

const refreshSite = () => ratings.refreshSiteAverage(new Date())
  .then(({ votes, average }) => {
    if (votes) console.log(`[оценки] среднее по сайту: ${average.toFixed(1)} по ${votes} голосам`);
  });

const scanAnomalies = () => anomalies.scan(new Date())
  .then((found) => {
    if (found) console.log(`[аномалии] открыто событий: ${found}`);
  })
  .catch((error) => console.error(`[аномалии] ${error.message}`));

/** Ежечасная работа с оценками: дозревание, среднее по сайту C, датчик аномалий. */
const hourlyRatings = () => countMatured()
  .then(refreshSite)
  .then(scanAnomalies)
  .catch((error) => console.error(`[оценки] ${error.message}`));

const maturedWorker = setInterval(hourlyRatings, NOTIFY_SWEEP_MS);
maturedWorker.unref();

hourlyRatings();

const app = createApp({
  data: pgData(pool),
  series: pgSeries(pool),
  catalogue: pgCatalogueList(pool),
  search: pgSearch(pool),
  searchRatePerIp,
  anomalies,
  audit,
  seasons: pgSeasons(pool),
  collections: pgCollections(pool),
  person: pgPerson(pool),
  calendar: pgCalendar(pool),
  watchStatus: pgWatchStatus(pool),
  marks: pgMarks(pool),
  // Оценки (F-04-01, OP-03). Лимит частоты — `rating.rate_per_hour` (M4 §0):
  // счёт по пользователю, потому что у оценки есть владелец, в отличие от
  // поиска, где ключом служит адрес.
  ratings,
  ratingLimiter: createRateLimiter({ limit: RATING.ratePerHour, windowMs: HOUR }),
  // Отзывы (F-04-04). Часовой лимит автора ведёт сам сервис: он считается по
  // базе, иначе перезапуск процесса обнулял бы право писать. Потолки сети и
  // устройства (R-MOD-10) — счётчики в памяти, как у прочих лимитов частоты.
  reviews: pgReviews(pool),
  // Список отзывов (F-04-05): выборка страницы и «лучшие» для S-06.
  reviewList: pgReviewList(pool),
  decisions: pgModerationDecisions(pool),
  moderationClusters: pgModerationClusters(pool),
  moderationBudget: moderationBudget,
  moderationRestrictions: pgModerationRestrictions(pool, { auth, audit }),
  myMaterials: pgMyMaterials(pool),
  discussions: pgDiscussions(pool, {
    limits: moderationBudget,
    restrictions: pgModerationRestrictions(pool, { auth, audit }),
  }),
  studioCollections: pgStudioCollections(pool),
  studioDictionaries: pgStudioDictionaries(pool),
  studio: pgStudioCatalogue(pool),
  studioCard: pgStudioCard(pool),
  picks: pgEditorialPicks(pool),
  adminUsers: pgAdminUsers(pool),
  adminOverview: pgAdminOverview(pool, { backups: pgBackupJobs(pool), health: systemHealth }),
  backups: pgBackupJobs(pool),
  backupSchedule: () => readSchedule(pool),
  // Ручной запуск копии: тот же снимок, что и по расписанию, с проверкой
  // восстановления во временную базу (F-09-04 §8а).
  backupRunner: async () => {
    const result = await createSnapshotBackup({ pool, keepFile: true });
    await pgBackupJobs(pool).record({
      status: result.status,
      sizeBytes: result.bytes,
      filePath: result.file ?? null,
    });
    return result;
  },
  // Голоса «Полезно» (F-04-06). Потолок частоты — по пользователю: у голоса
  // есть владелец, сети и устройство не ограничиваются.
  votes: pgReviewVotes(pool),
  helpfulLimiter: createRateLimiter({ limit: REVIEW.helpfulRatePerHour, windowMs: HOUR }),
  // Жалобы на отзывы (F-04-07). Потолок — сутки на аккаунт (M4 §0):
  // жалоба — решение, а не привычка; окно шире, чем у голоса.
  reports: pgReviewReports(pool),
  reportLimiter: createRateLimiter({ limit: REVIEW.reportRatePerDay, windowMs: DAY }),
  dictionary: pgDictionary(pool),
  reviewIpLimiter: createRateLimiter({ limit: MODERATION.materialsPerHourIp, windowMs: HOUR }),
  reviewDeviceLimiter: createRateLimiter({ limit: MODERATION.materialsPerHourDevice, windowMs: HOUR }),
  // Шаг 3 регистрации: зёрна вкуса (F-01-01 §4).
  taste: pgTaste(pool),
  progress: pgProgress(pool),
  subscriptions: pgSubscriptions(pool),
  feed,
  panel,
  library: pgLibrary(pool),
  pool,
  auth,
  sessionMw: createSessionMiddleware(pool, undefined, {
    // Один запрос на страницу, только вошедшим: гостю меню не показывается.
    // Тема едет с аккаунтом: страница должна знать выбор человека ещё до
    // отрисовки, иначе первая картинка мигнёт чужой темой (F-01-06 §8).
    account: async (user) => ({
      nickname: user.nickname,
      // Тема — из профиля, а не из сессии: сессия хранит снимок на момент
      // входа, и выбор, сделанный позже, остался бы в ней старым.
      theme: await auth.themeOf(user.id),
      unread: await feed.unreadCount(user.id),
      pollSeconds: POLL_SECONDS,
    }),
  }),
  mailQueue,
  mailMode,
  journal,
  baseUrl,
});

// Резервная копия по расписанию (F-09-04 §3, `backup.schedule`). Проверка
// «пора ли» — раз в четверть часа, сама копия снимается только когда назначенный
// час прошёл, а копии за сегодня ещё нет. Так сервер, поднятый после обеда,
// всё равно сделает копию за день: пропущенная копия хуже поздней.
const backups = pgBackupJobs(pool);
const backupTask = createBackupTask({
  pool, backups, log: (line) => console.log(line),
});

const backupTick = () => backupTask.due()
  .then((due) => (due ? backupTask.run() : null))
  .catch((error) => console.error(`[копия] ${error.message}`));

const backupWorker = setInterval(backupTick, BACKUP_TICK_MS);
backupWorker.unref();

// Первой проверки сразу при старте здесь нет, в отличие от задач уведомлений и
// обезличивания: снятие копии занимает минуты и весит сотни мегабайт, и
// человек, поднявший сервер, не ждёт этого в первые секунды работы. Через
// четверть часа проверка всё равно произойдёт и копия за день встанет.

const server = app.listen(PORT, HOST, async () => {
  console.log(`[startup] sigmaseries слушает ${baseUrl}`);

  // EC-A23: режим, включённый по ошибке, должен быть виден сразу, а не тому,
  // кто через час обнаружит, что подтверждения не приходят.
  const mode = await mailMode.current();
  if (mode === 'devbox') {
    const warning = 'Режим devbox: письма не отправляются, а показываются в S-84';
    console.warn(`[startup] ${warning}`);
    journal.security({ event: 'mail_mode_devbox', requestId: 'старт' });
  }
});

// «Осторожный» режим модерации (F-05-03): доля помеченных пересчитывается
// по расписанию. Решение о режиме принимает система, а не сама отправка
// материала: иначе решение зависело бы от того, кто отправил последним.
const moderationWorker = setInterval(() => {
  moderationBudget.refresh()
    .then((state) => {
      if (state.cautious) {
        console.log(`[модерация] осторожный режим: помечено ${state.flagged} из ${state.total}`);
      }
    })
    .catch((e) => console.error(`[модерация] ${e.message}`));
}, 60_000);
moderationWorker.unref();
moderationBudget.refresh().catch((e) => console.error(`[модерация] ${e.message}`));

// Работник очереди писем. Запускается вместе с сервером, а не по требованию:
// письмо, поставленное в очередь, должно уйти и тогда, когда никто не
// открывает страницу.
const worker = setInterval(() => {
  mailQueue.processDue().catch((e) => {
    console.error(`[mail] ${e.message}`);
  });
}, MAIL_SETTINGS.tickMs);
worker.unref();

// Обезличивание по истечении срока: удаление по заявке человека (F-01-10 §4) и
// неподтверждённый аккаунт, не дождавшийся письма (F-01-01 §8(г)).
// Задачи две, таймер один: отдельный таймер на каждую — это ещё одно место,
// где можно забыть про срок. Сразу при старте, а не через первый интервал:
// сервер мог быть выключен в день срока, и ждать ещё четверти часа значило бы
// держать чужие данные в рабочем виде (EC-A17).
const anonymize = () => {
  runDeletionSweep({ auth, journal }).catch((e) => {
    console.error(`[удаление] ${e.message}`);
  });
  runUnverifiedSweep({ auth, journal }).catch((e) => {
    console.error(`[неподтверждённый] ${e.message}`);
  });
};

const deletionWorker = setInterval(anonymize, DELETE_TICK_MS);
deletionWorker.unref();

anonymize();

// Сборка выгрузок (F-01-10 §4). Тоже сразу при старте: заказ, сделанный, пока
// сервер был выключен, иначе ждал бы минуту после каждого перезапуска.
const purgeWorker = setInterval(() => {
  mailQueue.purge().catch((e) => {
    console.error(`[почта] очистка: ${e.message}`);
  });
}, MAIL_SETTINGS.purgeTickMs);
purgeWorker.unref();

const exportWorker = setInterval(() => {
  runExportSweep({ auth, mailQueue, journal, baseUrl }).catch((e) => {
    console.error(`[экспорт] ${e.message}`);
  });
}, EXPORT_TICK_MS);
exportWorker.unref();

runExportSweep({ auth, mailQueue, journal, baseUrl }).catch((e) => {
  console.error(`[экспорт] ${e.message}`);
});

// Планировщик импорта (F-12-07, ADR-004): `node-cron` в этом же процессе.
// Такт ежеминутный, а «пора ли» решает сам планировщик по `import.schedule_time`.
// Так время из настроек меняется без перезапуска приложения — регистрировать
// cron-выражение заново пришлось бы на каждый чих, а несостыковка расписания с
// настройкой стоила бы пропущенной ночи.
let schedulerTask = null;
if (process.env.TMDB_TOKEN) {
  const store = createImportStore(pool);
  const scheduler = createScheduler({
    pool,
    store,
    tasks: createImportTasks({
      pool,
      store,
      tmdb: createTmdbClient({ token: process.env.TMDB_TOKEN }),
      notifications,
      log: (line) => console.error(line),
    }),
    log: (line) => console.error(line),
  });

  // `unref` — как у остальных работников: таймер не должен держать процесс.
  // `noOverlap` — такт длиннее минуты (ночная задача идёт минуты) не должен
  // наезжать сам на себя.
  schedulerTask = cron.schedule('* * * * *', async () => {
    try {
      const { ran, skipped, reason } = await scheduler.tick();
      for (const kind of ran) console.log(`[планировщик] ${kind} выполнен`);
      for (const kind of skipped) console.warn(`[планировщик] ${kind} пропущен`);
      if (reason === 'defence') console.warn('[планировщик] режим защиты: импорт не запускается');
    } catch (e) {
      console.error(`[планировщик] ${e.message}`);
    }
  }, { noOverlap: true, unref: true });

  // Строка при старте: планировщик либо есть, либо его нет — молча выключенного
  // расписания не должно быть (F-12-07 §19, панель S-76).
  scheduler.settings.scheduleTime().then((time) => {
    console.log(`[планировщик] такт раз в минуту, ночной запуск в ${time}`);
  }).catch((e) => {
    console.error(`[планировщик] ${e.message}`);
  });

  // Догон при старте (EC-I10): сервер мог быть выключен ночью, а ждать первого
  // такта — значило бы отдать ещё одну ночь.
  scheduler.catchUp().then((state) => {
    for (const kind of state.ran) console.log(`[планировщик] догон: ${kind} выполнен`);
    for (const kind of state.skipped) console.warn(`[планировщик] догон: ${kind} пропущен`);
    if (state.stale) {
      // Данные старше 36 часов догон не трогает: это уже чужая неделя работы,
      // а не одна пропущенная ночь. Честнее сказать об этом в журнал сейчас,
      // чем ждать, пока это заметят на экране (S-76, F-12-08).
      console.warn('[планировщик] данные устарели: последнее успешное расписание старше 36 часов');
    }
  }).catch((e) => {
    console.error(`[планировщик] догон: ${e.message}`);
  });
} else {
  console.warn('[планировщик] TMDB_TOKEN не задан: ночные задачи импорта не запускаются');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[shutdown] ${signal}`);
    clearInterval(worker);
    clearInterval(deletionWorker);
    clearInterval(exportWorker);
    clearInterval(purgeWorker);
    // Импорт, начатый до остановки, не ждёт: его прогон останется `running`,
    // разомкнётся по `STALE_HOURS` и будет помечен как пропущенный (F-12-09).
    schedulerTask?.stop();
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  });
}