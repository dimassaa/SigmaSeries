// Режим защиты: заморозка данных перед показом без сети (F-12-10).
//
// Режим защиты — это обещание «на защите всё откроется», и держится оно на
// одном: во время него не уходит ни одного запроса наружу. Всё остальное —
// бейдж и кнопка, а они не построены, потому что администратора в системе нет
// (#64). Поэтому здесь только механика и её проверки.
//
// Порядок шагов важен и взят из §3: сначала копия с проверкой восстановления,
// и только потом выключение импорта. Обратный порядок дал бы «замороженный»
// каталог без страховки: разморозить можно, но если что-то не так с данными,
// отката уже нет.

const ON = 'on';
const OFF = 'off';
const KEY_IMPORT = 'import.enabled';
const KEY_FROZEN = 'defence.frozen_at';
const KEY_MAIL = 'defence.mail_devbox';
const KEY_PREV_MAIL = 'defence.prev_mail_mode';

/** После скольких часов прогон в `running` считается упавшим, а не идущим. */
export const STALE_RUN_HOURS = 6;

/**
 * Служба режима защиты.
 *
 * @param {object} deps
 * @param {object} deps.pool
 * @param {{current:Function, set:Function}|null} [deps.mailMode] переключатель режима почты
 * @param {() => Promise<object>} [deps.backup] создание проверенной копии (OP-17)
 * @returns {object}
 */
export function createFreezeService({ pool, mailMode = null, backup = null }) {
  async function readSetting(key) {
    const { rows } = await pool.query('SELECT value FROM e_system_setting WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  }

  async function writeSetting(key, value) {
    await pool.query(
      `INSERT INTO e_system_setting (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, changed_at = now()`,
      [key, value],
    );
  }

  return {
    /**
     * Текущее состояние режима.
     *
     * @returns {Promise<{frozen:boolean, since:string|null, mailDevbox:boolean|null}>}
     */
    async state() {
      const frozenAt = await readSetting(KEY_FROZEN);
      const mail = await readSetting(KEY_MAIL);
      return {
        frozen: Boolean(frozenAt),
        since: frozenAt ? frozenAt.slice(0, 10) : null,
        // null означает «админ не просил менять почту» — это не то же самое,
        // что «почта в devbox».
        mailDevbox: mail === null ? null : mail === ON,
      };
    },

    /**
     * Идёт ли сейчас импорт: заморозка посреди прогона бросила бы его на полпути.
     *
     * Считаются только свежие прогоны. Упавший процесс оставляет строку
     * `running` навсегда, и без этого срока такой мусор навсегда блокировал бы
     * заморозку — а разморозить было бы нечем, потому что заморозки не было.
     * Полный прогон занимает около 20 минут (F-12-07), так что шесть часов —
     * запас в восемнадцать раз.
     */
    async runningImports() {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM e_import_run
          WHERE status = 'running' AND started_at > now() - ($1 || ' hours')::interval`,
        [String(STALE_RUN_HOURS)],
      );
      return rows[0].n;
    },

    /**
     * Замораживает каталог для защиты (§3).
     *
     * @param {{at?: Date, mailDevbox?: boolean, requireBackup?: boolean}} [options]
     * @returns {Promise<{frozen:boolean, since:string, backup:object|null}>}
     * @throws {Error} идёт запуск, копия не создалась или не проверена
     */
    async freeze({ at = new Date(), mailDevbox = false, requireBackup = true } = {}) {
      const running = await this.runningImports();
      if (running > 0) {
        throw new Error(`нельзя замораживать: идёт прогон импорта (${running})`);
      }

      // Сначала копия. Если она не создалась или не восстановилась —
      // заморозки не будет вовсе: «заморожено» без страховки врёт админу.
      let backupResult = null;
      if (requireBackup && backup) {
        backupResult = await backup();
        if (backupResult?.status !== 'verified') {
          throw new Error(
            `копия не прошла проверку восстановления (${backupResult?.status ?? 'нет результата'}`
            + `${backupResult?.error ? `: ${backupResult.error}` : ''}) — заморозка отменена`,
          );
        }
      }

      const stamp = new Date(at).toISOString();
      await writeSetting(KEY_FROZEN, stamp);
      await writeSetting(KEY_IMPORT, OFF);
      await writeSetting(KEY_MAIL, mailDevbox ? ON : OFF);

      if (mailDevbox && mailMode) {
        // Прежний режим запоминается: разморозка обязана вернуть ровно то,
        // что было, а не угадывать по переменной окружения, которую к тому
        // времени могли поменять.
        await writeSetting(KEY_PREV_MAIL, await mailMode.current());
        // Запись админа сильнее окружения (DEC-035): в режиме защиты письма
        // регистрации просто не уйдут, и это должно быть видно в режиме.
        await mailMode.set('devbox');
      }

      return { frozen: true, since: stamp.slice(0, 10), backup: backupResult, mailDevbox };
    },

    /**
     * Возвращает всё как было (EC-I13).
     *
     * @returns {Promise<{frozen:false}>}
     */
    async unfreeze() {
      const previous = await readSetting(KEY_PREV_MAIL);
      if (mailMode && previous) {
        // Возвращается именно то, что было до заморозки.
        await mailMode.set(previous);
      }
      await writeSetting(KEY_IMPORT, ON);
      await pool.query("DELETE FROM e_system_setting WHERE key = ANY($1::text[])", [
        [KEY_FROZEN, KEY_MAIL, KEY_PREV_MAIL],
      ]);
      return { frozen: false };
    },
  };
}

/**
 * Не заморожен ли режим — короткая проверка для запусков импорта.
 *
 * Вынесена отдельно, потому что её зовут в пяти местах, и разбор настроек
 * внутри каждого повторился бы пять раз.
 *
 * @param {object} pool
 * @returns {Promise<boolean>}
 */
export async function isUnfrozen(pool) {
  const { rows } = await pool.query(
    "SELECT value FROM e_system_setting WHERE key = 'defence.frozen_at'",
  );
  return !rows[0]?.value;
}

/**
 * Останавливает запуск, если включён режим защиты (F-12-10 §4).
 *
 * В режиме защиты запросов к внешним API быть не должно вовсе, и полагаться
 * на «никто не запустит импорт» нельзя: кнопка в S-76 появится позже, а
 * человек может запустить шаг руками. Проверка стоит первым делом в каждом
 * шаге, потому что дешевле всего объяснить это до скачивания файла на 218 МБ.
 *
 * @param {object} pool
 * @returns {Promise<void>}
 * @throws {Error}
 */
export async function assertNotFrozen(pool) {
  const { rows } = await pool.query(
    "SELECT value FROM e_system_setting WHERE key = 'defence.frozen_at'",
  );
  if (!rows[0]?.value) return;
  const since = String(rows[0].value).slice(0, 10);
  throw new Error(
    `включён режим защиты (с ${since}): запросы к внешним API запрещены.`
    + ' Снять: npm run import:freeze -- --unfreeze',
  );
}
