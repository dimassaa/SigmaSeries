// Сборка выгрузки в фоне (F-01-10 §4, EC-A21).
//
// Заявка ждёт своей очереди и собирается целиком: отдать половину хуже, чем
// ничего, потому что человек не отличит одно от другого. Предел размера
// проверяется до записи файла, и превышение — это отказ, а не обрезка.

import crypto from 'node:crypto';

import { AUTH } from '../../config/settings.js';
import { buildExport, tooBigToExport } from './export.js';

/** Как часто задача смотрит очередь выгрузок. */
export const EXPORT_TICK_MS = 60_000;

/**
 * @param {object} deps
 * @param {object} deps.auth хранилище учётных записей и выгрузок
 * @param {object} deps.mailQueue очередь писем
 * @param {object} [deps.journal] журнал безопасности
 * @param {string} [deps.baseUrl] основа ссылки в письме
 * @param {Function} [deps.now] часы, для тестов
 * @returns {Promise<{ready:number, failed:number}>}
 */
export async function runExportSweep({ auth, mailQueue, journal, baseUrl = '', now = () => Date.now() }) {
  const queued = await auth.dueExports(new Date(now()));
  let ready = 0;
  let failed = 0;

  for (const job of queued) {
    const at = new Date(now());
    const token = crypto.randomBytes(32).toString('base64url');

    // Данные читаются до отметки «готовится»: два прохода по очереди не должны
    // собрать один и тот же файл дважды.
    // eslint-disable-next-line no-await-in-loop
    const mine = await auth.exportData(job.user_id);

    let built;
    try {
      built = buildExport(mine, { moderationNotes: mine.moderationNotes ?? [] });
    } catch (e) {
      // eslint-disable-next-line no-await-in-loop
      await auth.markExportFailed(job.id, at);
      journal?.security({ event: 'export_failed', user_id: job.user_id, requestId: 'задача' });
      console.error(`[экспорт] сборка ${job.id}: ${e.message}`);
      failed += 1;
      continue;
    }

    if (tooBigToExport(built.json)) {
      await auth.markExportFailed(job.id, at);
      journal?.security({ event: 'export_failed', user_id: job.user_id, requestId: 'задача' });
      failed += 1;
      continue;
    }

    const expiresAt = new Date(at.getTime() + AUTH.exportLinkHours * 3_600_000);
    // eslint-disable-next-line no-await-in-loop
    await auth.markExportReady(job.id, built.json, built.sha256, built.size, expiresAt, token);

    // Ссылка уходит в письмо и в настройки; сам адрес хранит только хеш токена.
    // Язык письма — тот, на котором человек заказывал выгрузку (§17).
    // eslint-disable-next-line no-await-in-loop
    const to = await auth.addressOf(job.user_id);
    if (to) {
      const link = `${baseUrl}/${job.locale}/settings/data/export`
        + `?token=${encodeURIComponent(token)}`;
      // eslint-disable-next-line no-await-in-loop
      await mailQueue?.enqueue({ kind: 'data_export_ready', to, locale: job.locale, link });
    }
    ready += 1;
  }

  return { ready, failed };
}