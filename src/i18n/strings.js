// Каталог сообщений интерфейса (R-I18N-01, R-I18N-02).
//
// Требования, которые здесь действуют:
//  · строк в коде и разметке нет — только ключи;
//  · для каждого ключа есть ru и en, резерва нет;
//  · сообщения не склеиваются из кусков;
//  · ключ на��ивается как `экран.компонент.элемент`.
//
// Отсутствие ключа бросает исключение, а не печатает «[ключ]»: на странице
// это выглядело бы как недоделка, а при сборке — как ошибка в CI, где её и
// надо ловить.

const MESSAGES = {
  ru: {
    'app.title': 'SigmaSeries',
    'app.skipToContent': 'Перейти к содержимому',
    'app.theme.toggle': 'Сменить тему',
    'app.locale.current': 'Русский',
    'app.locale.other': 'English',
    'app.locale.switchTo': 'Перейти на {language}',
    'nav.catalog': 'Каталог',
    'nav.calendar': 'Календарь',
    'nav.search': 'Поиск',
    'nav.signIn': 'Войти',

    'home.title': 'Сериалы: что выходит и что смотреть',
    'home.banners.heading': 'Баннеры',
    'home.banners.reason.new': 'Новинка',
    'home.banners.reason.classic': 'Классика',
    'home.banners.reason.editorial': 'Выбор редакции',
    'home.banners.rating': 'IMDb {rating}',
    'home.banners.empty': 'Каталог пока пуст: баннеры появятся после первой загрузки.',

    'home.fresh.heading': 'Новинки',
    'home.fresh.empty': 'Пока пусто: недавно вышедших сериалов нет.',
    'home.fresh.itemLabel': '{title}, {year}',

    'home.collections.heading': 'Подборки',
    'home.collections.empty': 'Подборок пока нет.',
    'home.collections.itemLabel': 'Подборка «{title}», {count} сериалов',
    'home.collections.more': 'Ещё подборки',

    'home.genres.heading': 'Жанры',
    'home.genres.empty': 'Жанров пока нет.',
    'home.genres.itemLabel': 'Жанр {title}',

    'error.notFound.title': 'Страница не найдена',
    'error.notFound.text': 'Такого адреса нет. Проверьте ссылку или вернитесь на главную.',
    'error.notFound.home': 'На главную',
    'error.generic.title': 'Что-то пошло не так',
    'error.generic.text': 'Страница не загрузилась. Попробуйте обновить её или вернитесь позже.',
    'error.generic.retry': 'Обновить',

    'signin.title': 'Вход',
    'signin.heading': 'Вход в аккаунт',
    'signin.email': 'Email',
    'signin.email.type': 'text',
    'signin.email.autocomplete': 'email',
    'signin.password': 'Пароль',
    'signin.password.autocomplete': 'current-password',
    'signin.submit': 'Войти',
    'signin.submit.pending': 'Проверяем…',
    'signin.forgot': 'Забыли пароль?',
    'signin.error.staffNoFactor': 'Второй фактор для служебной роли ещё не подключён, поэтому вход для этой роли временно закрыт.',
    'signin.noAccount': 'Нет аккаунта',
    'signin.register': 'Зарегистрироваться',
    'signin.error.required': 'Заполните это поле',
    'signin.error.email': 'Проверьте адрес: похоже на опечатку',
    'signin.error.credentials': 'Неверный email или пароль',
    'signin.error.tooMany': 'Слишком много попыток. Попробуйте через {seconds} с',
    'signin.error.csrf': 'Форма устарела. Обновите страницу.',
    'signin.error.blocked': 'Аккаунт заблокирован. {reason}',
    'signin.error.deletePending': 'Вы запросили удаление аккаунта.',
    'signin.error.deleteCancel': 'Отменить удаление',
    'signin.error.tooLong': 'Пароль слишком длинный',
    'signin.state.confirmEmail': 'Подтвердите email, чтобы продолжить',
    'signin.pow': 'Проверка…',
    'signout.submit': 'Выйти',

    'register.title': 'Регистрация',
    'register.heading': 'Регистрация',
    'register.progress': 'Шаги регистрации',
    'register.stepLabel': 'Шаг {n}',
    'register.stepOf': 'Шаг {n} из {total}',
    'register.email': 'Email',
    'register.nickname': 'Ник',
    'register.nickname.hint': '3–24 символа: латиница, кириллица, цифры, «_» и «-»',
    'register.password': 'Пароль',
    'register.password.hint': 'Не короче {min} символов',
    'register.consent': 'Я принимаю правила и политику обработки данных',
    'register.submit': 'Создать аккаунт',
    'register.haveAccount': 'Уже есть аккаунт',
    'register.signIn': 'Войти',
    'register.step2.title': 'Проверьте почту',
    'register.step2.lead': 'Мы отправили письмо на {email}. Откройте ссылку в нём, чтобы продолжить.',
    'register.step2.sent': 'Письмо отправлено повторно',
    'register.step2.spam': 'Письма попадают в спам — проверьте эту папку, если ссылки нет через пару минут.',
    'register.step2.resend': 'Отправить ещё раз',
    'register.step2.change': 'Изменить email',
    'register.step3.title': 'Выберите любимые',
    'register.step3.skip': 'Пропустить',

    'register.error.csrf': 'Форма устарела. Обновите страницу.',
    'register.error.tooMany': 'Слишком много регистраций с этого адреса. Попробуйте через час.',
    'register.error.consent': 'Без согласия с правилами аккаунт создать нельзя',
    'register.error.consent_required': 'Отметьте согласие с правилами и политикой',
    'register.error.fields': 'Проверьте отмеченные поля',
    'register.error.cooldown': 'Письмо уже отправлялось. Повторите через {seconds} с',
    'register.error.nick_ask': 'Проверяем ник…',
    'register.error.nick_free': 'Ник свободен',
    'register.error.nick_lookup': 'Не удалось проверить ник. Попробуйте ещё раз.',

    'register.error.email_required': 'Укажите email',
    'register.error.email_invalid': 'Проверьте адрес: похоже на опечатку',
    'register.error.email_too_long': 'Адрес слишком длинный',
    'register.error.nick_required': 'Придумайте ник',
    'register.error.nick_too_short': 'Ник короче 3 символов',
    'register.error.nick_too_long': 'Ник длиннее 24 символов',
    'register.error.nick_charset': 'Допустимы только латиница, кириллица, цифры, «_» и «-»',
    'register.error.nick_edges': 'Ник не начинается и не кончается на «_» или «-»',
    'register.error.nick_reserved': 'Этот ник зарезервирован',
    'register.error.nick_blocked': 'Этот ник не проходит проверку. Выберите другой',
    'register.error.nick_taken': 'Ник уже занят',
    'register.error.nick_is_email': 'Ник не должен совпадать с адресом',
    'register.error.nick_is_password': 'Ник не должен совпадать с паролем',
    'register.error.password_too_short': 'Пароль короче {min} символов',
    'register.error.password_too_long': 'Пароль длиннее {max} символов',
    'register.error.password_common': 'Это один из самых распространённых паролей',
    'register.error.password_one_char': 'Пароль из одного повторяющегося символа',
    'register.error.password_triple_char': 'Символ не повторяется трижды подряд',
    'register.error.timezone_invalid': 'Не удалось определить часовой пояс',

    'verify.title': 'Подтверждение email',
    'verify.text': 'Подтвердите адрес, чтобы открыть права зрителя.',
    'verify.submit': 'Подтвердить email',
    'verify.stale.title': 'Ссылка устарела',
    'verify.stale.text': 'Ссылка больше не работает: она одноразовая и живёт 30 минут.',
    'verify.stale.back': 'Зарегистрироваться заново',
    'verify.already.title': 'Email уже подтверждён',
    'verify.already.text': 'Этот адрес уже подтверждён. Можно войти.',
    'verify.already.login': 'Войти',

    'common.back': 'Назад',
    'common.more': 'Ещё',
    'common.loading': 'Загрузка',
  },
  en: {
    'app.title': 'SigmaSeries',
    'app.skipToContent': 'Skip to content',
    'app.theme.toggle': 'Toggle theme',
    'app.locale.current': 'English',
    'app.locale.other': 'Русский',
    'app.locale.switchTo': 'Switch to {language}',
    'nav.catalog': 'Catalogue',
    'nav.calendar': 'Calendar',
    'nav.search': 'Search',
    'nav.signIn': 'Sign in',

    'home.title': 'TV series: what airs and what to watch',
    'home.banners.heading': 'Featured',
    'home.banners.reason.new': 'New release',
    'home.banners.reason.classic': 'Classic',
    'home.banners.reason.editorial': 'Editor’s pick',
    'home.banners.rating': 'IMDb {rating}',
    'home.banners.empty': 'The catalogue is empty: banners appear after the first import.',

    'home.fresh.heading': 'Fresh releases',
    'home.fresh.empty': 'Nothing here yet: no series aired recently.',
    'home.fresh.itemLabel': '{title}, {year}',

    'home.collections.heading': 'Collections',
    'home.collections.empty': 'No collections yet.',
    'home.collections.itemLabel': 'Collection “{title}”, {count} series',
    'home.collections.more': 'More collections',

    'home.genres.heading': 'Genres',
    'home.genres.empty': 'No genres yet.',
    'home.genres.itemLabel': 'Genre {title}',

    'error.notFound.title': 'Page not found',
    'error.notFound.text': 'There is no such address. Check the link or go back home.',
    'error.notFound.home': 'Go home',
    'error.generic.title': 'Something went wrong',
    'error.generic.text': 'The page could not be loaded. Try refreshing it, or come back later.',
    'error.generic.retry': 'Refresh',

    'signin.title': 'Sign in',
    'signin.heading': 'Sign in to your account',
    'signin.email': 'Email',
    'signin.email.type': 'text',
    'signin.email.autocomplete': 'email',
    'signin.password': 'Password',
    'signin.password.autocomplete': 'current-password',
    'signin.submit': 'Sign in',
    'signin.submit.pending': 'Checking…',
    'signin.forgot': 'Forgot password?',
    'signin.error.staffNoFactor': 'The second factor for a staff role is not set up yet, so sign-in for that role is temporarily closed.',
    'signin.noAccount': 'No account yet',
    'signin.register': 'Sign up',
    'signin.error.required': 'This field is required',
    'signin.error.email': 'Check the address: it looks like a typo',
    'signin.error.credentials': 'Wrong email or password',
    'signin.error.tooMany': 'Too many attempts. Try again in {seconds} s',
    'signin.error.csrf': 'The form has expired. Reload the page.',
    'signin.error.blocked': 'Account is blocked. {reason}',
    'signin.error.deletePending': 'You requested account deletion.',
    'signin.error.deleteCancel': 'Cancel the deletion',
    'signin.error.tooLong': 'Password is too long',
    'signin.state.confirmEmail': 'Confirm your email to continue',
    'signin.pow': 'Checking…',
    'signout.submit': 'Sign out',

    'register.title': 'Sign up',
    'register.heading': 'Sign up',
    'register.progress': 'Sign-up steps',
    'register.stepLabel': 'Step {n}',
    'register.stepOf': 'Step {n} of {total}',
    'register.email': 'Email',
    'register.nickname': 'Nickname',
    'register.nickname.hint': '3–24 characters: Latin, Cyrillic, digits, “_” and “-”',
    'register.password': 'Password',
    'register.password.hint': 'At least {min} characters',
    'register.consent': 'I accept the rules and the data processing policy',
    'register.submit': 'Create account',
    'register.haveAccount': 'Already have an account',
    'register.signIn': 'Sign in',
    'register.step2.title': 'Check your inbox',
    'register.step2.lead': 'We sent a message to {email}. Open the link in it to continue.',
    'register.step2.sent': 'The message has been sent again',
    'register.step2.spam': 'Messages end up in spam — check that folder if the link does not arrive within a couple of minutes.',
    'register.step2.resend': 'Send again',
    'register.step2.change': 'Change the email',
    'register.step3.title': 'Pick your favourites',
    'register.step3.skip': 'Skip',

    'register.error.csrf': 'The form has expired. Reload the page.',
    'register.error.tooMany': 'Too many sign-ups from this address. Try again in an hour.',
    'register.error.consent': 'The account cannot be created without accepting the rules',
    'register.error.consent_required': 'Tick the box to accept the rules and the policy',
    'register.error.fields': 'Check the marked fields',
    'register.error.cooldown': 'The message was already sent. Repeat in {seconds} s',
    'register.error.nick_ask': 'Checking the nickname…',
    'register.error.nick_free': 'The nickname is free',
    'register.error.nick_lookup': 'Could not check the nickname. Try again.',

    'register.error.email_required': 'Enter your email',
    'register.error.email_invalid': 'Check the address: it looks like a typo',
    'register.error.email_too_long': 'The address is too long',
    'register.error.nick_required': 'Pick a nickname',
    'register.error.nick_too_short': 'The nickname is shorter than 3 characters',
    'register.error.nick_too_long': 'The nickname is longer than 24 characters',
    'register.error.nick_charset': 'Only Latin, Cyrillic, digits, “_” and “-” are allowed',
    'register.error.nick_edges': 'A nickname cannot start or end with “_” or “-”',
    'register.error.nick_reserved': 'This nickname is reserved',
    'register.error.nick_blocked': 'This nickname does not pass moderation. Pick another',
    'register.error.nick_taken': 'The nickname is already taken',
    'register.error.nick_is_email': 'A nickname cannot match the email address',
    'register.error.nick_is_password': 'A nickname cannot match the password',
    'register.error.password_too_short': 'The password is shorter than {min} characters',
    'register.error.password_too_long': 'The password is longer than {max} characters',
    'register.error.password_common': 'This is one of the most common passwords',
    'register.error.password_one_char': 'A password of a single repeated character',
    'register.error.password_triple_char': 'No character repeats three times in a row',
    'register.error.timezone_invalid': 'Could not determine the time zone',

    'verify.title': 'Email confirmation',
    'verify.text': 'Confirm the address to unlock viewer rights.',
    'verify.submit': 'Confirm email',
    'verify.stale.title': 'The link has expired',
    'verify.stale.text': 'This link no longer works: it is single-use and lives for 30 minutes.',
    'verify.stale.back': 'Sign up again',
    'verify.already.title': 'Email already confirmed',
    'verify.already.text': 'This address is already confirmed. You can sign in.',
    'verify.already.login': 'Sign in',

    'common.back': 'Back',
    'common.more': 'More',
    'common.loading': 'Loading',
  },
};

/** Языки, для которых обязаны существовать все ключи. */
export const LOCALES = ['ru', 'en'];

/** Язык по умолчанию. Всегда русский, независимо от заголовков запроса (ADR-003). */
export const DEFAULT_LOCALE = 'ru';

export function isLocale(value) {
  return LOCALES.includes(value);
}

/**
 * Перевод по ключу.
 *
 * @param {string} locale ru | en
 * @param {string} key экран.компонент.элемент
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 * @throws если ключа нет — это ошибка сборки, а не пустое место на странице
 */
export function t(locale, key, params = {}) {
  const dict = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];
  const msg = dict[key];
  if (msg == null) {
    throw new Error(`Нет ключа «${key}» для языка «${locale}»`);
  }
  return msg.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

/** Проверка полноты каталога: у каждого ключа есть все языки. */
export function missingKeys() {
  const base = Object.keys(MESSAGES[DEFAULT_LOCALE]);
  const bad = [];
  for (const locale of LOCALES) {
    for (const key of base) {
      if (MESSAGES[locale][key] == null) bad.push(`${locale}:${key}`);
    }
  }
  return bad;
}