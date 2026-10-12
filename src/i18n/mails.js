// Тексты служебных писем.
//
// Отдельный файл, а не строки в `strings.js`: письмо — не элемент интерфейса,
// у него другой адресат и другой срок жизни. Смешивать их в одном каталоге
// значило бы развести по сюжету, как это сделано здесь: интерфейс на F-00-02,
// письма на F-01-12.
//
// Текст собирается при постановке в очередь, а не при отправке: письмо может
// ждать в очереди сутки, и правка формулировки не должна менять то, что
// человеку уже обещали.

import { LOCALES } from './strings.js';

/** Виды служебных писем (F-01-12 §7). */
export const MAIL_KINDS = [
  'email_verify',
  'email_taken',
  'password_reset',
  'password_changed',
  'email_change',
  'email_change_requested',
  'email_changed',
  'two_factor_enabled',
];

/**
 * @typedef {object} MailText
 * @property {string} subject тема письма
 * @property {string} body тело письма простым текстом
 */

/**
 * Текст письма по виду и языку.
 *
 * @param {string} kind вид письма из `MAIL_KINDS`
 * @param {string} locale язык получателя (`R-I18N-13`)
 * @param {{link?:string}} vars подставляемые значения; ссылка обязательна
 *   только там, где письмо ведёт в интерфейс
 * @returns {MailText}
 * @throws неизвестный вид или язык: молча отправленное письмо без темы
 *   хуже явной ошибки, потому что её никто не заметит
 */
export function mailText(kind, locale, vars = {}) {
  const table = TEXTS[kind];
  if (!table) throw new Error(`Неизвестный вид письма: ${kind}`);

  const strings = table[locale];
  if (!strings) {
    throw new Error(`Неизвестный язык письма: ${locale} (допустимы ${LOCALES.join(', ')})`);
  }

  const link = vars.link ?? '';
  if (strings.needsLink && !link) {
    throw new Error(`Письмо ${kind} требует ссылку: без неё человеку нечего нажать`);
  }

  return {
    subject: fill(strings.subject, { link }),
    body: fill(strings.body, { link }),
  };
}

/** Подстановка `{link}` и перевод строк. */
function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (whole, name) => vars[name] ?? '')
    .replace(/\\n/g, '\n');
}

/**
 * Тексты по видам и языкам.
 *
 * Письма простым текстом: разметка в письме ломается у клиентов и требует
 * своего санитайзера, а выигрыша в письме, которое читают один раз, нет.
 * Пикселей слежения здесь нет и не будет (F-01-12 §8(а)).
 */
const TEXTS = {
  email_verify: {
    ru: {
      needsLink: true,
      subject: 'Подтвердите адрес',
      body: 'Здравствуйте!\n\nПодтвердите адрес аккаунта — без этого вход будет недоступен.\n\nСсылка одноразовая и живёт 30 минут:\n{link}\n\nЕсли вы не заводили аккаунт, письмо можно удалить.',
    },
    en: {
      needsLink: true,
      subject: 'Confirm your address',
      body: 'Hello!\n\nConfirm your account address — without it signing in stays unavailable.\n\nThe link is single-use and lives for 30 minutes:\n{link}\n\nIf you did not sign up, you can delete this message.',
    },
  },

  // Письмо уходит владельцу занятого адреса, а страница отвечает так же,
  // как и для свободного (R-SEC-06): по письму узнать, что аккаунт есть,
  // может только сам владелец.
  email_taken: {
    ru: {
      needsLink: false,
      subject: 'Адрес уже занят',
      body: 'Здравствуйте!\n\nЭтот адрес уже занят аккаунтом. Если аккаунт ваш, восстановите пароль по ссылке на сайте.',
    },
    en: {
      needsLink: false,
      subject: 'The address is already taken',
      body: 'Hello!\n\nThis address is already used by an account. If it is yours, recover the password from the site.',
    },
  },

  password_reset: {
    ru: {
      needsLink: true,
      subject: 'Восстановление пароля',
      body: 'Здравствуйте!\n\nПо вашей заявке меняется пароль. Ссылка одноразовая и живёт 30 минут:\n{link}\n\nЕсли вы не просили сменить пароль, письмо можно удалить: без вашего действия ничего не изменится.',
    },
    en: {
      needsLink: true,
      subject: 'Password recovery',
      body: 'Hello!\n\nThe password is being changed as you requested. The link is single-use and lives for 30 minutes:\n{link}\n\nIf you did not request a password change, you can delete this message: nothing changes without your action.',
    },
  },

  // Уведомление о чужой смене пароля: именно для этого оно и нужно, поэтому
  // в нём нет ни ссылки, ни приглашения войти.
  password_changed: {
    ru: {
      needsLink: false,
      subject: 'Пароль изменён',
      body: 'Здравствуйте!\n\nПароль вашего аккаунта изменён, все сессии завершены.\n\nЕсли это были не вы, восстановите пароль на сайте и смените его на новый.',
    },
    en: {
      needsLink: false,
      subject: 'The password has been changed',
      body: 'Hello!\n\nYour account password has been changed and all sessions have been ended.\n\nIf this was not you, recover the password from the site and choose a new one.',
    },
  },

  // Ссылка для подтверждения нового адреса. Пока она не открыта, вход идёт
  // по старому адресу.
  email_change: {
    ru: {
      needsLink: true,
      subject: 'Подтвердите новый адрес',
      body: 'Здравствуйте!\n\nЗаказан переход аккаунта на этот адрес. Подтвердите его — и вход будет по новому адресу, а по прежнему перестанет.\n\nСсылка одноразовая и живёт 30 минут:\n{link}\n\nЕсли вы этого не заказывали, просто проигнорируйте письмо: ничего не изменится.',
    },
    en: {
      needsLink: true,
      subject: 'Confirm the new address',
      body: 'Hello!\n\nYour account is being moved to this address. Confirm it — sign-in will use the new address, and the old one will stop working.\n\nThe link is single-use and lives for 30 minutes:\n{link}\n\nIf you did not request this, just ignore the message: nothing will change.',
    },
  },

  // Уведомление на прежний адрес: потеря входа сама по себе выглядит как
  // взлом, и человек должен узнать о смене из письма, а не по факту.
  email_change_requested: {
    ru: {
      needsLink: false,
      subject: 'Заказан смена адреса',
      body: 'Здравствуйте!\n\nДля вашего аккаунта заказали переход на другой адрес. Подтверждение придёт на новый адрес; пока оно не получено, вход работает как прежде.\n\nЕсли это не вы, ничего делать не нужно.',
    },
    en: {
      needsLink: false,
      subject: 'An address change was requested',
      body: 'Hello!\n\nAn address change was requested for your account. The confirmation goes to the new address; until it is confirmed, sign-in works as before.\n\nIf this was not you, there is nothing to do.',
    },
  },

  // Уведомление после применения смены: прежний адрес уже не работает.
  email_changed: {
    ru: {
      needsLink: false,
      subject: 'Адрес аккаунта изменён',
      body: 'Здравствуйте!\n\nВаш аккаунт переведён на новый адрес. Войти по этому адресу больше нельзя — используйте новый.\n\nЕсли это были не вы, восстановите доступ по ссылке восстановления пароля и смените пароль.',
    },
    en: {
      needsLink: false,
      subject: 'The account address has been changed',
      body: 'Hello!\n\nYour account has been moved to a new address. You can no longer sign in with this one — use the new address.\n\nIf this was not you, recover access with the password recovery link and change your password.',
    },
  },

  // Адрес уже занят (EC-A15). Письмо уходит владельцу занятого адреса, и
  // поэтому не содержит ничего о чужой заявке.
  email_taken: {
    ru: {
      needsLink: false,
      subject: 'Попытка занять ваш адрес',
      body: 'Здравствуйте!\n\nКто-то попытался перевести аккаунт на этот адрес. Ничего не изменилось: адрес остаётся за вами.\n\nЕсли это были не вы, смените пароль — настройки безопасности в разделе «Безопасность».',
    },
    en: {
      needsLink: false,
      subject: 'An attempt to use your address',
      body: 'Hello!\n\nSomebody tried to move an account to this address. Nothing changed: the address stays yours.\n\nIf this was not you, change your password — see the Security section of settings.',
    },
  },

  // Включение 2FA (F-01-05 §17).
  two_factor_enabled: {
    ru: {
      needsLink: false,
      subject: 'Двухфакторная проверка включена',
      body: 'Здравствуйте!\n\nДля аккаунта включена двухфакторная проверка: при входе понадобится код из приложения или резервный код.\n\nЕсли это были не вы, отключите проверку в настройках безопасности — для этого нужен текущий пароль.',
    },
    en: {
      needsLink: false,
      subject: 'Two-factor verification is on',
      body: 'Hello!\n\nTwo-factor verification is now on for the account: signing in will need a code from an app or a backup code.\n\nIf this was not you, turn it off in security settings — that needs your current password.',
    },
  },
};