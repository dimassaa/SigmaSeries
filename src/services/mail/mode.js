// Режим почтового шлюза (F-01-12 §4, §8(в)).
//
// Два источника, и порядок их силы неочевиден: окружение задаёт режим при
// старте, а запись в базе — решение администратора, сделанное позже. Запись
// сильнее окружения, иначе перезапуск молча вернул бы `smtp` поверх
// намеренно включённого `devbox` — и письма ушли бы вместо того, чтобы ждать.
//
// Автоматического перехода на `devbox` нет (H-51): иначе токены подтверждения
// покидали бы базу незаметно, а человек решил бы, что письмо ушло.

import { MAIL_SETTINGS } from '../../config/settings.js';

/** Допустимые режимы (CHECK в схеме `e_system_setting` — по ключу, не по enum). */
const MODES = /** @type {const} */ (['smtp', 'devbox']);

/**
 * @param {string} value
 * @returns {value is 'smtp'|'devbox'}
 */
function isMode(value) {
  return MODES.includes(/** @type {'smtp'|'devbox'} */ (value));
}

/**
 * Действующий режим: запись админа, иначе окружение, иначе `smtp`.
 *
 * @param {{query: Function}} pool
 * @param {string} [fallback] режим из окружения (MAIL_MODE)
 * @returns {Promise<'smtp'|'devbox'>}
 */
export async function effectiveMode(pool, fallback = process.env.MAIL_MODE ?? 'smtp') {
  const { rows } = await pool.query(
    `SELECT value FROM e_system_setting WHERE key = $1`,
    ['mail.mode'],
  );
  const value = rows[0]?.value ?? fallback;
  // Мусор в базе или в окружении не должен ломать запуск: неизвестное значение
  // трактуется как отсутствие настройки.
  return isMode(value) ? value : (isMode(fallback) ? fallback : 'smtp');
}

/**
 * Переключение режима администратором (R-SEC-12, F-01-12 §8(в)).
 *
 * Повторный пароль обязателен: режим решает, уходят ли письма наружу, и
 * переключение без пароля отозвало бы у человека возможность получить
 * подтверждение.
 *
 * @param {object} deps
 * @param {() => Promise<string>} deps.current действующий режим
 * @param {(value:string, by:number) => Promise<any>} deps.change запись в базу
 * @param {() => Promise<boolean>} deps.verify проверка текущего пароля
 * @param {string} [deps.next] режим, в который переключаем
 * @returns {Promise<{ok:boolean, reason?:string, previous?:string, next?:string}>}
 */
export async function switchMode({ current, change, verify, next = 'devbox' }) {
  if (!(await verify())) return { ok: false, reason: 'password' };

  const previous = await current();
  // Повторное включение того же режима ничего не меняет: сказать об этом
  // честнее, чем молча переписать то же значение и записать в журнал.
  if (previous === next) return { ok: false, reason: 'same', previous };

  const verdict = await change(next, null);
  return { ok: true, previous, next, ...verdict };
}

/**
 * Настоящий шлюз SMTP.
 *
 * Параметры берутся только из окружения (F-01-12 §4): в базе пароля провайдера
 * лежать не должен, а `e_system_setting` открыта администратору.
 *
 * Транспорт создаётся лениво и один раз: подключение при старте упало бы там,
 * где никто не ждёт отправки.
 *
 * @returns {Promise<{send: Function, configured: boolean}>}
 */
export async function smtpMailer(env = process.env) {
  const host = env.SMTP_HOST;
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  const from = env.MAIL_FROM ?? 'no-reply@sigmaseries.local';

  // Импорт отложен: без SMTP-параметров пакет не нужен, и незачем грузить его
  // при каждом запуске в режиме `devbox`.
  const { default: nodemailer } = await import('nodemailer');

  const transport = nodemailer.createTransport({
    host,
    port: Number(env.SMTP_PORT ?? 587),
    secure: String(env.SMTP_SECURE ?? '') === 'true',
    auth: user ? { user, pass } : undefined,
  });

  return {
    configured: Boolean(host),
    async send(job) {
      await transport.sendMail({ from, to: job.to, subject: job.subject, text: job.body });
    },
  };
}