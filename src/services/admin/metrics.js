// Сбор метрик запросов для экрана «Здоровье системы» (F-09-06, S-82).
//
// Метрики живут в памяти процесса: отдельной таблицы под них в схеме нет, а
// заводить её ради экрана наблюдения — значит менять схему ради удобства.
// Плата за это честная: после перезапуска история пуста, и экран показывает
// «нет данных», а не ноль (EC-B13).
//
// Хранятся не все запросы, а выборка на час. Точный p95 по миллионам строк
// дороже, чем польза от него на этом экране; 2000 значений на час достаточно,
// чтобы увидеть медленный маршрут, и не съедают память.

const HOUR_MS = 3_600_000;
const KEEP_HOURS = 24;
const HOUR_SAMPLES = 2000;
const ROUTE_SAMPLES = 500;

/** Статика не является маршрутом приложения и в p95 не попадает. */
function isStatic(pathname) {
  const path = String(pathname ?? '');
  return path.startsWith('/css/')
    || path.startsWith('/js/')
    || path.startsWith('/img/')
    || path.startsWith('/images/')
    || path.startsWith('/fonts/')
    || path === '/app.js'
    || path === '/asset-version.txt'
    || path === '/favicon.ico';
}

/**
 * p95 по массиву длительностей.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
export function p95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return Math.round(sorted[index] * 10) / 10;
}

/**
 * Сборщик запросов.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] часы, для тестов
 * @returns {any}
 */
export function createRequestMetrics({ now = () => Date.now() } = {}) {
  const startedAt = now();
  const buckets = new Map();
  const routes = new Map();
  let routeHour = Math.floor(startedAt / HOUR_MS);
  let firstHour = Math.floor(startedAt / HOUR_MS);

  let loopLast = now();
  const loopSamples = [];
  const timer = setInterval(() => {
    const current = now();
    const lag = Math.max(0, current - loopLast - 1000);
    loopLast = current;
    loopSamples.push(lag);
    if (loopSamples.length > 60) loopSamples.shift();
  }, 1000);
  timer.unref?.();

  /**
   * Записать один ответ.
   *
   * @param {{route: string, status: number, ms: number, at?: number}} input
   * @returns {void}
   */
  function record({ route, status, ms, at = now() }) {
    const hour = Math.floor(at / HOUR_MS);
    if (hour < firstHour) firstHour = hour;
    let bucket = buckets.get(hour);
    if (!bucket) {
      bucket = { count: 0, errors: 0, durations: [] };
      buckets.set(hour, bucket);
    }
    bucket.count += 1;
    if (Number(status) >= 500) bucket.errors += 1;
    if (bucket.durations.length < HOUR_SAMPLES) {
      bucket.durations.push(Number(ms));
    } else {
      // Резервуарная выборка: поздние запросы не должны вытеснять ранние
      // целиком, иначе p95 за час зависел бы от того, когда открыли экран.
      const index = Math.floor(Math.random() * bucket.count);
      if (index < HOUR_SAMPLES) bucket.durations[index] = Number(ms);
    }

    const currentHour = Math.floor(at / HOUR_MS);
    if (currentHour !== routeHour) {
      routes.clear();
      routeHour = currentHour;
      // Чистим здесь, а не только в snapshot(): экран может не открывать
      // сутки, и без этого карта часов росла бы вместе с uptime.
      for (const hour of buckets.keys()) {
        if (hour < currentHour - KEEP_HOURS + 1) buckets.delete(hour);
      }
    }
    let key = String(route ?? 'unknown').slice(0, 120);
    // Адрес 404 может быть любым. Без потолка карта маршрутов росла бы от
    // случайных запросов — это память, которой управляет не приложение.
    if (!routes.has(key) && routes.size >= 50) key = 'other';
    let routeStats = routes.get(key);
    if (!routeStats) {
      routeStats = { route: key, count: 0, durations: [] };
      routes.set(key, routeStats);
    }
    routeStats.count += 1;
    if (routeStats.durations.length < ROUTE_SAMPLES) {
      routeStats.durations.push(Number(ms));
    } else {
      routeStats.durations.shift();
      routeStats.durations.push(Number(ms));
    }
  }

  /**
   * Middleware: записать ответ после завершения.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   * @returns {void}
   */
  function middleware(req, res, next) {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (isStatic(req.path)) return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const route = req.route?.path
        ? `${req.baseUrl ?? ''}${req.route.path}`
        : String(req.path ?? 'unknown');
      record({ route, status: res.statusCode, ms, at: now() });
    });
    next();
  }

  /**
   * Снимок за последние 24 часа.
   *
   * @returns {any}
   */
  function snapshot() {
    const currentHour = Math.floor(now() / HOUR_MS);
    const oldest = currentHour - KEEP_HOURS + 1;
    for (const hour of buckets.keys()) {
      if (hour < oldest) buckets.delete(hour);
    }

    const errorSeries = [];
    const responseSeries = [];
    for (let hour = oldest; hour <= currentHour; hour += 1) {
      const bucket = buckets.get(hour);
      errorSeries.push({
        hour: new Date(hour * HOUR_MS),
        count: hour < firstHour ? null : (bucket?.errors ?? 0),
      });
      responseSeries.push({
        hour: new Date(hour * HOUR_MS),
        p95: bucket ? p95(bucket.durations) : null,
      });
    }

    const current = buckets.get(currentHour);
    const routeRows = [...routes.values()]
      .map((row) => ({
        route: row.route,
        count: row.count,
        p95: p95(row.durations),
      }))
      .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0));

    return {
      since: new Date(firstHour * HOUR_MS),
      requests: current?.count ?? 0,
      errors: {
        count: currentHour < firstHour ? null : (current?.errors ?? 0),
        series: errorSeries,
      },
      response: {
        p95: current ? p95(current.durations) : null,
        routes: routeRows,
        series: responseSeries,
      },
      eventLoop: {
        delayMs: p95(loopSamples),
        maxMs: loopSamples.length ? Math.max(...loopSamples) : null,
      },
    };
  }

  return { middleware, record, snapshot, stop: () => clearInterval(timer) };
}
