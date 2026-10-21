// Сборка приложения.
//
// createApp возвращает готовое приложение Express без listen() — так его
// поднимает тест на случайном порту и не занимает настоящий. server.js
// делает то же самое и запускает.

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { createHomeRoutes, createNotFoundRoutes, errorHandler, robots } from './routes/home.js';
import { createAuthRoutes } from './routes/auth.js';
import { createRegisterRoutes } from './routes/register.js';
import { createTasteRoutes } from './routes/register-taste.js';
import { createResetRoutes } from './routes/reset.js';
import { createTwoFactorRoutes } from './routes/twofactor.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createMailboxRoutes } from './routes/mailbox.js';
import { createAdminRoutes } from './routes/admin.js';
import { createReviewRoutes } from './routes/review.js';
import { createSeriesRoutes } from './routes/series.js';
import { createPosterCardRoutes } from './routes/posterCard.js';
import { createThemeRoutes } from './routes/theme.js';
import { createModerationRoutes } from './routes/moderation.js';
import { createMyContentRoutes } from './routes/myContent.js';
import { createAdminUsersRoutes } from './routes/adminUsers.js';
import { createAuditRoutes } from './routes/auditLog.js';
import { createOverviewRoutes } from './routes/adminOverview.js';
import { createBackupRoutes } from './routes/backups.js';
import { createStudioRoutes } from './routes/studio.js';
import { createImportRoutes } from './routes/studioImport.js';
import { createDiscussionRoutes } from './routes/discussions.js';
import { createGuideRoutes } from './routes/guides.js';
import { createStudioLibraryRoutes } from './routes/studioCollections.js';
import { createSplashRoutes } from './routes/studioSplash.js';
import { createStudioCardRoutes } from './routes/studioCard.js';
import { createSystemSettingsRoutes } from './routes/systemSettings.js';
import { createCatalogueRoutes } from './routes/catalogue.js';
import { createSearchRoutes } from './routes/search.js';
import { createSeasonRoutes } from './routes/season.js';
import { createCollectionRoutes } from './routes/collection.js';
import { createCalendarRoutes } from './routes/calendar.js';
import { createMarkRoutes } from './routes/mark.js';
import { createSubscribeRoutes } from './routes/subscribe.js';
import { createNotificationRoutes } from './routes/notifications.js';
import { createStatusRoutes } from './routes/status.js';
import { createLibraryRoutes } from './routes/library.js';
import { createImageRoutes, createCollectionImageRoutes } from './routes/images.js';
import { createJournal } from './services/journal.js';
import { compressedStatic } from './services/assets.js';
import { DEFAULT_LOCALE } from './i18n/strings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, '..', 'public');

/**
 * @param {object} deps
 * @param {object} deps.data источник данных S-01
 * @param {object} deps.auth доступ к учётным записям
 * @param {Function} deps.sessionMw middleware сессий
 * @param {object} [deps.mailQueue] очередь служебных писем (F-01-12)
 * @param {string} [deps.publicDir] где лежит собранная таблица стилей
 */
export function createApp({
  data,
  series = null,
  posterCard = null,
  catalogue = null,
  search = null,
  searchRatePerIp = null,
  seasons = null,
  collections = null,
  person = null,
  calendar = null,
  watchStatus = null,
  statusLimiter = null,
  marks = null,
  progress = null,
  subscriptions = null,
  subscribeLimiter = null,
  feed = null,
  preferences = null,
  panel = null,
  markLimiter = null,
  ratings = null,
  taste = null,
  ratingLimiter = null,
  anomalies = null,
  audit = null,
  reviews = null,
  reviewList = null,
  decisions = null,
  moderationClusters = null,
  moderationBudget = null,
  moderationRestrictions = null,
  myMaterials = null,
  adminUsers = null,
  adminOverview = null,
  backups = null,
  studio = null,
  studioCollections = null,
  splash = null,
  importReport = null,
  freeze = null,
  bulk = null,
  studioDictionaries = null,
  discussions = null,
  guides = null,
  studioCard = null,
  studioSchedule = null,
  studioImages = null,
  picks = null,
  backupRunner = null,
  backupSchedule = null,
  votes = null,
  helpfulLimiter = null,
  reports = null,
  reportLimiter = null,
  dictionary = null,
  reviewIpLimiter = null,
  reviewDeviceLimiter = null,
  library = null,
  pool = null,
  auth,
  sessionMw,
  mailQueue,
  journal = createJournal(),
  mailMode = null,
  baseUrl = '',
  now = () => Date.now(),
  publicDir = PUBLIC_DIR,
}) {
  const app = express();

  // Заголовки безопасности. helmet в списке зависимостей нет: набор ниже
  // покрывает то, что важно для серверного рендеринга без форм и загрузок,
  // и не тянет библиотеку ради шести строк.
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'",
      // Идентификатор свой, а не присланный: иначе человек подставил бы в
      // журнал перевод строки и дописал запись (R-SEC-29).
      'X-Request-Id': crypto.randomUUID(),
    });
    req.requestId = res.getHeader('X-Request-Id');
    next();
  });

  // Корень всегда русский, независимо от заголовков запроса (ADR-003).
  app.get('/', (_req, res) => res.redirect(301, `/${DEFAULT_LOCALE}/`));
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send(robots()));

  // Разбор тела запроса. Без него req.body пуст, и любая проверка CSRF
  // отклоняет всё подряд — форма выглядит сломанной без видимой причины.
  // extended:false — свойства с точками не разбираются в объекты, иначе
  // параметр вида user[password] может стать вложенным объектом.
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(express.json({ limit: '16kb' }));

  // Сжатие статики: таблицы стилей и скрипт отдаются gzip'ом, если клиент
  // его понимает. Файла нет — запрос уходит дальше, к обычной отдаче.
  app.use(compressedStatic(publicDir));

  app.use(express.static(publicDir, {
    // Кэш на год и `immutable` годятся файлам, в имя которых входит хэш
    // содержимого. Здесь имена постоянные (`/css/base.css`, `/app.js`), и
    // браузер, однажды получив файл, не запрашивал бы его никогда: после
    // правки человек продолжал бы видеть старую версию. Час с последующей
    // сверкой по ETag — компромисс между трафиком и свежестью.
    maxAge: '1h',
    setHeaders(res) {
      // Встроенный ранний скрипт темы меняет тему до отрисовки.
      res.set('Content-Security-Policy', "script-src 'self' 'unsafe-inline'");
    },
  }));

  app.use(createHomeRoutes({ data, sessionMw, panel }));

  // Каталог и карточка сериала подключаются, когда есть источник: без него
  // страница отвечала бы 404 на любой адрес, что выглядит как «сервис пуст».
  if (catalogue) app.use(createCatalogueRoutes({ catalogue, sessionMw, panel }));
  if (search) app.use(createSearchRoutes({
    search, sessionMw, panel, ratePerIp: searchRatePerIp ?? undefined,
  }));
  if (seasons) app.use(createSeasonRoutes({ seasons, sessionMw, series, ratings, ratingLimiter }));
  // Слой подробной карточки постера (F-02-07): спрашивается по намерению.
  if (posterCard) app.use(createPosterCardRoutes({ card: posterCard, sessionMw }));
  if (series) app.use(createSeriesRoutes({
    series, watchStatus, sessionMw, progress, subscriptions, ratings, ratingLimiter,
    reviews, reviewList, votes, helpfulLimiter, reports, reportLimiter,
    dictionary, reviewIpLimiter, reviewDeviceLimiter,
  }));
  // Страница отзыва (S-10) живёт вне сериала: адрес `/reviews/{id}` один на
  // отзыв, и по сериалу он не выводится.
  if (reviewList) app.use(createReviewRoutes({
    reviewList, votes, reports, discussions, dictionary, sessionMw,
  }));
  // Решение по аномалии — служебный POST только для админа; без альтернатив
  // (страницы нет до M9), поэтому монтируется только вместе с журналом.
  // Переключатель темы в шапке: выбор уходит в профиль (F-01-06 §8).
  if (auth) app.use(createThemeRoutes({ auth, sessionMw }));
  // Решения редактора по материалам (F-05-04): служебный POST, экран — S-50.
  // Раздел администрирования: пользователи и карточка человека (S-71, S-72).
  // Настройки системы (S-83): пороги и параметры, которые действуют.
  if (pool) app.use(createSystemSettingsRoutes({ pool, audit, sessionMw }));
  // Резервные копии (S-82): журнал, расписание, ручной запуск.
  if (backups) app.use(createBackupRoutes({
    backups, readSchedule: backupSchedule, runBackup: backupRunner, audit, sessionMw,
  }));
  // Студия (S-73, S-74): каталог сериалов и очередь неполных карточек.
  // Руководства (S-11, S-12): список и статья.
  if (guides) app.use(createGuideRoutes({
    guides, series, dictionary, limits: moderationBudget,
    restrictions: moderationRestrictions, sessionMw,
  }));
  // Обсуждения сериала (S-13, S-14): темы, посты, ответы.
  if (discussions) app.use(createDiscussionRoutes({
    discussions, series, dictionary, limits: moderationBudget,
    restrictions: moderationRestrictions, sessionMw,
  }));
  // Подборки и справочники студии (S-77, S-80).
  if (studioCollections) app.use(createStudioLibraryRoutes({
    collections: studioCollections, dictionaries: studioDictionaries,
    series, audit, sessionMw,
  }));
  if (splash) app.use(createSplashRoutes({ splash, audit, sessionMw }));
  // Отчёт об импорте (S-76): состояние расписания и запуски.
  if (importReport) app.use(createImportRoutes({ pool, report: importReport, freeze, audit, sessionMw }));
  if (studio) app.use(createStudioRoutes({ pool, studio, picks, bulk, audit, sessionMw }));
  // Карточка сериала (S-75): правка, публикация, архив.
  if (studioCard) app.use(createStudioCardRoutes({
    card: studioCard, schedule: studioSchedule, images: studioImages, audit, sessionMw,
  }));
  // Системный обзор (S-70): онлайн, очереди, аномалии, копии.
  if (adminOverview) app.use(createOverviewRoutes({ overview: adminOverview, sessionMw }));
  // Журнал аудита (S-81): только чтение, фильтры.
  if (audit) app.use(createAuditRoutes({ audit, sessionMw }));
  if (adminUsers) app.use(createAdminUsersRoutes({
    users: adminUsers,
    auth,
    restrictions: moderationRestrictions,
    audit,
    pool,
    sessionMw,
    journal,
    mailQueue,
  }));
  // «Мои материалы» (S-35): автор видит состояния своих материалов.
  if (myMaterials) app.use(createMyContentRoutes({ materials: myMaterials, sessionMw }));
  if (decisions) app.use(createModerationRoutes({
    decisions,
    clustersService: moderationClusters,
    budget: moderationBudget,
    restrictions: moderationRestrictions,
    audit,
    sessionMw,
  }));
  if (anomalies && audit) app.use(createAdminRoutes({ anomalies, audit, sessionMw }));
  if (collections && person) app.use(createCollectionRoutes({ collections, person, sessionMw, panel }));
  // Календарь спрашивает сессию: фильтр «Мои» доступен вошедшим.
  if (calendar) app.use(createCalendarRoutes({ calendar, sessionMw }));
  // Статус меняется по POST с CSRF и проверкой сессии: без них кнопка
  // была бы формой, которая пишет в базу по чужой ссылке.
  if (watchStatus && series && sessionMw) {
    app.use(createStatusRoutes({ status: watchStatus, series, sessionMw, limiter: statusLimiter ?? undefined }));
  }
  // Закладки читают сессию: гостю показывается вход, вошедшему — свой список.
  if (library && sessionMw) app.use(createLibraryRoutes({ library, sessionMw, progress, subscriptions }));
  // Отметки серий: POST с CSRF, лимитом частоты и проверкой «вышла ли серия».
  if (marks && series && sessionMw) {
    app.use(createMarkRoutes({ marks, series, sessionMw, limiter: markLimiter ?? undefined }));
  }
  // Лента уведомлений (F-03-09). Живёт рядом с подпиской: колокольчик
  // создаёт записи, а лента их показывает, и обе части читают одну таблицу.
  if (feed && sessionMw) app.use(createNotificationRoutes({ feed, sessionMw }));

  // Колокольчик подписки: POST с CSRF и лимитом частоты `subs.rate_per_min`.
  if (subscriptions && series && sessionMw) {
    app.use(createSubscribeRoutes({
      subscriptions,
      series,
      sessionMw,
      limiter: subscribeLimiter ?? undefined,
    }));
  }

  // Картинки отдаются из базы; маршрут нужен, когда есть подключение.
  if (pool) app.use(createImageRoutes({ pool }));
  if (pool) app.use(createCollectionImageRoutes({ pool }));

  if (auth && sessionMw) {
    // Маршруты входа подключаются только если есть и хранилище, и middleware:
    // страница без работающей сессии опаснее, чем её отсутствие.
    app.use(createAuthRoutes({ auth, sessionMw }));
    app.use(createRegisterRoutes({
      auth, sessionMw, mailQueue, mailMode, baseUrl,
      // Шаг 3 включается вместе со своим маршрутом: иначе после подтверждения
      // адреса человек попадал бы на страницу, которой нет.
      tasteStep: Boolean(taste && search),
    }));
    // Шаг 3 регистрации (F-01-01 §4). Живёт отдельным маршрутом, а не внутри
    // регистрации: у него свой источник (зёрна вкуса) и своя сессионная проверка.
    if (taste && search) {
      app.use(createTasteRoutes({ taste, search, auth, sessionMw }));
    }
    app.use(createResetRoutes({ auth, sessionMw, mailQueue, mailMode, journal, baseUrl }));
    app.use(createTwoFactorRoutes({ auth, sessionMw, journal, mailQueue, now }));
  }
  // Настройки доступны и гостю: тема и язык хранятся у него на стороне
  // браузера, вход для них не нужен (F-01-06 §8(а)).
  if (auth && sessionMw) {
    app.use(createSettingsRoutes({
      auth, sessionMw, journal, mailQueue, preferences, now, baseUrl,
    }));
  }
  // Ящик разработчика (S-84) и режим почты: без них режим `devbox` нечем
  // включить, а на защите без интернета показывать нечего.
  if (auth && sessionMw && mailMode) {
    app.use(createMailboxRoutes({ auth, sessionMw, mailQueue, mailMode, journal }));
  }
  app.use(createNotFoundRoutes());
  app.use(errorHandler(DEFAULT_LOCALE));

  return app;
}