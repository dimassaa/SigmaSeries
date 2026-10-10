// Запуск приложения.
//
// Разделение с app.js намеренное: там собирается приложение, здесь —
// процесс. Иначе тест на HTTP-слой невозможен, потому что пришлось бы
// занимать настоящий порт и гасить сервер после каждой проверки.

import { createApp } from './app.js';
import { createPool, checkConnection } from './db/pool.js';
import { pgData } from './services/home/data.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

const pool = createPool();

try {
  await checkConnection(pool);
} catch (e) {
  console.error(`[startup] ${e.message}`);
  process.exit(1);
}

const app = createApp({ data: pgData(pool) });

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