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

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

const pool = createPool();

try {
  await checkConnection(pool);
} catch (e) {
  console.error(`[startup] ${e.message}`);
  process.exit(1);
}

if (!process.env.SESSION_SECRET) {
  console.error('[startup] Не задан SESSION_SECRET: сессии подписываются им, ' +
    'а без него идентификатор можно подделать. Сгенерируйте: openssl rand -hex 32');
  process.exit(1);
}

const app = createApp({
  data: pgData(pool),
  auth: pgAuthStore(pool),
  sessionMw: createSessionMiddleware(pool),
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[startup] sigmaseries слушает http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[shutdown] ${signal}`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  });
}