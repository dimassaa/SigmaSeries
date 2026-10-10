// Настройки модулей.
//
// Числа берутся из таблиц настроек в спецификациях и живут здесь, а не
// разбросаны по коду константами. Правило простое: значение, которое
// встречается в двух местах, обязано ссылаться на строку таблицы, иначе
// правка спецификации разъедется с кодом без следа.
//
// Источники:
//   M1 §0 — auth.*   (docs/01-product/features/M1-identity.md)
//   M5 §0 — mod.*    (docs/01-product/features/M5-ugc-moderation.md)
//   R-SEC-03, R-SEC-05

export const MINUTE = 60;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** M1 §0, таблица настроек модуля. */
export const AUTH = {
  /** Минимальная длина пароля. */
  passwordMin: 10,
  /** Верхняя граница: длиннее — не хешируем, иначе тяжёлый вход (F-01-03 §9). */
  passwordMax: 128,

  /** R-SEC-03: зритель — простой 7 дней, абсолютный 30. */
  viewerIdleMs: 7 * DAY,
  viewerAbsoluteMs: 30 * DAY,
  /** R-SEC-03: служебные роли — простой 30 минут, абсолютный 12 часов. */
  staffIdleMs: 30 * MINUTE,
  staffAbsoluteMs: 12 * HOUR,

  /** auth.sessions_max — сколько сессий держим на аккаунт. */
  sessionsMax: 10,

  /** R-SEC-05: перебор по аккаунту — 5 неудач за 15 минут. */
  attemptsPerAccount: 5,
  attemptsWindowMs: 15 * MINUTE,
  /** Нарастающая задержка 1, 2, 4, 8 … с, потолок 5 минут. */
  delayStepMs: 1000,
  delayMaxMs: 5 * MINUTE,

  /** R-SEC-05: по IP — 30 попыток за 15 минут. */
  attemptsPerIp: 30,

  /** R-SEC-34: после трёх неудач включается невидимая проверка. */
  powAfterFailures: 3,
  /** Сколько нулей должен содержать хеш решения. */
  powZeros: 3,

  /** R-SEC-31: cookie входа. */
  cookieName: 'sid',
};

/** Роли, для которых сессия короче (R-SEC-03). */
export const STAFF_ROLES = ['editor', 'analyst', 'admin'];