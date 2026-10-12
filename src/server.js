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

const app = createApp({
  data: pgData(pool),
  auth: pgAuthStore(pool),
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

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[shutdown] ${signal}`);
    clearInterval(worker);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  });
}