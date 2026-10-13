// Запуск приложения.
//
// Разделение с app.js намеренное: там собирается приложение, здесь —
// процесс. Иначе тест на HTTP-слой невозможен, потому что пришлось бы
// занимать настоящий порт и гасить сервер после каждой проверки.

import { createApp } from './app.js';
import { createPool, checkConnection } from './db/pool.js';
import { pgData } from './services/home/data.js';
import { pgAuthStore } from './services/auth/store.js';
import { createSessionMiddleware } from './services/auth/session.js';
import { createJournal } from './services/journal.js';
import { createMailQueue } from './services/mail/queue.js';
import { consoleMailer } from './services/mail/console-mailer.js';
import { runDeletionSweep, DELETE_TICK_MS } from './services/auth/deletion.js';
import { runExportSweep, EXPORT_TICK_MS } from './services/data/export-job.js';
import { MAIL_SETTINGS } from './config/settings.js';

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

const mailQueue = createMailQueue({ pool, deliver: (job) => mailer.send(job) });

// Хранилище одно на приложение: два экземпляра делили бы пул, но выглядели бы
// как две разные копии учётных записей — и расхождение было бы не видно.
const auth = pgAuthStore(pool);

const app = createApp({
  data: pgData(pool),
  auth,
  sessionMw: createSessionMiddleware(pool),
  mailQueue,
  journal,
  baseUrl,
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[startup] sigmaseries слушает ${baseUrl}`);
});

// Работник очереди писем. Запускается вместе с сервером, а не по требованию:
// письмо, поставленное в очередь, должно уйти и тогда, когда никто не
// открывает страницу.
const worker = setInterval(() => {
  mailQueue.processDue().catch((e) => {
    console.error(`[mail] ${e.message}`);
  });
}, MAIL_SETTINGS.tickMs);
worker.unref();

// Обезличивание по истечении 14 дней (F-01-10 §4). Сразу при старте, а не
// через первый интервал: сервер мог быть выключен в день срока, и ждать ещё
// четверти часа значило бы держать чужие данные в рабочем виде (EC-A17).
const deletionWorker = setInterval(() => {
  runDeletionSweep({ auth, journal }).catch((e) => {
    console.error(`[удаление] ${e.message}`);
  });
}, DELETE_TICK_MS);
deletionWorker.unref();

runDeletionSweep({ auth, journal }).catch((e) => {
  console.error(`[удаление] ${e.message}`);
});

// Сборка выгрузок (F-01-10 §4). Тоже сразу при старте: заказ, сделанный, пока
// сервер был выключен, иначе ждал бы минуту после каждого перезапуска.
const exportWorker = setInterval(() => {
  runExportSweep({ auth, mailQueue, journal, baseUrl }).catch((e) => {
    console.error(`[экспорт] ${e.message}`);
  });
}, EXPORT_TICK_MS);
exportWorker.unref();

runExportSweep({ auth, mailQueue, journal, baseUrl }).catch((e) => {
  console.error(`[экспорт] ${e.message}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[shutdown] ${signal}`);
    clearInterval(worker);
    clearInterval(deletionWorker);
    clearInterval(exportWorker);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  });
}